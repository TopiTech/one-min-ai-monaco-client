/**
 * Monaco Editor management module
 */

import { api } from './api.js';
import { isDarkTheme } from './theme.js';

const MAX_OPEN_MODELS = 20;
const AUTOCOMPLETE_CONTEXT_BEFORE_LINES = 80;
const AUTOCOMPLETE_CONTEXT_AFTER_LINES = 40;

function getAutocompleteContext(model, position) {
  const lineCount = model.getLineCount();
  const startLine = Math.max(1, position.lineNumber - AUTOCOMPLETE_CONTEXT_BEFORE_LINES);
  const endLine = Math.min(lineCount, position.lineNumber + AUTOCOMPLETE_CONTEXT_AFTER_LINES);
  const context = model.getValueInRange({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  });

  return {
    code: context,
    line: position.lineNumber - startLine + 1,
    column: position.column,
  };
}

export function createEditorState() {
  return {
    activeFilePath: null,
    openTabs: [],
    isInlineChatOpen: false,
    inlineChatDom: null,
    originalVersions: {},
  };
}

export function createEditorManager(state) {
  let _instance = null;
  let _resizeObserver = null;

  function getTheme() {
    // UI-9: Respect OS high-contrast preference
    if (window.matchMedia?.('(prefers-contrast: more)').matches) {
      return isDarkTheme() ? 'hc-black' : 'hc-light';
    }
    return isDarkTheme() ? 'vs-dark' : 'vs';
  }

  function init() {
    const theme = getTheme();

    _instance = monaco.editor.create(document.getElementById('editor'), {
      value: `/* \u2b05 \u5de6\u306e\u30c4\u30ea\u30fc\u304b\u3089\u30d5\u30a1\u30a4\u30eb\u3092\u9078\u629e\u3059\u308b\u304b\u3001\u30d1\u30b9\u3092\u5165\u529b\u3057\u3066\u8aad\u307f\u8fbc\u3093\u3067\u304f\u3060\u3055\u3044 */\n`,
      language: 'plaintext',
      theme,
      automaticLayout: false,
      minimap: { enabled: true },
      fontSize: 14,
      wordWrap: 'on',
      inlineSuggest: { enabled: true },
    });

    const container = document.getElementById('editor');
    if (container) {
      _resizeObserver = new ResizeObserver(() => {
        if (_instance) _instance.layout();
      });
      _resizeObserver.observe(container);
    }

    _instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      document.dispatchEvent(new CustomEvent('editor-save'));
    });

    _instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      document.dispatchEvent(new CustomEvent('editor-toggle-inline-chat'));
    });

    registerProviders();
  }

  function dispose() {
    if (_resizeObserver) {
      _resizeObserver.disconnect();
      _resizeObserver = null;
    }
    if (_instance) {
      _instance.dispose();
      _instance = null;
    }
  }

  function registerProviders() {
    const languages = ['javascript', 'typescript', 'python', 'html', 'css', 'json', 'markdown', 'plaintext'];
    for (const lang of languages) {
      monaco.languages.registerInlineCompletionsProvider(lang, {
        // Defer to Monaco's built-in debouncing. Only our Copilot-like
        // provider needs explicit yielding behaviour so the editor still
        // shows other registered providers (e.g. word-based completions)
        // immediately when this provider is slow to respond.
        yieldsToGroupIds: ['monaco-word-based'],
        provideInlineCompletions: async (model, position, context, token) => {
          // Check cancellation before kicking off the network call so we
          // don't waste an API request for keystrokes that have already
          // been superseded.
          if (token.isCancellationRequested) return;

          try {
            const autocompleteContext = getAutocompleteContext(model, position);
            const data = await api('/api/code/autocomplete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code: autocompleteContext.code,
                line: autocompleteContext.line,
                column: autocompleteContext.column,
                fileName: state.activeFilePath ? state.activeFilePath.split(/[\\/]/).pop() : 'untitled',
                language: model.getLanguageId(),
                model: document.getElementById('codeModel')?.value,
                webSearch: document.getElementById('codeWebSearch')?.checked || false,
                numOfSite: document.getElementById('codeNumOfSite')?.value
                  ? parseInt(document.getElementById('codeNumOfSite').value)
                  : undefined,
                maxWord: document.getElementById('codeMaxWord')?.value
                  ? parseInt(document.getElementById('codeMaxWord').value)
                  : undefined,
              }),
              signal: token.signal,
            });
            if (!data.suggestion || token.isCancellationRequested) return;

            return {
              items: [
                {
                  insertText: data.suggestion,
                  range: new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column,
                  ),
                },
              ],
            };
          } catch (e) {
            if (e.name !== 'AbortError') console.error('Autocomplete error:', e);
          }
        },
        freeInlineCompletions: () => {},
      });
    }
  }

  function getOrCreateModel(filePath, content, language) {
    const fileUri = monaco.Uri.file(filePath);
    let model = monaco.editor.getModel(fileUri);
    if (model) {
      if (content !== undefined) model.setValue(content);
    } else {
      model = monaco.editor.createModel(content || '', language, fileUri);
    }
    return model;
  }

  function disposeUnusedModels() {
    if (!_instance) return;
    const allModels = monaco.editor.getModels();
    if (allModels.length > MAX_OPEN_MODELS) {
      const active = _instance.getModel();
      const openTabs = state.openTabs;
      const unused = allModels.filter(
        (m) => m !== active && !openTabs.includes(m.uri.fsPath) && m.uri.scheme === 'file',
      );
      for (const m of unused.slice(0, allModels.length - MAX_OPEN_MODELS)) {
        m.dispose();
      }
    }
  }

  function updateTheme() {
    if (_instance) {
      _instance.updateOptions({ theme: getTheme() });
    }
  }

  function getValue() {
    return _instance?.getValue() || '';
  }

  function getPosition() {
    return _instance?.getPosition() || { lineNumber: 1, column: 1 };
  }

  function getLanguageId() {
    return _instance?.getModel()?.getLanguageId() || 'plaintext';
  }

  function focus() {
    _instance?.focus();
  }

  function layout() {
    _instance?.layout();
  }

  function markClean(filePath) {
    const fileUri = monaco.Uri.file(filePath);
    const model = monaco.editor.getModel(fileUri);
    if (model) {
      state.originalVersions[filePath] = model.getAlternativeVersionId();
    }
  }

  function isDirty(filePath) {
    const fileUri = monaco.Uri.file(filePath);
    const model = monaco.editor.getModel(fileUri);
    if (!model) return false;
    const currentVersion = model.getAlternativeVersionId();
    const originalVersion = state.originalVersions[filePath];
    return originalVersion !== undefined && currentVersion !== originalVersion;
  }

  function isAnyDirty() {
    return state.openTabs.some((filePath) => isDirty(filePath));
  }

  return {
    init,
    dispose,
    getOrCreateModel,
    disposeUnusedModels,
    updateTheme,
    getValue,
    getPosition,
    getLanguageId,
    focus,
    layout,
    markClean,
    isDirty,
    isAnyDirty,
    get instance() {
      return _instance;
    },
  };
}
