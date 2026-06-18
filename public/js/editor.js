/**
 * Monaco Editor management module
 */

import { api } from "./api.js";
import { isDarkTheme } from "./theme.js";

const MAX_OPEN_MODELS = 20;

export function createEditorState() {
  return {
    activeFilePath: null,
    openTabs: [],
    isInlineChatOpen: false,
    inlineChatDom: null,
  };
}

export function createEditorManager(state) {
  let _instance = null;
  let _resizeObserver = null;

  function init() {
    const isDark = isDarkTheme();

    _instance = monaco.editor.create(document.getElementById("editor"), {
      value: `/* \u2b05 \u5de6\u306e\u30c4\u30ea\u30fc\u304b\u3089\u30d5\u30a1\u30a4\u30eb\u3092\u9078\u629e\u3059\u308b\u304b\u3001\u30d1\u30b9\u3092\u5165\u529b\u3057\u3066\u8aad\u307f\u8fbc\u3093\u3067\u304f\u3060\u3055\u3044 */\n`,
      language: "plaintext",
      theme: isDark ? "vs-dark" : "vs",
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 14,
      wordWrap: "on",
      inlineSuggest: { enabled: true },
    });

    const container = document.getElementById("editor");
    if (container) {
      _resizeObserver = new ResizeObserver(() => {
        if (_instance) _instance.layout();
      });
      _resizeObserver.observe(container);
    }

    _instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (typeof saveFile === "function") saveFile();
    });

    _instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
      if (typeof toggleInlineChat === "function") toggleInlineChat();
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
    const languages = [
      "javascript",
      "typescript",
      "python",
      "html",
      "css",
      "json",
      "markdown",
      "plaintext",
    ];
    for (const lang of languages) {
      monaco.languages.registerInlineCompletionsProvider(lang, {
        provideInlineCompletions: async (model, position, context, token) => {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (token.isCancellationRequested) return;

          try {
            const data = await api("/api/code/autocomplete", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                code: model.getValue(),
                line: position.lineNumber,
                column: position.column,
                fileName: state.activeFilePath
                  ? state.activeFilePath.split(/[\\/]/).pop()
                  : "untitled",
                language: model.getLanguageId(),
                model: document.getElementById("codeModel")?.value,
                webSearch: document.getElementById("codeWebSearch")?.checked || false,
                numOfSite: document.getElementById("codeNumOfSite")?.value
                  ? parseInt(document.getElementById("codeNumOfSite").value)
                  : undefined,
                maxWord: document.getElementById("codeMaxWord")?.value
                  ? parseInt(document.getElementById("codeMaxWord").value)
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
            if (e.name !== "AbortError") console.error("Autocomplete error:", e);
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
      model = monaco.editor.createModel(content || "", language, fileUri);
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
        (m) => m !== active && !openTabs.includes(m.uri.fsPath) && m.uri.scheme === "file",
      );
      for (const m of unused.slice(0, allModels.length - MAX_OPEN_MODELS)) {
        m.dispose();
      }
    }
  }

  function updateTheme() {
    if (_instance) {
      _instance.updateOptions({ theme: isDarkTheme() ? "vs-dark" : "vs" });
    }
  }

  function getValue() {
    return _instance?.getValue() || "";
  }

  function getPosition() {
    return _instance?.getPosition() || { lineNumber: 1, column: 1 };
  }

  function getLanguageId() {
    return _instance?.getModel()?.getLanguageId() || "plaintext";
  }

  function focus() {
    _instance?.focus();
  }

  function layout() {
    _instance?.layout();
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
    get instance() { return _instance; },
  };
}
