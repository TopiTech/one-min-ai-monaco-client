import { buildXmlRepairPrompt } from './utils.js';

// Cache for workspace file lists to avoid redundant API calls during agent loops.
// Capped at 20 entries to prevent unbounded memory growth when switching workspaces.
const _fileListCache = new Map();
const FILE_LIST_CACHE_TTL_MS = 30_000;
const FILE_LIST_CACHE_MAX = 20;

function buildAgentPromptInstructions() {
  return [
    'IMPORTANT: Your response MUST be output in valid XML format ONLY.',
    'The allowed top-level tags are ONLY <thought>, <call_tool>, and <finish>.',
    'Do NOT output any explanatory text, Markdown, bullet points, or code fences outside tags.',
    'XML special characters (&, <, >) MUST be properly XML-escaped (&amp;, &lt;, &gt;).',
    'When invoking a tool, properly close <call_tool name="..."> and <parameter name="..."> tags.',
    'If unsure, use <finish> to concisely return completion.',
  ].join('\n');
}

async function fetchWorkspaceFiles(apiFn, workspaceRoot) {
  const cached = _fileListCache.get(workspaceRoot);
  if (cached && Date.now() - cached.timestamp < FILE_LIST_CACHE_TTL_MS) {
    return cached.text;
  }
  const listRes = await apiFn(`/api/fs/list?dir=${encodeURIComponent(workspaceRoot)}`);
  const filesList = listRes.items
    .map((item) => `- ${item.isDirectory ? '[Dir] ' : '[File] '}${item.name}`)
    .join('\n');
  const text = `Workspace path: ${workspaceRoot}\n` + filesList;
  _fileListCache.set(workspaceRoot, { text, timestamp: Date.now() });
  // Evict oldest entry when cache exceeds limit
  if (_fileListCache.size > FILE_LIST_CACHE_MAX) {
    const oldestKey = _fileListCache.keys().next().value;
    _fileListCache.delete(oldestKey);
  }
  return text;
}

function resolvePathRelativeToWorkspace(workspaceRoot, filePath) {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('/') || filePath.startsWith('\\')) {
    return filePath;
  }
  const separator = workspaceRoot.includes('\\') ? '\\' : '/';
  const rootTrimmed = workspaceRoot.replace(/[\\/]+$/, '');
  const fileTrimmed = filePath.replace(/^[\\/]+/, '');
  return `${rootTrimmed}${separator}${fileTrimmed}`;
}

const _tokenCache = new Map();
const TOKEN_CACHE_MAX = 500;

function setTokenCache(hash, count) {
  _tokenCache.set(hash, count);
  if (_tokenCache.size > TOKEN_CACHE_MAX) {
    while (_tokenCache.size > TOKEN_CACHE_MAX) {
      const oldestKey = _tokenCache.keys().next().value;
      _tokenCache.delete(oldestKey);
    }
  }
}

async function computeHash(text) {
  if (!text) return '';
  const msgBuffer = new TextEncoder().encode(text);
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function estimateTokensBatch(apiFn, texts) {
  if (!texts || texts.length === 0) return [];
  const results = new Array(texts.length).fill(0);
  const missingIndices = [];
  const missingTexts = [];
  const missingHashes = [];

  const hashes = await Promise.all(texts.map((t) => (t ? computeHash(t) : Promise.resolve(''))));

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) {
      results[i] = 0;
      continue;
    }
    const hash = hashes[i];
    const cached = _tokenCache.get(hash);
    if (cached !== undefined) {
      _tokenCache.delete(hash);
      _tokenCache.set(hash, cached);
      results[i] = cached;
    } else {
      missingIndices.push(i);
      missingTexts.push(text);
      missingHashes.push(hash);
    }
  }

  if (missingTexts.length > 0) {
    try {
      const res = await apiFn('/api/agent/tokenize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texts: missingTexts }),
      });
      const counts = res.counts || [];
      for (let j = 0; j < missingTexts.length; j++) {
        const hash = missingHashes[j];
        const count = counts[j] || 0;
        setTokenCache(hash, count);
        results[missingIndices[j]] = count;
      }
    } catch {
      // Fallback heuristic for all missing
      for (let j = 0; j < missingTexts.length; j++) {
        const hash = missingHashes[j];
        const text = missingTexts[j];
        const latinMatch = text.match(/[a-zA-Z0-9\s!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/g);
        const latinCount = latinMatch ? latinMatch.length : 0;
        const multiByteCount = text.length - latinCount;
        const count = Math.ceil(latinCount / 3.5 + multiByteCount * 1.5);
        setTokenCache(hash, count);
        results[missingIndices[j]] = count;
      }
    }
  }

  return results;
}

async function trimAgentHistory(apiFn, history, t, creditSaving, maxTokens) {
  const limit = maxTokens === undefined ? (creditSaving ? 12000 : 40000) : maxTokens;

  // Batch estimate all messages in history
  const contents = history.map((h) => h.content || '');
  const counts = await estimateTokensBatch(apiFn, contents);

  let totalTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    totalTokens += counts[i];
    if (totalTokens > limit && i > 0) {
      const removed = history.splice(0, i);
      history.unshift({
        role: 'user',
        content: t('context_omitted', { count: removed.length }),
      });
      return;
    }
  }
}
async function processCommandStream(res, stepId, t) {
  let finalResult = null;
  const resultBox = document.getElementById(`result-${stepId}`);
  if (resultBox) {
    const toggle = resultBox.previousElementSibling;
    if (toggle) {
      toggle.classList.remove('u-hidden');
      const span = toggle.querySelector('span');
      if (span) span.textContent = t('hide_output');
    }
    resultBox.classList.remove('u-hidden');
    resultBox.textContent = '';
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let carry = '';

  const processBlock = (block) => {
    let eventName = 'message';
    let data = '';
    for (const line of block.split('\n')) {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('event: ')) {
        eventName = trimmedLine.slice(7).trim();
      } else if (trimmedLine.startsWith('data: ')) {
        data += trimmedLine.slice(6);
      }
    }

    if (data) {
      try {
        const parsed = JSON.parse(data);
        if (eventName === 'done') {
          finalResult = parsed;
        } else if (eventName === 'stdout' || eventName === 'stderr') {
          if (resultBox) {
            resultBox.textContent += parsed.text;
            resultBox.scrollTop = resultBox.scrollHeight;
          }
        }
      } catch (e) {
        console.error('Failed to parse SSE data', e);
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      const remaining = carry.trim();
      if (remaining) {
        processBlock(remaining);
      }
      break;
    }
    const chunk = decoder.decode(value, { stream: true });
    const rawBlocks = (carry + chunk).split(/\r?\n\r?\n/);
    carry = rawBlocks.pop() || '';

    for (const block of rawBlocks) {
      if (block.trim()) {
        processBlock(block);
      }
    }
  }
  return finalResult;
}

function buildSystemPrompt({ workspaceFilesText, activeFilePath }) {
  return `You are an exceptionally talented software engineer AI agent.
Your objective is to achieve the user's instructions accurately and safely.
You are currently in a privileged session where you can directly operate on files within an isolated workspace.

[REQUIRED XML OUTPUT SCHEMA]
Every turn MUST output strictly in the following format ONLY. Markdown code blocks, JSON, and free-form explanatory text outside tags are strictly prohibited.
<thought>...</thought><call_tool name="tool_name"><parameter name="parameter_name">value</parameter></call_tool>

1. read_file
   - Parameters: { "path": "file path", "startLine": line number (optional, 1-based), "endLine": line number (optional, 1-based) }
   - Purpose: Read contents of specified file. For large files or specific sections, range lines can be specified via startLine and endLine to read in chunks.
   <call_tool name="read_file"><parameter name="path">utils/helper.js</parameter><parameter name="startLine">10</parameter><parameter name="endLine">30</parameter></call_tool>

2. write_file
   - Parameters: { "path": "file path", "content": "complete file content" }
   - Purpose: Create a new file or propose replacing an entire existing file. User confirmation is required before actual application.
   - Important notes:
     - Prefer apply_diff over write_file for partial edits to existing files.
     - The "content" parameter must NEVER contain markdown code fences (e.g. \`\`\`js ... \`\`\`); write ONLY raw program code text directly.
     - Escape XML metacharacters (& to &amp;, < to &lt;, > to &gt;) properly inside XML parameters.
     - Output complete contents without truncating or skipping code (e.g. do NOT use "// ... rest of code ...").
   <call_tool name="write_file"><parameter name="path">utils/helper.js</parameter><parameter name="content">export const add = (a, b) =&gt; a + b;</parameter></call_tool>

3. apply_diff
   - Parameters: { "path": "file path", "diff": "SEARCH/REPLACE block format diff" }
   - Purpose: Replace (edit) specific sections of a file. Safer and lighter than write_file for editing existing files. Multiple SEARCH/REPLACE blocks can be included in a single call.
   - Important notes:
     - The "diff" parameter must NEVER contain markdown code fences (e.g. \`\`\`diff ... \`\`\`), and must follow the SEARCH/REPLACE block format below.
     - The SEARCH block content must match the target code in the file (including indentation and line breaks) exactly. Provide enough surrounding context to uniquely identify the location.
     - Format example:
<<<<<<< SEARCH
[Original code before replacement]
=======
[New code after replacement]
>>>>>>> REPLACE
   <call_tool name="apply_diff"><parameter name="path">utils/helper.js</parameter><parameter name="diff">&lt;&lt;&lt;&lt;&lt;&lt;&lt; SEARCH
export const add = (a, b) =&gt; a + b;
=======
export const add = (a, b) =&gt; {
  return a + b;
};
&gt;&gt;&gt;&gt;&gt;&gt;&gt; REPLACE</parameter></call_tool>

4. list_directory
   - Parameters: { "path": "directory path" }
   - Purpose: List files and subdirectories directly under the specified directory path. Use first when exploring directory layout or contents.
   <call_tool name="list_directory"><parameter name="path">src</parameter></call_tool>

5. search_files
   - Parameters: { "query": "search query string" }
   - Purpose: Search for specific symbols or text patterns across the entire project.
   <call_tool name="search_files"><parameter name="query">app.listen</parameter></call_tool>

6. run_command
   - Parameters: { "command": "shell command" }
   - Purpose: Execute test suites, check dependencies, etc. Avoid destructive operations, expecting user approval prior to execution.
   <call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>

[COMPLETION REPORTING]
When the goal is fully accomplished, use the <finish>summary</finish> tag instead of a tool call to briefly report what was done.

[IMPORTANT RULES]
- Output MUST strictly consist of a <thought> tag paired with either a <call_tool> or <finish> tag.
- Do NOT include any extra greetings, markdown code blocks, or commentary text outside the tags.
- In parameter values (especially content and diff), ensure XML metacharacters (&, <, >) are properly XML-escaped (&amp;, &lt;, &gt;).
- In diff SEARCH/REPLACE markers (<<<<<<<, =======, >>>>>>>), XML-escape them inside the XML as &lt;&lt;&lt;&lt;&lt;&lt;&lt;, &gt;&gt;&gt;&gt;&gt;&gt;&gt;.
- Do NOT use markdown code block backticks within parameter values.
- When modifying existing files, always read the current file contents using read_file or inspect directory structure with search_files / list_directory first.

Current workspace structure:
${workspaceFilesText}

Currently open file in Monaco editor:
Path: ${activeFilePath || 'None'}
`;
}

export function createAgentRuntime({
  dom,
  state,
  api,
  t,
  parseXMLTags,
  setAgentStatus,
  addAgentTimelineStep,
  addAgentApprovalStep,
}) {
  const openFileEvent = (filePath) => {
    document.dispatchEvent(new CustomEvent('editor:open-file', { detail: { path: filePath } }));
  };

  const showDiffDialogEvent = (displayPath, oldContent, content) => {
    return new Promise((resolve) => {
      document.dispatchEvent(
        new CustomEvent('editor:show-diff', {
          detail: {
            path: displayPath,
            oldContent,
            newContent: content,
            resolve,
          },
        }),
      );
    });
  };
  // Agent context token limits — updated from server config at start of each loop
  let agentMaxContextTokens = undefined;
  let agentMaxContextTokensCreditSaving = undefined;

  const trimHistory = async (history, maxTokensOverride) => {
    const limit =
      maxTokensOverride ?? (state.creditSaving ? agentMaxContextTokensCreditSaving : agentMaxContextTokens);
    return await trimAgentHistory(api, history, t, state.creditSaving, limit);
  };

  function pruneAgentTimeline(maxSteps = 100) {
    const log = dom.agentActivityLog;
    if (!log) return;
    const isAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 80;
    let previousScrollHeight = 0;
    if (!isAtBottom) {
      previousScrollHeight = log.scrollHeight;
    }
    while (log.children.length > maxSteps) {
      log.removeChild(log.firstChild);
    }
    if (!isAtBottom) {
      const heightDelta = previousScrollHeight - log.scrollHeight;
      log.scrollTop = Math.max(0, log.scrollTop - heightDelta);
    }
  }

  function cleanupPendingApprovals() {
    document.querySelectorAll('.agent-step.approval').forEach((el) => el.__finalizeApproval?.());
  }

  async function previewFullFileWrite({ sessionId, fullPath, displayPath, content }) {
    const readUrl = `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`;
    let oldContent = '';
    let existed = false;

    const currentRes = await api(readUrl, { raw: true });
    if (currentRes.ok) {
      const currentData = await currentRes.json().catch(() => ({}));
      oldContent = typeof currentData?.content === 'string' ? currentData.content : '';
      existed = true;
    } else if (currentRes.status !== 404) {
      const errorData = await currentRes.json().catch(() => ({}));
      throw new Error(errorData?.error || errorData?.message || `HTTP ${currentRes.status}`);
    }

    const approved = await showDiffDialogEvent(displayPath, oldContent, content);
    if (!approved) {
      return {
        success: false,
        text: 'ユーザーによって拒否されました',
      };
    }

    await api(`/api/agent/sessions/${sessionId}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content }),
    });
    await openFileEvent(fullPath);

    return {
      success: true,
      text: existed
        ? `ファイル ${displayPath} の全体置換を適用しました。`
        : `新規ファイル ${displayPath} を作成しました。`,
    };
  }

  const agentToolHandlers = {
    read_file: async ({ sessionId, workspaceRoot, params }) => {
      const { path: filePath, startLine, endLine } = params;
      if (!filePath) throw new Error('path パラメータが必要です');
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
      let url = `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`;
      if (startLine !== undefined) url += `&startLine=${startLine}`;
      if (endLine !== undefined) url += `&endLine=${endLine}`;
      const data = await api(url);
      await openFileEvent(fullPath);
      return { text: data.content, success: true };
    },
    write_file: async ({ sessionId, workspaceRoot, params }) => {
      const { path: filePath, content } = params;
      if (!filePath) throw new Error('path パラメータが必要です');
      if (typeof content !== 'string') throw new Error('content パラメータが必要です');
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
      return previewFullFileWrite({
        sessionId,
        fullPath,
        displayPath: filePath,
        content,
      });
    },
    apply_diff: async ({ sessionId, workspaceRoot, params }) => {
      const { path: filePath, diff } = params;
      if (!filePath) throw new Error('path パラメータが必要です');
      if (diff === undefined) throw new Error('diff パラメータが必要です');
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);

      const current = await api(
        `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
      );
      const preview = await api(`/api/agent/sessions/${sessionId}/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, diff, dryRun: true }),
      });

      if (await showDiffDialogEvent(filePath, current.content, preview.newContent || current.content)) {
        const res = await api(`/api/agent/sessions/${sessionId}/diff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, diff }),
        });
        await openFileEvent(fullPath);
        return { text: res.message || '置換成功', success: true };
      }
      return { text: 'ユーザーによって拒否されました', success: false };
    },
    list_directory: async ({ sessionId, workspaceRoot, params }) => {
      const dirPath = params.path || '';
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, dirPath);
      const data = await api(`/api/agent/sessions/${sessionId}/dir?path=${encodeURIComponent(fullPath)}`);
      const text = data.items?.length
        ? data.items.map((i) => `- ${i.isDirectory ? '[Dir] ' : '[File] '}${i.name}`).join('\n')
        : 'ディレクトリは空または存在しません。';
      return { text, success: true };
    },
    search_files: async ({ sessionId, params }) => {
      const { query } = params;
      if (!query) throw new Error('query パラメータが必要です');
      const data = await api(`/api/agent/sessions/${sessionId}/search?query=${encodeURIComponent(query)}`);
      const text = data.results?.length
        ? data.results.map((r) => `${r.file}:${r.line}: ${r.content}`).join('\n')
        : '検索結果なし';
      return { text, success: true };
    },
    run_command: async ({ sessionId, workspaceRoot, params }) => {
      const { command } = params;
      if (!command) throw new Error('command パラメータが必要です');

      if (state.agent.resolver) {
        return {
          text: '別のコマンドが承認待ちです。先に承認/却下してください。',
          success: false,
          retryable: true,
        };
      }

      setAgentStatus(t('agent_status_awaiting') || '承認待ち...', 'awaiting_approval');
      const runResRaw = await api(`/api/agent/sessions/${sessionId}/commands?stream=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, cwd: workspaceRoot }),
        raw: true,
      });

      let runRes;
      const contentType = runResRaw.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        runRes = await runResRaw.json();
      } else {
        const stepId = addAgentTimelineStep(
          'action',
          `コマンド実行: ${command.split(' ')[0]}`,
          '自動承認により実行を開始します...',
          '',
        );
        runRes = await processCommandStream(runResRaw, stepId, t);
      }

      if (!runRes.requiresApproval) {
        return {
          text: `Exit Code: ${runRes.exitCode}\n\nSTDOUT:\n${runRes.stdout}\n\nSTDERR:\n${runRes.stderr}`,
          success: runRes.exitCode === 0,
        };
      }

      const approvalResult = await new Promise((resolve) => {
        state.agent.resolver = resolve;
        addAgentApprovalStep(
          command,
          workspaceRoot,
          runRes.approvalToken,
          async () => {
            setAgentStatus(t('agent_status_executing') || '実行中...', 'executing');
            try {
              const resRaw = await api(`/api/agent/sessions/${sessionId}/approve?stream=true`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ approvalToken: runRes.approvalToken }),
                raw: true,
              });
              let res;
              const resContentType = resRaw.headers.get('content-type') || '';
              if (resContentType.includes('application/json')) {
                res = await resRaw.json();
              } else {
                const stepId = addAgentTimelineStep(
                  'action',
                  `コマンド実行: ${command.split(' ')[0]}`,
                  '実行を開始します...',
                  '',
                );
                res = await processCommandStream(resRaw, stepId, t);
              }
              resolve({ approved: true, result: res });
            } catch (e) {
              resolve({ approved: true, error: e });
            }
          },
          (reason) => resolve({ approved: false, reason }),
        );
      });

      state.agent.resolver = null;
      if (approvalResult.abort) return { text: 'ABORTED', success: false, abort: true };
      if (!approvalResult.approved)
        return { text: t('cmd_reject_prefix', { reason: approvalResult.reason }), success: false };
      if (approvalResult.error) return { text: `エラー: ${approvalResult.error.message}`, success: false };

      const { result } = approvalResult;
      return {
        text: `Exit Code: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`,
        success: result.exitCode === 0,
      };
    },
  };

  async function runAgentLoop(initialInstruction) {
    const workspaceRoot = dom.explorerPath.value || '';
    setAgentStatus('初期化中...', 'thinking');
    addAgentTimelineStep('user', '指示', initialInstruction);

    if (!state.agent.sessionId) {
      try {
        const sessionData = await api('/api/agent/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cwd: workspaceRoot,
            task: initialInstruction,
          }),
        });
        state.agent.sessionId = sessionData.session.id;
        addAgentTimelineStep(
          'thought',
          'セッション開始',
          `エージェントセッションが開始されました。\nワークスペース: ${workspaceRoot}`,
        );
      } catch (e) {
        addAgentTimelineStep('error', 'セッション作成失敗', `セッションの初期化に失敗しました: ${e.message}`);
        setAgentStatus('エラー', 'error');
        return;
      }
    } else {
      addAgentTimelineStep('thought', 'セッション再開', '既存のセッションで追加指示を実行します。');
    }

    const sessionId = state.agent.sessionId;
    const modelSelected = dom.codeModel?.value || 'qwen3-coder-plus';
    if (state.agent.history.length === 0) {
      // System prompt is now injected fresh on each loop iteration,
      // so we only store the user instruction in history.
      state.agent.history = [{ role: 'user', content: initialInstruction }];
    } else {
      state.agent.history.push({
        role: 'user',
        content: `【ユーザーからの追加指示】\n${initialInstruction}`,
      });
      await trimHistory(state.agent.history);
    }

    let loopCount = 0;
    let maxLoops = 20;
    let consecutiveParseErrors = 0;
    let maxParseFailures = 3;
    try {
      const agentConfig = await api('/api/agent/config');
      if (agentConfig.maxLoops) maxLoops = agentConfig.maxLoops;
      if (agentConfig.maxParseFailures) maxParseFailures = agentConfig.maxParseFailures;
      if (agentConfig.maxContextTokens) agentMaxContextTokens = agentConfig.maxContextTokens;
      if (agentConfig.maxContextTokensCreditSaving) {
        agentMaxContextTokensCreditSaving = agentConfig.maxContextTokensCreditSaving;
      }
    } catch {
      // Use default
    }

    while (state.agent.active && loopCount < maxLoops) {
      loopCount++;
      setAgentStatus('思考中...', 'thinking');

      // Re-inject a fresh system prompt on every iteration so the model
      // always sees the current workspace state and active file, even
      // after the conversation history has been trimmed.
      let workspaceFilesText;
      try {
        workspaceFilesText = await fetchWorkspaceFiles(api, workspaceRoot);
      } catch {
        workspaceFilesText = `Workspace path: ${workspaceRoot}\n(Failed to fetch file list)`;
      }
      const freshSysPrompt = buildSystemPrompt({
        workspaceRoot,
        workspaceFilesText,
        activeFilePath: state.editor.activeFilePath,
      });

      // Prepend fresh system prompt before the conversation history
      const messagesForApi = [
        { role: 'system', content: buildAgentPromptInstructions() },
        { role: 'system', content: freshSysPrompt },
        ...state.agent.history,
      ];

      let chatRes;
      let networkRetryCount = 0;
      const maxNetworkRetries = 3;
      while (networkRetryCount < maxNetworkRetries) {
        try {
          chatRes = await api('/api/agent/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              messages: messagesForApi,
              model: modelSelected,
              webSearch: false,
              // NOTE: the CODE_GENERATOR feature has no conversation concept;
              // do not send conversationId here (it would be silently dropped).
            }),
            timeout: 600000,
          });
          break;
        } catch (e) {
          networkRetryCount++;
          if (networkRetryCount < maxNetworkRetries) {
            addAgentTimelineStep(
              'warn',
              `AI通信リトライ (${networkRetryCount}/${maxNetworkRetries})`,
              `AIとの通信に失敗しました (${e.message})。3秒後に自動再試行します...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } else {
            addAgentTimelineStep('error', 'AI通信失敗', `AIとの通信に失敗しました: ${e.message}`);
            setAgentStatus('エラー', 'error');
            break;
          }
        }
      }

      if (!chatRes) break;

      const aiText = chatRes.text || '';
      if (!aiText) {
        addAgentTimelineStep('error', t('status_error'), 'AIからの応答が空でした。');
        setAgentStatus(t('status_error'), 'error');
        break;
      }

      const parsed = parseXMLTags(aiText);

      if (parsed.thought) {
        addAgentTimelineStep('thought', '思考プロセス', parsed.thought);
      } else {
        addAgentTimelineStep('thought', '思考プロセス', aiText);
      }

      if (parsed.finish) {
        addAgentTimelineStep(
          'result',
          'タスク完了',
          `エージェントがタスクの完了を報告しました。\n\n要約:\n${parsed.finish}`,
        );
        setAgentStatus(t('status_done'), 'completed');
        break;
      }

      if (parsed.toolCall) {
        consecutiveParseErrors = 0;
        const toolName = parsed.toolCall.name;
        const params = parsed.toolCall.params;

        const paramListStr = Object.entries(params)
          .map(([k, v]) => `• ${k}: ${v}`)
          .join('\n');
        addAgentTimelineStep('action', `ツール呼び出し: ${toolName}`, paramListStr);
        setAgentStatus(t('agent_status_executing') || '実行中...', 'executing');

        let toolResultText;
        let toolSuccess;

        try {
          const handler = agentToolHandlers[toolName];
          if (!handler) throw new Error(`未知のツール: ${toolName}`);

          const result = await handler({
            sessionId,
            workspaceRoot,
            params,
          });

          if (result.abort) break;

          if (result.retryable) {
            state.agent.history.push({ role: 'assistant', content: aiText });
            state.agent.history.push({
              role: 'user',
              content: `<tool_response>\n${result.text}\n</tool_response>`,
            });
            await trimHistory(state.agent.history);
            loopCount = Math.max(0, loopCount - 1);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }

          toolResultText = result.text;
          toolSuccess = result.success;
        } catch (err) {
          toolResultText = `エラー: ${err.message}`;
          toolSuccess = false;
        }

        addAgentTimelineStep(
          toolSuccess ? 'result' : 'error',
          `ツール結果: ${toolName}`,
          toolSuccess ? 'ツールの実行が完了しました。' : 'エラーまたはキャンセルが発生しました。',
          toolResultText,
        );

        const feedbackMsg = `<tool_response>\n${toolResultText}\n</tool_response>`;

        state.agent.history.push({ role: 'assistant', content: aiText });
        state.agent.history.push({ role: 'user', content: feedbackMsg });
        await trimHistory(state.agent.history);
      } else {
        consecutiveParseErrors++;
        console.warn(
          `[Code Generator Agent] XML parse failed on AI response (attempt ${consecutiveParseErrors}/${maxParseFailures}). Raw response:\n`,
          aiText,
        );
        const repairPrompt = buildXmlRepairPrompt({
          aiText,
          errorReason: 'XML tag missing or closing tag mismatch.',
        });
        const shouldRetryRepair = consecutiveParseErrors <= Math.floor(maxParseFailures / 2);
        if (consecutiveParseErrors >= maxParseFailures) {
          addAgentTimelineStep(
            'error',
            'パースエラー',
            `AIがフォーマットに従わない状態が ${maxParseFailures} 回連続したため、安全のためにエージェントを強制停止します。`,
            aiText,
          );
          setAgentStatus(t('status_error'), 'error');
          break;
        }

        const errMsg =
          'Error: Failed to parse XML format. Please output again using <thought>, <call_tool>, or <finish>.';
        addAgentTimelineStep(
          'error',
          'パース失敗',
          'AIが定義されたXMLフォーマットに準拠していません。自動修正指示を送信します。',
          aiText,
        );

        state.agent.history.push({ role: 'assistant', content: aiText });
        state.agent.history.push({ role: 'user', content: shouldRetryRepair ? repairPrompt : errMsg });
        await trimHistory(state.agent.history);

        if (shouldRetryRepair) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          loopCount = Math.max(0, loopCount - 1);
          continue;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    if (loopCount >= maxLoops && state.agent.active) {
      addAgentTimelineStep(
        'error',
        t('agent_status_limit_reached') || '制限到達',
        t('agent_status_limit_desc', { max: maxLoops }) ||
          `実行ステップ数が上限 (${maxLoops}) に達したため、安全のために停止しました。`,
      );
      setAgentStatus(t('status_error'), 'error');
    }

    state.agent.active = false;
    dom.startAgentBtn.classList.remove('is-hidden');
    dom.sendAgentFeedbackBtn.classList.remove('is-shown');
    dom.stopAgentBtn.classList.remove('is-shown');
    dom.resetAgentBtn.classList.remove('is-hidden');
    dom.agentInstruction.placeholder = t('agent_instruction_placeholder');
    if (!dom.agentStatus.classList.contains('completed') && !dom.agentStatus.classList.contains('error')) {
      setAgentStatus(t('agent_status_idle'), 'idle');
    }
  }

  return {
    runAgentLoop,
    cleanupPendingApprovals,
    pruneAgentTimeline,
  };
}
