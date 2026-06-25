/**
 * Editor tab management module
 *
 * Handles multi-tab operations for the Monaco Editor: opening, closing,
 * switching between tabs, and saving files.
 */

import { api } from "./api.js";

/**
 * Create the editor tab manager.
 * @param {object} editorState - Reference to state.editor
 * @param {object} editorManager - The editor manager instance
 * @param {object} dom - DOM element references
 * @param {{ renderTabs: () => void }} callbacks - optional callbacks
 * @returns {{
 *   renderTabs: () => void,
 *   switchToTab: (filePath: string) => Promise<void>,
 *   closeTab: (filePath: string) => Promise<void>,
 *   closeTabInternal: (filePath: string) => void,
 *   openFile: (filePath: string) => Promise<void>,
 *   saveFile: () => Promise<void>
 * }}
 */
export function createEditorTabManager(editorState, editorManager, dom) {
  let _saveStatusTimer = null;

  function renderTabs() {
    const container = dom.editorTabsBar;
    if (!container) return;
    container.textContent = "";

    editorState.openTabs.forEach((pathVal) => {
      const fileName = pathVal.replace(/\\/g, "/").split("/").pop();
      const tabEl = document.createElement("div");
      tabEl.className = `editor-tab ${pathVal === editorState.activeFilePath ? "active" : ""}`;
      tabEl.title = pathVal;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = fileName;
      nameSpan.onclick = () => {
        if (pathVal !== editorState.activeFilePath) {
          switchToTab(pathVal);
        }
      };
      tabEl.appendChild(nameSpan);

      const closeBtn = document.createElement("span");
      closeBtn.className = "close-tab-btn";
      closeBtn.textContent = "\u00d7";
      closeBtn.onclick = (e) => {
        e.stopPropagation();
        closeTab(pathVal);
      };
      tabEl.appendChild(closeBtn);

      container.appendChild(tabEl);
    });
  }

  function resetEditorToBlank() {
    editorState.activeFilePath = null;
    if (editorManager.instance) {
      editorManager.instance.setModel(monaco.editor.createModel("", "plaintext"));
    }
    dom.currentFileName.textContent = "ファイルが選択されていません";
    dom.currentFileName.title = "";
    dom.saveFileBtn.disabled = true;
    document.querySelectorAll(".tree-node.file").forEach((x) => x.classList.remove("active"));
  }

  async function switchToTab(filePath) {
    try {
      const model = editorManager.getOrCreateModel(filePath);

      if (model) {
        if (editorManager.instance) {
          editorManager.instance.setModel(model);
          editorState.activeFilePath = filePath;
          dom.currentFileName.textContent = filePath.replace(/\\/g, "/").split("/").pop();
          dom.currentFileName.title = filePath;
          dom.saveFileBtn.disabled = false;

          document.querySelectorAll(".tree-node.file").forEach((x) => {
            x.classList.toggle("active", x.dataset.path === filePath);
          });
          renderTabs();
        }
      } else {
        await openFile(filePath);
      }
    } catch (e) {
      toast.error(`タブ切替に失敗しました: ${e.message}`);
      closeTabInternal(filePath);
    }
  }

  async function closeTab(filePath) {
    const tabIndex = editorState.openTabs.indexOf(filePath);
    if (tabIndex === -1) return;

    const accepted = await toast.confirm("タブを閉じますか？未保存の変更は失われます。", {
      confirmText: "閉じる",
      cancelText: "キャンセル",
      type: "warning",
    });
    if (!accepted) return;

    closeTabInternal(filePath);
  }

  function closeTabInternal(filePath) {
    const tabIndex = editorState.openTabs.indexOf(filePath);
    if (tabIndex === -1) return;

    editorState.openTabs.splice(tabIndex, 1);

    const fileUri = monaco.Uri.file(filePath);
    const model = monaco.editor.getModel(fileUri);
    if (model) {
      model.dispose();
    }

    if (editorState.activeFilePath === filePath) {
      if (editorState.openTabs.length > 0) {
        const nextActivePath = editorState.openTabs[Math.min(tabIndex, editorState.openTabs.length - 1)];

        (async () => {
          try {
            await switchToTab(nextActivePath);
          } catch {
            resetEditorToBlank();
          }
        })().catch(() => {}); // #12: prevent unhandled rejection from resetEditorToBlank
      } else {
        resetEditorToBlank();
      }
    }
    renderTabs();
  }

  async function openFile(filePath) {
    try {
      const data = await api(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      if (editorManager.instance) {
        const contentSize = data.content ? data.content.length : 0;
        const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2MB
        if (contentSize > LARGE_FILE_THRESHOLD) {
          const accepted = await toast.confirm(
            `ファイルサイズが大きいため（約 ${(contentSize / 1024 / 1024).toFixed(1)} MB）、エディタの動作が遅くなる可能性があります。開きますか？`,
            {
              confirmText: "開く",
              cancelText: "キャンセル",
              type: "warning",
            },
          );
          if (!accepted) return;
        }

        const model = editorManager.getOrCreateModel(filePath, data.content);
        editorManager.instance.setModel(model);

        if (!editorState.openTabs.includes(filePath)) {
          editorState.openTabs.push(filePath);
        }

        editorManager.disposeUnusedModels();

        editorState.activeFilePath = filePath;
        dom.currentFileName.textContent = filePath.replace(/\\/g, "/").split("/").pop();
        dom.currentFileName.title = filePath;
        dom.saveFileBtn.disabled = false;

        document.querySelectorAll(".tree-node.file").forEach((x) => {
          x.classList.toggle("active", x.dataset.path === filePath);
        });
        renderTabs();
      }
    } catch (e) {
      toast.error(`ファイルの読み込みに失敗しました: ${e.message}`);
    }
  }

  async function saveFile() {
    if (!editorState.activeFilePath || !editorManager.instance) return;
    const content = editorManager.instance.getValue();
    const setStatus = window.__bootstrapSetStatus;
    try {
      if (setStatus) setStatus("保存中...", "warn");
      await api("/api/fs/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: editorState.activeFilePath, content }),
      });
      if (setStatus) setStatus("保存完了", "ok");
      toast.success("ファイルを保存しました");
      if (_saveStatusTimer) clearTimeout(_saveStatusTimer);
      _saveStatusTimer = setTimeout(() => {
        if (document.getElementById("status")?.textContent === "保存完了") {
          if (setStatus) setStatus("準備完了");
        }
      }, 2000);
    } catch (e) {
      toast.error(`ファイルの保存に失敗しました: ${e.message}`);
    }
  }

  return {
    renderTabs,
    switchToTab,
    closeTab,
    closeTabInternal,
    openFile,
    saveFile,
  };
}
