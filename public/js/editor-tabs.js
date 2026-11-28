/**
 * Editor tab management module
 *
 * Handles multi-tab operations for the Monaco Editor: opening, closing,
 * switching between tabs, and saving files.
 */

import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

/**
 * Create the editor tab manager.
 * @param {object} editorState - Reference to state.editor
 * @param {object} editorManager - The editor manager instance
 * @param {object} dom - DOM element references
 * @param {{ setStatus?: (text: string, level?: string) => void }} [callbacks] - optional callbacks
 * @returns {{
 *   renderTabs: () => void,
 *   switchToTab: (filePath: string) => Promise<void>,
 *   closeTab: (filePath: string) => Promise<void>,
 *   closeTabInternal: (filePath: string) => void,
 *   openFile: (filePath: string) => Promise<void>,
 *   saveFile: () => Promise<void>,
 *   handlePathDeleted: (deletedPath: string) => void,
 *   handlePathRenamed: (oldPath: string, newPath: string) => void
 * }}
 */
export function createEditorTabManager(editorState, editorManager, dom, callbacks = {}) {
  const setStatus = typeof callbacks?.setStatus === 'function' ? callbacks.setStatus : null;
  let _saveStatusTimer = null;
  let _openFileSeq = 0;
  // Writes are chained per file: two Ctrl+S presses must reach the disk in the
  // order the user made them, otherwise the older content can land last and be
  // reported as saved.
  const _saveChains = new Map();

  function isReadOnly(filePath) {
    return Boolean(editorState.readOnlyFiles?.[filePath]);
  }

  function updateActiveFileUi(filePath) {
    const isFileReadOnly = isReadOnly(filePath);
    const fileName = filePath.replace(/\\/g, '/').split('/').pop();
    dom.currentFileName.textContent = isFileReadOnly ? `${fileName} (${t('file_read_only')})` : fileName;
    dom.currentFileName.title = isFileReadOnly ? `${filePath} (${t('file_read_only')})` : filePath;
    dom.saveFileBtn.disabled = isFileReadOnly;
    if (editorManager.instance) {
      editorManager.instance.updateOptions({ readOnly: isFileReadOnly });
    }
  }

  function renderTabs() {
    const container = dom.editorTabsBar;
    if (!container) return;
    container.textContent = '';

    editorState.openTabs.forEach((pathVal) => {
      const fileName = pathVal.replace(/\\/g, '/').split('/').pop();
      const tabEl = document.createElement('div');
      tabEl.className = `editor-tab ${pathVal === editorState.activeFilePath ? 'active' : ''}`;
      tabEl.title = pathVal;

      const nameSpan = document.createElement('button');
      nameSpan.type = 'button';
      nameSpan.className = 'editor-tab-button';
      nameSpan.textContent = fileName;
      nameSpan.onclick = () => {
        if (pathVal !== editorState.activeFilePath) {
          switchToTab(pathVal);
        }
      };
      tabEl.appendChild(nameSpan);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'close-tab-btn';
      closeBtn.setAttribute('aria-label', `${t('tab_close') || 'Close tab'}: ${fileName}`);
      closeBtn.textContent = '\u00d7';
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
      editorManager.instance.updateOptions({ readOnly: false });
      const blankUri = monaco.Uri.from({ scheme: 'inmemory', path: '/__blank__' });
      const blankModel =
        monaco.editor.getModel(blankUri) || monaco.editor.createModel('', 'plaintext', blankUri);
      blankModel.setValue('');
      editorManager.instance.setModel(blankModel);
    }
    dom.currentFileName.textContent = t('no_file_selected');
    dom.currentFileName.title = '';
    dom.saveFileBtn.disabled = true;
    document.querySelectorAll('.tree-node.file').forEach((x) => x.classList.remove('active'));
  }

  async function switchToTab(filePath) {
    try {
      const fileUri = monaco.Uri.file(filePath);
      const model = monaco.editor.getModel(fileUri);

      if (model) {
        ++_openFileSeq;
        if (editorManager.instance) {
          editorManager.instance.setModel(model);
          editorState.activeFilePath = filePath;
          updateActiveFileUi(filePath);

          document.querySelectorAll('.tree-node.file').forEach((x) => {
            x.classList.toggle('active', x.dataset.path === filePath);
          });
          renderTabs();
        }
      } else {
        await openFile(filePath);
      }
    } catch (e) {
      toast.error(t('tab_switch_failed', { error: e.message }));
      closeTabInternal(filePath);
    }
  }

  async function closeTab(filePath) {
    const tabIndex = editorState.openTabs.indexOf(filePath);
    if (tabIndex === -1) return;

    if (editorManager.isDirty(filePath)) {
      const accepted = await toast.confirm(t('tab_close_confirm'), {
        confirmText: t('btn_close'),
        cancelText: t('btn_cancel'),
        type: 'warning',
      });
      if (!accepted) return;
    }

    closeTabInternal(filePath);
  }

  function closeTabInternal(filePath) {
    const tabIndex = editorState.openTabs.indexOf(filePath);
    if (tabIndex === -1) return;

    editorState.openTabs.splice(tabIndex, 1);
    if (editorState.readOnlyFiles) {
      delete editorState.readOnlyFiles[filePath];
    }
    if (editorState.originalVersions) {
      delete editorState.originalVersions[filePath];
    }

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
    // An open tab already holds this file's buffer. Re-reading it would call
    // model.setValue(), which resets the undo stack and the cursor position of
    // the tab the user is switching to; switch to the model instead.
    if (editorState.openTabs.includes(filePath)) {
      await switchToTab(filePath);
      return;
    }
    const requestSeq = ++_openFileSeq;
    try {
      const data = await api(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
      if (requestSeq !== _openFileSeq) return;
      if (editorManager.instance) {
        const contentSize = data.content ? data.content.length : 0;
        const LARGE_FILE_THRESHOLD = 2 * 1024 * 1024; // 2MB
        if (contentSize > LARGE_FILE_THRESHOLD) {
          const accepted = await toast.confirm(
            t('file_size_warning', { size: (contentSize / 1024 / 1024).toFixed(1) }),
            {
              confirmText: t('btn_open_file'),
              cancelText: t('btn_cancel'),
              type: 'warning',
            },
          );
          if (!accepted || requestSeq !== _openFileSeq) return;
        }

        const model = editorManager.getOrCreateModel(filePath, data.content);
        editorManager.instance.setModel(model);
        editorManager.markClean(filePath);
        editorState.readOnlyFiles[filePath] = data.writable === false;

        if (!editorState.openTabs.includes(filePath)) {
          editorState.openTabs.push(filePath);
        }

        editorManager.disposeUnusedModels();

        editorState.activeFilePath = filePath;
        updateActiveFileUi(filePath);

        document.querySelectorAll('.tree-node.file').forEach((x) => {
          x.classList.toggle('active', x.dataset.path === filePath);
        });
        renderTabs();
      }
    } catch (e) {
      toast.error(t('file_load_failed', { error: e.message }));
    }
  }

  async function saveFile() {
    if (!editorState.activeFilePath || !editorManager.instance) return;
    if (isReadOnly(editorState.activeFilePath)) {
      toast.warning(t('file_read_only_save_blocked'));
      return;
    }
    // Capture the target path and the edit version before awaiting: the user
    // can switch tabs or keep typing while the write is in flight, and marking
    // the *then active* file (or the then current version) clean would drop
    // unsaved state that was never written.
    const targetPath = editorState.activeFilePath;
    const wasOpen = Boolean(editorState.openTabs?.includes?.(targetPath));
    const content = editorManager.instance.getValue();
    const savedVersionId = editorManager.instance.getModel()?.getAlternativeVersionId();
    try {
      if (setStatus) setStatus(t('saving'), 'warn');
      const previousWrite = _saveChains.get(targetPath) ?? Promise.resolve();
      const write = previousWrite
        .catch(() => {})
        .then(() =>
          api('/api/fs/write', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: targetPath, content }),
          }),
        );
      _saveChains.set(targetPath, write);
      try {
        await write;
      } finally {
        if (_saveChains.get(targetPath) === write) _saveChains.delete(targetPath);
      }
      if (wasOpen && !editorState.openTabs?.includes?.(targetPath)) {
        return;
      }
      editorManager.markClean(targetPath, savedVersionId);
      if (setStatus) setStatus(t('save_complete'), 'ok');
      toast.success(t('file_saved'));
      if (_saveStatusTimer) clearTimeout(_saveStatusTimer);
      _saveStatusTimer = setTimeout(() => {
        if (document.getElementById('status')?.textContent === t('save_complete')) {
          if (setStatus) setStatus(t('status_ready'));
        }
      }, 2000);
    } catch (e) {
      toast.error(t('file_save_failed', { error: e.message }));
    }
  }

  function stripTrailingSeps(targetPath) {
    if (targetPath === '/' || targetPath === '\\') return targetPath;
    return targetPath.replace(/[\\/]+$/, '');
  }

  function normalizePathForCompare(targetPath) {
    return stripTrailingSeps(String(targetPath || ''))
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
  }

  function matchesPathOrDescendant(candidatePath, basePath) {
    if (!candidatePath || !basePath) return false;
    if (candidatePath === basePath) return true;
    const normCand = normalizePathForCompare(candidatePath);
    const normBase = normalizePathForCompare(basePath);
    if (!normBase) return false;
    return normCand === normBase || normCand.startsWith(normBase + '/');
  }

  function computeRenamedPath(candidatePath, oldBase, newBase) {
    if (!candidatePath || !oldBase || !newBase) return null;
    if (candidatePath === oldBase) return newBase;
    const strippedCand = stripTrailingSeps(candidatePath);
    const strippedNew = stripTrailingSeps(newBase);
    const normCand = normalizePathForCompare(strippedCand);
    const normOld = normalizePathForCompare(oldBase);
    if (!normOld) return null;
    if (normCand === normOld) return strippedNew;
    if (!normCand.startsWith(normOld + '/')) return null;
    const suffix = strippedCand.slice(normOld.length);
    return strippedNew + suffix;
  }

  function handlePathDeleted(deletedPath) {
    if (!deletedPath || !Array.isArray(editorState.openTabs)) return;
    const affectedTabs = editorState.openTabs.filter((tabPath) =>
      matchesPathOrDescendant(tabPath, deletedPath),
    );
    for (const tabPath of affectedTabs) {
      closeTabInternal(tabPath);
    }
  }

  function handlePathRenamed(oldPath, newPath) {
    if (!oldPath || !newPath || oldPath === newPath || !Array.isArray(editorState.openTabs)) return;
    let changed = false;

    for (let i = 0; i < editorState.openTabs.length; i++) {
      const tabPath = editorState.openTabs[i];
      const updatedPath = computeRenamedPath(tabPath, oldPath, newPath);
      if (!updatedPath || updatedPath === tabPath) continue;

      changed = true;
      const existingIdx = editorState.openTabs.indexOf(updatedPath);
      if (existingIdx !== -1 && existingIdx !== i) {
        editorState.openTabs.splice(i, 1);
        i--;
      } else {
        editorState.openTabs[i] = updatedPath;
      }

      if (
        editorState.readOnlyFiles &&
        Object.prototype.hasOwnProperty.call(editorState.readOnlyFiles, tabPath)
      ) {
        editorState.readOnlyFiles[updatedPath] = editorState.readOnlyFiles[tabPath];
        delete editorState.readOnlyFiles[tabPath];
      }

      const wasDirty = editorManager.isDirty?.(tabPath) || false;
      const hasMonaco = typeof monaco !== 'undefined' && monaco?.Uri && monaco?.editor;
      let newModel = null;
      let oldModel = null;
      if (hasMonaco) {
        const oldUri = monaco.Uri.file(tabPath);
        oldModel = monaco.editor.getModel(oldUri);
        if (oldModel) {
          const content = oldModel.getValue();
          newModel = editorManager.getOrCreateModel
            ? editorManager.getOrCreateModel(updatedPath, content)
            : monaco.editor.createModel(content, undefined, monaco.Uri.file(updatedPath));
          if (newModel && newModel !== oldModel && newModel.getValue?.() !== content) {
            newModel.setValue(content);
          }
        }
      }

      if (editorState.activeFilePath === tabPath) {
        editorState.activeFilePath = updatedPath;
        if (editorManager.instance && newModel) {
          editorManager.instance.setModel(newModel);
        }
        updateActiveFileUi(updatedPath);
      }

      if (oldModel && oldModel !== newModel) {
        oldModel.dispose();
      }

      if (editorState.originalVersions) {
        delete editorState.originalVersions[tabPath];
      }
      if (wasDirty && newModel) {
        editorState.originalVersions ||= {};
        editorState.originalVersions[updatedPath] = -1;
      } else if (!wasDirty && newModel) {
        editorManager.markClean?.(updatedPath);
      }
    }

    if (changed) {
      renderTabs();
    }
  }

  return {
    renderTabs,
    switchToTab,
    closeTab,
    closeTabInternal,
    openFile,
    saveFile,
    handlePathDeleted,
    handlePathRenamed,
  };
}
