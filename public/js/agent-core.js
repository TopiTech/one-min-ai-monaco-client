import { buildXmlRepairPrompt } from './utils.js';

// Cache for workspace file lists to avoid redundant API calls during agent loops.
// Capped at 20 entries to prevent unbounded memory growth when switching workspaces.
const _fileListCache = new Map();
const FILE_LIST_CACHE_TTL_MS = 30_000;
const FILE_LIST_CACHE_MAX = 20;

function buildAgentPromptInstructions() {
  return [
    '重要: 返答は必ずXMLのみで出力してください。',
    '許可されるトップレベルタグは <thought>, <call_tool>, <finish> のみです。',
    '説明文、Markdown、箇条書き、コードフェンスは出力しないでください。',
    'XMLの特殊文字 (&, <, >) は必ずエスケープしてください。',
    'ツールを呼ぶ場合は <call_tool name="..."> と <parameter name="..."> を正しく閉じてください。',
    '迷った場合は <finish> を使って簡潔に完了を返してください。',
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
  const text = `ワークスペースパス: ${workspaceRoot}\n` + filesList;
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

async function estimateTokensBatch(apiFn, texts) {
  if (!texts || texts.length === 0) return [];
  const results = new Array(texts.length).fill(0);
  const missingIndices = [];
  const missingTexts = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    if (!text) {
      results[i] = 0;
      continue;
    }
    const cached = _tokenCache.get(text);
    if (cached !== undefined) {
      _tokenCache.delete(text);
      _tokenCache.set(text, cached);
      results[i] = cached;
    } else {
      missingIndices.push(i);
      missingTexts.push(text);
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
        const text = missingTexts[j];
        const count = counts[j] || 0;
        _tokenCache.set(text, count);
        results[missingIndices[j]] = count;
      }
      if (_tokenCache.size > TOKEN_CACHE_MAX) {
        while (_tokenCache.size > TOKEN_CACHE_MAX) {
          const oldestKey = _tokenCache.keys().next().value;
          _tokenCache.delete(oldestKey);
        }
      }
    } catch {
      // Fallback heuristic for all missing
      for (let j = 0; j < missingTexts.length; j++) {
        const text = missingTexts[j];
        const latinMatch = text.match(/[a-zA-Z0-9\s!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/g);
        const latinCount = latinMatch ? latinMatch.length : 0;
        const multiByteCount = text.length - latinCount;
        const count = Math.ceil(latinCount / 3.5 + multiByteCount * 1.5);
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
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventName = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) {
          eventName = line.slice(7);
        } else if (line.startsWith('data: ')) {
          data += line.slice(6);
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
      boundary = buffer.indexOf('\n\n');
    }
  }
  return finalResult;
}

function buildSystemPrompt({ workspaceFilesText, activeFilePath }) {
  return `あなたは極めて優秀なソフトウェアエンジニアAIエージェントです。
あなたの目的は、ユーザーの指示を「正確に」かつ「安全に」達成することです。
あなたは現在、隔離されたワークスペース内のファイルを直接操作できる特権セッションにいます。

【必須XML出力スキーマ】
各ターンは必ず以下の形式だけを出力してください。Markdownコードブロック、JSON、自由形式の説明文は禁止です。
<thought>...</thought><call_tool name="tool名"><parameter name="パラメータ名">値</parameter></call_tool>

1. read_file
   - パラメータ: { "path": "ファイルパス", "startLine": 行番号(任意/1開始), "endLine": 行番号(任意/1開始) }
   - 目的: 指定したファイルの内容を読み取る。大きなファイルや特定箇所のみを見たい場合、startLineとendLineで範囲を指定して分割して読み込むことが可能。
   <call_tool name="read_file"><parameter name="path">utils/helper.js</parameter><parameter name="startLine">10</parameter><parameter name="endLine">30</parameter></call_tool>

2. write_file
    - 【必須】このツールの <parameter> 値は XML テキストなので、& < > はそれぞれ & < > に、完全なコードは省略せずにエスケープして出力してください。
   - パラメータ: { "path": "ファイルパス", "content": "完全なコード内容" }
   - 目的: **新規ファイル作成**、または**既存ファイル全体を置換候補として提示**する。実際の適用前には必ずユーザー確認が入る。
   - **注意点**:
     - 既存ファイルの部分編集は write_file ではなく **apply_diff を優先**してください。
     - \`content\` パラメータには、絶対にマークダウンのコードブロック（例: \`\`\`js ... \`\`\`）を含めず、**プログラムの生テキストのみ**を直接記述してください。
     - HTML/XMLの実体参照エスケープ（\`<\`や\`>\`、\`&\`など）は**一切行わず**、そのままの記号（\`<\`, \`>\`, \`&\`）で記述してください。
     - コードの途中で省略（例: \`// ... 残りのコード ...\`）せず、完全な内容を出力してください。
   <call_tool name="write_file"><parameter name="path">utils/helper.js</parameter><parameter name="content">export const add = (a, b) => a + b;</parameter></call_tool>

3. apply_diff
   - パラメータ: { "path": "ファイルパス", "diff": "SEARCH/REPLACEブロック形式の差分" }
   - 目的: ファイルの特定箇所のみを置換（編集）する。全文を書き換える write_file よりも軽量で安全なため、既存ファイルの編集にはこちらを使用すること。複数の箇所の置換（マルチブロック）も同時に実行可能です。
   - **注意点**:
     - \`diff\` パラメータには、絶対にマークダウンのコードブロック（例: \`\`\`diff ... \`\`\`）を含めず、かつ実体参照エスケープを行わずに、**以下のSEARCH/REPLACE形式のみ**を記述してください。
     - SEARCHブロックの内容は、ファイル内の対象コード（インデント・改行等含む）と完全に一致する必要があります。一意に特定できるように、十分な長さ（前後の行を含む）で指定してください。
     - 形式見本:
<<<<<<< SEARCH
[置換前の元のコード]
=======
[置換後の新しいコード]
>>>>>>> REPLACE
   <call_tool name="apply_diff"><parameter name="path">utils/helper.js</parameter><parameter name="diff"><<<<<<< SEARCH
export const add = (a, b) => a + b;
=======
export const add = (a, b) => {
  return a + b;
};
>>>>>>> REPLACE</parameter></call_tool>

4. list_directory
   - パラメータ: { "path": "ディレクトリパス" }
   - 目的: 指定したディレクトリの直下にあるファイルやフォルダの一覧を取得する。フォルダ構成や中身を把握する際に最初に使用すること。
   <call_tool name="list_directory"><parameter name="path">src</parameter></call_tool>

5. search_files
   - パラメータ: { "query": "検索文字列" }
   - 目的: プロジェクト全体から特定のシンボルや文字列を検索する。
   <call_tool name="search_files"><parameter name="query">app.listen</parameter></call_tool>

6. run_command
   - パラメータ: { "command": "シェルコマンド" }
   - 目的: テストの実行、依存関係の確認など。破壊的な操作は控え、実行前にユーザーの承認を求めることを想定すること。
   <call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>

【完了報告】
目的を完全に達成した場合は、ツールの代わりに <finish>要約</finish> タグを使い、何を行ったか簡潔に報告してください。

【重要な注意】
- 出力は必ず <thought> と <call_tool> (または <finish>) のペアのみにしてください。
- 余計な挨拶、マークダウンのコードブロック、解説文をタグの外側に含めないでください。
- parameter の値（特に content と diff）は XML テキストなので、& は &、< は <、> は > に必ずエスケープしてください。
- diff の SEARCH/REPLACE マーカー（<<<<<<<、=======、>>>>>>>）も XML 内では <<<<<<<、>>>>>>> にエスケープしてください。
- 値の中身に Markdown のコードブロック記号は使わないでください。
- すでに存在するファイルを変更する場合、まず read_file で現在の内容を確認するか、または search_files や list_directory でファイル構成を把握することが必須です。

現在のワークスペース構造:
${workspaceFilesText}

現在の Monaco エディタで開いているファイル:
パス: ${activeFilePath || 'なし'}
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

      setAgentStatus('承認待ち...', 'awaiting_approval');
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
            setAgentStatus('実行中...', 'executing');
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
        return { text: `拒否されました: ${approvalResult.reason}`, success: false };
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
        workspaceFilesText = `ワークスペースパス: ${workspaceRoot}\n(ファイル一覧の取得に失敗しました)`;
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
      try {
        chatRes = await api('/api/agent/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: messagesForApi,
            model: modelSelected,
            webSearch: false,
            conversationId: sessionId,
          }),
          timeout: 600000,
        });
      } catch (e) {
        addAgentTimelineStep('error', 'AI通信失敗', `AIとの通信に失敗しました: ${e.message}`);
        setAgentStatus('エラー', 'error');
        break;
      }

      const aiText = chatRes.text || '';
      if (!aiText) {
        addAgentTimelineStep('error', '応答空', 'AIからの応答が空でした。');
        setAgentStatus('エラー', 'error');
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
        setAgentStatus('完了', 'completed');
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
        setAgentStatus('実行中...', 'executing');

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
        const repairPrompt = buildXmlRepairPrompt({
          aiText,
          errorReason: 'XMLタグが欠落、または閉じタグの不整合があります。',
        });
        const shouldRetryRepair = consecutiveParseErrors <= Math.floor(maxParseFailures / 2);
        if (consecutiveParseErrors >= maxParseFailures) {
          addAgentTimelineStep(
            'error',
            'パースエラー',
            `AIがフォーマットに従わない状態が ${maxParseFailures} 回連続したため、安全のためにエージェントを強制停止します。`,
          );
          setAgentStatus('エラー', 'error');
          break;
        }

        const errMsg =
          'エラー: XMLフォーマットの解析に失敗しました。<thought>, <call_tool>, <finish> のいずれかで再出力してください。';
        addAgentTimelineStep(
          'error',
          'パース失敗',
          'AIが定義されたXMLフォーマットに準拠していません。自動修正指示を送信します。',
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
        '制限到達',
        `実行ステップ数が上限 (${maxLoops}) に達したため、安全のために停止しました。`,
      );
      setAgentStatus('エラー', 'error');
    }

    state.agent.active = false;
    dom.startAgentBtn.classList.remove('is-hidden');
    dom.sendAgentFeedbackBtn.classList.remove('is-shown');
    dom.stopAgentBtn.classList.remove('is-shown');
    dom.resetAgentBtn.classList.remove('is-hidden');
    dom.agentInstruction.placeholder = '指示を入力してエージェントを開始...';
    if (dom.agentStatus.textContent !== '完了' && dom.agentStatus.textContent !== 'エラー') {
      setAgentStatus('待機中', 'idle');
    }
  }

  return {
    runAgentLoop,
    cleanupPendingApprovals,
    pruneAgentTimeline,
  };
}
