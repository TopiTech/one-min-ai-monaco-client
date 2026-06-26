function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function getSafeModelUris(filePath) {
  const baseName =
    filePath
      .split(/[\\/]/)
      .pop()
      .replace(/[^a-zA-Z0-9_.-]/g, '_') || 'file';

  const safePath = '/' + baseName;
  return {
    originalUri: monaco.Uri.from({ scheme: 'diff-original', path: safePath }),
    modifiedUri: monaco.Uri.from({ scheme: 'diff-modified', path: safePath }),
  };
}

async function ensureDiffLayout(container, diffEditor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await nextFrame();
    const rect = container.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      diffEditor.layout();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  diffEditor.layout();
}

export function createDiffDialog({ t, getToast, getThemeName }) {
  let diffEditor = null;
  let resizeObserver = null;

  function syncTheme() {
    if (diffEditor) {
      diffEditor.updateOptions({ theme: getThemeName() });
    }
  }

  async function showDiffDialog(filePath, oldContent, newContent) {
    try {
      const modal = document.getElementById('diffModal');
      const container = document.getElementById('diffEditorContainer');
      const pathLabel = document.getElementById('diffFilePath');
      const inlineToggle = document.getElementById('diffInlineToggle');
      const applyButton = document.getElementById('diffApply');
      const cancelButton = document.getElementById('diffCancel');

      if (!modal || !container || !pathLabel || !applyButton || !cancelButton) {
        return false;
      }

      pathLabel.textContent = t('diff_file_label', { path: filePath });
      modal.classList.remove('u-hidden');
      modal.classList.remove('is-hidden');

      const isInline = localStorage.getItem('diffRenderInline') === 'true';
      if (inlineToggle) {
        inlineToggle.checked = isInline;
        inlineToggle.onchange = (e) => {
          const inline = e.target.checked;
          localStorage.setItem('diffRenderInline', String(inline));
          if (diffEditor) {
            diffEditor.updateOptions({ renderSideBySide: !inline });
            diffEditor.layout();
          }
        };
      }

      if (!diffEditor) {
        diffEditor = monaco.editor.createDiffEditor(container, {
          theme: getThemeName(),
          automaticLayout: false,
          readOnly: true,
          renderSideBySide: !isInline,
          scrollBeyondLastLine: false,
        });
      } else {
        diffEditor.updateOptions({
          theme: getThemeName(),
          renderSideBySide: !isInline,
        });
      }

      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        container.style.minHeight = '420px';
      }

      const { originalUri, modifiedUri } = getSafeModelUris(filePath);

      let originalModel = monaco.editor.getModel(originalUri);
      if (originalModel) originalModel.dispose();
      let modifiedModel = monaco.editor.getModel(modifiedUri);
      if (modifiedModel) modifiedModel.dispose();

      originalModel = monaco.editor.createModel(oldContent, undefined, originalUri);
      modifiedModel = monaco.editor.createModel(newContent, undefined, modifiedUri);
      diffEditor.setModel({ original: originalModel, modified: modifiedModel });

      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        if (diffEditor && modal.offsetParent !== null) {
          diffEditor.layout();
        }
      });
      resizeObserver.observe(container);

      await nextFrame();
      await ensureDiffLayout(container, diffEditor);
      setTimeout(() => {
        if (diffEditor && modal.offsetParent !== null) {
          diffEditor.layout();
        }
      }, 200);

      return await new Promise((resolve) => {
        let settled = false;

        const cleanup = (accepted) => {
          if (settled) return;
          settled = true;
          resizeObserver?.disconnect();
          resizeObserver = null;
          modal.classList.add('u-hidden');
          modal.classList.add('is-hidden');
          modal.removeEventListener('click', onBackdropClick);
          document.removeEventListener('keydown', onKey);
          applyButton.onclick = null;
          cancelButton.onclick = null;
          if (inlineToggle) inlineToggle.onchange = null;
          if (diffEditor) diffEditor.setModel(null);
          originalModel.dispose();
          modifiedModel.dispose();
          resolve(accepted);
        };

        const onKey = (e) => {
          if (e.key === 'Escape' && !modal.classList.contains('u-hidden')) {
            cleanup(false);
          }
        };

        const onBackdropClick = (e) => {
          if (e.target === modal) {
            cleanup(false);
          }
        };

        applyButton.onclick = () => cleanup(true);
        cancelButton.onclick = () => cleanup(false);
        document.addEventListener('keydown', onKey);
        modal.addEventListener('click', onBackdropClick);
      });
    } catch (error) {
      console.error('showDiffDialog error:', error);
      getToast()?.error(`${t('diff_error')}${error.message}`);
      document.getElementById('diffModal')?.classList.add('u-hidden');
      document.getElementById('diffModal')?.classList.add('is-hidden');
      return false;
    }
  }

  return { showDiffDialog, syncTheme };
}
