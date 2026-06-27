import { toast } from './toast.js';

const DIFF_MODEL_SCHEME = 'diff-preview';
const DIFF_LAYOUT_RETRY_COUNT = 8;
const DIFF_LAYOUT_RETRY_DELAY_MS = 50;

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getSafeModelUris(filePath) {
  const baseName =
    filePath
      .split(/[\\/]/)
      .pop()
      ?.replace(/[^a-zA-Z0-9_.-]/g, '_') || 'file';
  const uniqueId = `${baseName}-${hashString(filePath)}`;
  const safePath = `/${uniqueId}`;

  return {
    originalUri: monaco.Uri.from({ scheme: DIFF_MODEL_SCHEME, path: `${safePath}/original` }),
    modifiedUri: monaco.Uri.from({ scheme: DIFF_MODEL_SCHEME, path: `${safePath}/modified` }),
  };
}

function setModalVisible(modal, visible) {
  modal.classList.toggle('u-hidden', !visible);
  modal.classList.toggle('is-hidden', !visible);
}

function disposeModel(model) {
  if (!model) return;
  try {
    model.dispose();
  } catch {
    // Ignore disposal races when the model was already released elsewhere.
  }
}

async function waitForDiffLayout(container, diffEditor) {
  for (let attempt = 0; attempt < DIFF_LAYOUT_RETRY_COUNT; attempt++) {
    await nextFrame();
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      diffEditor.layout();
      return true;
    }
    if (attempt < DIFF_LAYOUT_RETRY_COUNT - 1) {
      await wait(DIFF_LAYOUT_RETRY_DELAY_MS);
    }
  }

  diffEditor.layout();
  return false;
}

export function createDiffDialog({ t, getThemeName }) {
  let diffEditor = null;
  let resizeObserver = null;
  let activeModels = { original: null, modified: null };

  function disconnectResizeObserver() {
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  function disposeActiveModels() {
    disposeModel(activeModels.original);
    disposeModel(activeModels.modified);
    activeModels = { original: null, modified: null };
  }

  function syncTheme() {
    const theme = getThemeName();
    if (typeof monaco.editor.setTheme === 'function') {
      monaco.editor.setTheme(theme);
    }
    diffEditor?.layout();
  }

  async function showDiffDialog(filePath, oldContent, newContent) {
    let modal = null;
    let container = null;
    let pathLabel = null;
    let inlineToggle = null;
    let applyButton = null;
    let cancelButton = null;
    let originalModel = null;
    let modifiedModel = null;
    let fallbackLayoutTimer = null;
    let onKeyDown = null;
    let onBackdropClick = null;
    let cleanupSession = () => {};

    try {
      modal = document.getElementById('diffModal');
      container = document.getElementById('diffEditorContainer');
      pathLabel = document.getElementById('diffFilePath');
      inlineToggle = document.getElementById('diffInlineToggle');
      applyButton = document.getElementById('diffApply');
      cancelButton = document.getElementById('diffCancel');

      if (!modal || !container || !pathLabel || !applyButton || !cancelButton) {
        return false;
      }

      const theme = getThemeName();
      if (typeof monaco.editor.setTheme === 'function') {
        monaco.editor.setTheme(theme);
      }

      pathLabel.textContent = t('diff_file_label', { path: filePath });
      setModalVisible(modal, true);

      const isInline = localStorage.getItem('diffRenderInline') === 'true';
      if (inlineToggle) {
        inlineToggle.checked = isInline;
      }

      if (!diffEditor) {
        diffEditor = monaco.editor.createDiffEditor(container, {
          theme,
          readOnly: true,
          renderSideBySide: !isInline,
          scrollBeyondLastLine: false,
          automaticLayout: false,
          minimap: { enabled: false },
        });
      } else {
        diffEditor.updateOptions({
          readOnly: true,
          renderSideBySide: !isInline,
        });
      }

      disposeActiveModels();
      const { originalUri, modifiedUri } = getSafeModelUris(filePath);
      originalModel = monaco.editor.createModel(oldContent ?? '', undefined, originalUri);
      modifiedModel = monaco.editor.createModel(newContent ?? '', undefined, modifiedUri);
      activeModels = { original: originalModel, modified: modifiedModel };
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });

      if (!container.getBoundingClientRect().width || !container.getBoundingClientRect().height) {
        container.style.minHeight = '420px';
      } else {
        container.style.minHeight = '';
      }

      disconnectResizeObserver();
      resizeObserver = new ResizeObserver(() => {
        if (modal && !modal.classList.contains('u-hidden')) {
          diffEditor?.layout();
        }
      });
      resizeObserver.observe(container);

      await waitForDiffLayout(container, diffEditor);

      fallbackLayoutTimer = window.setTimeout(() => {
        if (modal && !modal.classList.contains('u-hidden')) {
          diffEditor?.layout();
        }
      }, 200);

      cleanupSession = () => {
        if (fallbackLayoutTimer !== null) {
          clearTimeout(fallbackLayoutTimer);
          fallbackLayoutTimer = null;
        }

        disconnectResizeObserver();

        if (diffEditor) {
          diffEditor.setModel(null);
        }

        disposeActiveModels();

        if (modal) {
          setModalVisible(modal, false);
        }

        if (inlineToggle) {
          inlineToggle.onchange = null;
        }
        if (applyButton) {
          applyButton.onclick = null;
        }
        if (cancelButton) {
          cancelButton.onclick = null;
        }
        if (modal && onBackdropClick) {
          modal.removeEventListener('click', onBackdropClick);
        }
        if (onKeyDown) {
          document.removeEventListener('keydown', onKeyDown);
        }

        if (container) {
          container.style.minHeight = '';
        }
      };

      return await new Promise((resolve) => {
        let settled = false;

        const settle = (accepted) => {
          if (settled) return;
          settled = true;
          cleanupSession();
          resolve(accepted);
        };

        onKeyDown = (event) => {
          if (event.key === 'Escape' && modal && !modal.classList.contains('u-hidden')) {
            settle(false);
          }
        };

        onBackdropClick = (event) => {
          if (event.target === modal) {
            settle(false);
          }
        };

        if (inlineToggle) {
          inlineToggle.onchange = (event) => {
            const inline = event.target.checked;
            localStorage.setItem('diffRenderInline', String(inline));
            if (diffEditor) {
              diffEditor.updateOptions({ renderSideBySide: !inline });
              diffEditor.layout();
            }
          };
        }

        applyButton.onclick = () => settle(true);
        cancelButton.onclick = () => settle(false);
        document.addEventListener('keydown', onKeyDown);
        modal.addEventListener('click', onBackdropClick);
      });
    } catch (error) {
      cleanupSession();
      console.error('showDiffDialog error:', error);
      toast.error(`${t('diff_error')}${error.message}`);
      modal?.classList.add('u-hidden');
      modal?.classList.add('is-hidden');
      return false;
    }
  }

  return { showDiffDialog, syncTheme };
}
