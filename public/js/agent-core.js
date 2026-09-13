import { buildXmlRepairPrompt } from './utils.js';

// Cache for workspace file lists to avoid redundant API calls during agent loops.
// Capped at 20 entries to prevent unbounded memory growth when switching workspaces.
const _fileListCache = new Map();
const FILE_LIST_CACHE_TTL_MS = 30_000;
const FILE_LIST_CACHE_MAX = 20;

function buildAgentPromptInstructions() {
  return [
    'IMPORTANT PROTOCOL INSTRUCTIONS:',
    'You can format your response in EITHER valid XML tags OR a single valid JSON object.',
    'Format Option 1 (XML):',
    '<thought>your reasoning</thought><call_tool name="tool_name"><parameter name="param_name">value</parameter></call_tool>',
    'Or to complete:',
    '<thought>summary of actions</thought><finish>concise conclusion</finish>',
    '',
    'Format Option 2 (JSON):',
    '{"thought": "your reasoning", "tool": "tool_name", "params": {"param_name": "value"}}',
    'Or to complete:',
    '{"thought": "summary of actions", "finish": "concise conclusion"}',
    '',
    'Rules:',
    '- Do NOT output conversational chit-chat outside the tags/JSON object.',
    '- In XML parameter values, escape XML metacharacters (&, <, >) or wrap in <![CDATA[...]]>.',
    '- In JSON values, escape double quotes and newlines properly.',
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

function fallbackHash(text) {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 'fb_' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

async function computeHash(text) {
  if (!text) return '';
  try {
    if (typeof window !== 'undefined' && window.crypto?.subtle?.digest) {
      const msgBuffer = new TextEncoder().encode(text);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', msgBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // Web Crypto subtle unavailable or failed, fall back to deterministic hash
  }
  return fallbackHash(text);
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
      if (history.length > 1) {
        // Keep initial instruction at history[0] to prevent goal amnesia
        const removed = history.splice(1, i);
        history.splice(1, 0, {
          role: 'user',
          content:
            t('context_omitted', { count: removed.length }) ||
            `【過去の経緯省略 (${removed.length}件のステップを圧縮)】`,
        });
      } else {
        const removed = history.splice(0, i);
        history.unshift({
          role: 'user',
          content:
            t('context_omitted', { count: removed.length }) ||
            `【過去の経緯省略 (${removed.length}件のステップを圧縮)】`,
        });
      }
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

function buildSystemPrompt({ workspaceFilesText, activeFilePath, projectInfoText }) {
  return `You are an exceptionally talented software engineer AI agent.
Your objective is to achieve the user's instructions accurately and safely.
You are in a privileged session where you can inspect and modify files within an isolated workspace.

${projectInfoText ? `[PROJECT ENVIRONMENT]\n${projectInfoText}\n\n` : ''}[SUPPORTED RESPONSE FORMATS]
You can format your response in EITHER valid XML tags OR a single valid JSON object.

Format Option 1 (XML):
<thought>Brief thought process</thought><call_tool name="tool_name"><parameter name="param_name">value</parameter></call_tool>
Or to finish:
<thought>Summary</thought><finish>All tasks completed successfully</finish>

Format Option 2 (JSON):
{"thought": "Brief thought process", "tool": "tool_name", "params": {"param_name": "value"}}
Or to finish:
{"thought": "Summary", "finish": "All tasks completed successfully"}

[AVAILABLE TOOLS]

1. read_file
   - Parameters: { "path": "file path", "startLine": number (optional, 1-based), "endLine": number (optional, 1-based) }
   - Purpose: Read file contents. Specify startLine and endLine for large files.
   <call_tool name="read_file"><parameter name="path">src/app.js</parameter><parameter name="startLine">1</parameter><parameter name="endLine">50</parameter></call_tool>

2. write_file
   - Parameters: { "path": "file path", "content": "complete file content" }
   - Purpose: Create a new file or propose replacing an entire existing file. User confirmation is required.
   - Important: Prefer apply_diff for modifying existing files. Never include markdown code fences in content.

3. apply_diff
   - Parameters: { "path": "file path", "diff": "SEARCH/REPLACE block format diff", "startLine": number (optional line hint) }
   - Purpose: Surgically edit specific sections of a file.
   - Format:
<<<<<<< SEARCH
[Original code in file]
=======
[New replacement code]
>>>>>>> REPLACE

4. find_files
   - Parameters: { "pattern": "glob pattern like **/*.js or tests/*.test.js", "dir": "optional dir", "maxResults": 50 }
   - Purpose: Rapidly find files matching a glob pattern across the project without listing every directory.
   <call_tool name="find_files"><parameter name="pattern">**/*.test.js</parameter></call_tool>

5. get_file_outline
   - Parameters: { "path": "file path", "language": "optional language" }
   - Purpose: Extract functions, classes, methods, and exports with line numbers from large files before reading or editing.
   <call_tool name="get_file_outline"><parameter name="path">server.js</parameter></call_tool>

6. list_directory
   - Parameters: { "path": "directory path" }
   - Purpose: List immediate contents of a directory.
   <call_tool name="list_directory"><parameter name="path">src</parameter></call_tool>

7. search_files
   - Parameters: { "query": "search query string", "dir": "optional dir" }
   - Purpose: Search for specific symbols or text patterns across the entire project with ripgrep/grep.
   <call_tool name="search_files"><parameter name="query">app.listen</parameter></call_tool>

8. validate_code
   - Parameters: { "code": "source code string", "language": "javascript/json/typescript/css" }
   - Purpose: Check code for syntax errors in memory before saving or proposing diffs.
   <call_tool name="validate_code"><parameter name="language">javascript</parameter><parameter name="code">const x = 1;</parameter></call_tool>

9. run_command
   - Parameters: { "command": "shell command" }
   - Purpose: Execute test suites (npm test), type checks, etc. Requires user approval.
   <call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>

[BEST PRACTICES & CODING DISCIPLINE]
1. Investigate first: Always inspect files using find_files, get_file_outline, search_files, or read_file before proposing changes.
2. Minimal surgical edits: Prefer apply_diff for existing files to keep modifications clear and minimize breakage.
3. Self-verification: Validate syntax using validate_code or run tests using run_command before finishing.
4. When finished, report concise summary with <finish>summary</finish> or {"finish": "summary"}.

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
      const { path: filePath, diff, startLine } = params;
      if (!filePath) throw new Error('path パラメータが必要です');
      if (diff === undefined) throw new Error('diff パラメータが必要です');
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);

      const current = await api(
        `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
      );
      const preview = await api(`/api/agent/sessions/${sessionId}/diff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fullPath, diff, dryRun: true, startLine }),
      });

      if (await showDiffDialogEvent(filePath, current.content, preview.newContent || current.content)) {
        const res = await api(`/api/agent/sessions/${sessionId}/diff`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: fullPath, diff, startLine }),
        });
        await openFileEvent(fullPath);
        return { text: res.message || '置換成功', success: true };
      }
      return { text: 'ユーザーによって拒否されました', success: false };
    },
    find_files: async ({ sessionId, workspaceRoot, params }) => {
      const pattern = params.pattern || params.query || '*';
      const dir = params.dir || '';
      const fullDir = resolvePathRelativeToWorkspace(workspaceRoot, dir);
      let url = `/api/agent/sessions/${sessionId}/find-files?pattern=${encodeURIComponent(pattern)}`;
      if (dir) url += `&dir=${encodeURIComponent(fullDir)}`;
      if (params.maxResults) url += `&maxResults=${params.maxResults}`;
      const data = await api(url);
      const text = data.files?.length
        ? `Found ${data.files.length} matching files:\n` +
          data.files.map((f) => `- ${f.relativePath}`).join('\n')
        : '一致するファイルは見つかりませんでした。';
      return { text, success: true };
    },
    get_file_outline: async ({ sessionId, workspaceRoot, params }) => {
      const filePath = params.path;
      if (!filePath) throw new Error('path パラメータが必要です');
      const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
      let url = `/api/agent/sessions/${sessionId}/outline?path=${encodeURIComponent(fullPath)}`;
      if (params.language) url += `&language=${encodeURIComponent(params.language)}`;
      const data = await api(url);
      const text = data.symbols?.length
        ? `Outline for ${filePath} (${data.symbols.length} symbols):\n` +
          data.symbols.map((s) => `• [L${s.line}] (${s.type}) ${s.signature || s.name}`).join('\n')
        : `No top-level symbols detected in ${filePath}`;
      return { text, success: true };
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
    validate_code: async ({ sessionId, params }) => {
      const { code, language } = params;
      if (typeof code !== 'string') throw new Error('code パラメータが必要です');
      const data = await api(`/api/agent/sessions/${sessionId}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, language: language || 'javascript' }),
      });
      if (data.valid) {
        return { text: '構文チェック合格: エラーはありません。', success: true };
      }
      const loc = data.line ? ` (Line ${data.line}${data.column ? `, Col ${data.column}` : ''})` : '';
      return { text: `構文エラー検出${loc}: ${data.error}`, success: false };
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

    // Retrieve workspace project metadata once per loop session
    let projectInfoText = '';
    try {
      const projRes = await api(`/api/agent/sessions/${sessionId}/project-info`);
      if (projRes?.project?.hasPackageJson) {
        const p = projRes.project;
        projectInfoText = `Project: ${p.projectName || 'unnamed'} (${p.projectType}) | Test Command: ${p.testCommand || 'none'} | Configs: ${p.configFiles?.join(', ') || 'none'}`;
      }
    } catch {
      // project info is optional enhancement
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
        projectInfoText,
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
          `[Code Generator Agent] Format parse failed on AI response (attempt ${consecutiveParseErrors}/${maxParseFailures}). Raw response:\n`,
          aiText,
        );
        const repairPrompt = buildXmlRepairPrompt({
          aiText,
          errorReason: 'Output did not match XML tags (<thought>, <call_tool>, <finish>) or valid JSON tool call format.',
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
          'Error: Failed to parse response. Please output valid XML (<thought>, <call_tool>, or <finish>) or a valid JSON object {"thought": "...", "tool": "...", "params": {...}}.';
        addAgentTimelineStep(
          'error',
          'パース失敗',
          'AIの出力フォーマットを解析できませんでした。自動修正指示を送信します。',
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
