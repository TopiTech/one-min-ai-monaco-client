/**
 * Editor Toolbar module
 *
 * Provides an enhanced toolbar above the Monaco editor with:
 * - Cursor position display (Ln/Col)
 * - Language badge (click to change)
 * - Word wrap toggle
 * - Minimap toggle
 * - Format document
 * - Font size adjustment
 * - Code Run panel (run current file / selection)
 */

import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

const STORAGE_KEY_FONT = 'monaco_client_font_size';
const STORAGE_KEY_WRAP = 'monaco_client_word_wrap';
const STORAGE_KEY_MINIMAP = 'monaco_client_minimap';
const STORAGE_KEY_TAB_SIZE = 'monaco_client_tab_size';
const DEFAULT_FONT_SIZE = 14;

let _editorManager = null;
let _editorState = null;
let _outputVisible = false;

/** Attach toolbar to the already-initialized Monaco instance */
export function initEditorToolbar(editorManager, editorState) {
  _editorManager = editorManager;
  _editorState = editorState;

  // Restore persisted preferences
  const savedFontSize = parseInt(localStorage.getItem(STORAGE_KEY_FONT) || String(DEFAULT_FONT_SIZE), 10);
  const savedWrap = localStorage.getItem(STORAGE_KEY_WRAP) !== 'off';
  const savedMinimap = localStorage.getItem(STORAGE_KEY_MINIMAP) !== 'false';
  const savedTabSize = parseInt(localStorage.getItem(STORAGE_KEY_TAB_SIZE) || '2', 10);

  const instance = editorManager.instance;
  if (instance) {
    instance.updateOptions({
      fontSize: savedFontSize,
      wordWrap: savedWrap ? 'on' : 'off',
      minimap: { enabled: savedMinimap },
      tabSize: savedTabSize,
      insertSpaces: true,
    });
  }

  _bindToolbarButtons(savedFontSize, savedWrap, savedMinimap, savedTabSize);
  _bindCursorPositionUpdate();
  _bindLanguageBadge();
  _bindRunPanel();
}

/** Called after theme changes to keep toolbar state in sync */
export function syncToolbarTheme() {
  // Future: adjust any custom colors if needed
}

// ─────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────

function _bindToolbarButtons(fontSize, wordWrap, minimapOn, tabSize) {
  // Format
  const fmtBtn = document.getElementById('toolbarFormat');
  if (fmtBtn) {
    fmtBtn.onclick = () => {
      const instance = _editorManager?.instance;
      if (!instance) return;
      instance.getAction('editor.action.formatDocument')?.run();
    };
  }

  // Word wrap toggle
  const wrapBtn = document.getElementById('toolbarWrap');
  let _wrapOn = wordWrap;
  const _syncWrapBtn = () => {
    if (wrapBtn) {
      wrapBtn.classList.toggle('is-active', _wrapOn);
      wrapBtn.title = _wrapOn ? t('toolbar_wrap_off') : t('toolbar_wrap_on');
    }
  };
  _syncWrapBtn();
  if (wrapBtn) {
    wrapBtn.onclick = () => {
      _wrapOn = !_wrapOn;
      _editorManager?.instance?.updateOptions({ wordWrap: _wrapOn ? 'on' : 'off' });
      localStorage.setItem(STORAGE_KEY_WRAP, _wrapOn ? 'on' : 'off');
      _syncWrapBtn();
    };
  }

  // Minimap toggle
  const mapBtn = document.getElementById('toolbarMinimap');
  let _minimapOn = minimapOn;
  const _syncMapBtn = () => {
    if (mapBtn) {
      mapBtn.classList.toggle('is-active', _minimapOn);
      mapBtn.title = _minimapOn ? t('toolbar_minimap_off') : t('toolbar_minimap_on');
    }
  };
  _syncMapBtn();
  if (mapBtn) {
    mapBtn.onclick = () => {
      _minimapOn = !_minimapOn;
      _editorManager?.instance?.updateOptions({ minimap: { enabled: _minimapOn } });
      localStorage.setItem(STORAGE_KEY_MINIMAP, String(_minimapOn));
      _syncMapBtn();
    };
  }

  // Font size decrease
  let _fontSize = fontSize;
  const fontDisplay = document.getElementById('toolbarFontSize');
  const _syncFont = () => {
    if (fontDisplay) fontDisplay.textContent = _fontSize + 'px';
    _editorManager?.instance?.updateOptions({ fontSize: _fontSize });
    localStorage.setItem(STORAGE_KEY_FONT, String(_fontSize));
  };

  const fontDecBtn = document.getElementById('toolbarFontDec');
  if (fontDecBtn) {
    fontDecBtn.onclick = () => {
      if (_fontSize > 8) {
        _fontSize--;
        _syncFont();
      }
    };
  }
  const fontIncBtn = document.getElementById('toolbarFontInc');
  if (fontIncBtn) {
    fontIncBtn.onclick = () => {
      if (_fontSize < 32) {
        _fontSize++;
        _syncFont();
      }
    };
  }

  // Tab size selector
  let _tabSize = tabSize;
  const tabBtn2 = document.getElementById('toolbarTab2');
  const tabBtn4 = document.getElementById('toolbarTab4');
  const _syncTabBtns = () => {
    if (tabBtn2) tabBtn2.classList.toggle('is-active', _tabSize === 2);
    if (tabBtn4) tabBtn4.classList.toggle('is-active', _tabSize === 4);
  };
  _syncTabBtns();
  if (tabBtn2) {
    tabBtn2.onclick = () => {
      _tabSize = 2;
      _editorManager?.instance?.updateOptions({ tabSize: 2 });
      localStorage.setItem(STORAGE_KEY_TAB_SIZE, '2');
      _syncTabBtns();
    };
  }
  if (tabBtn4) {
    tabBtn4.onclick = () => {
      _tabSize = 4;
      _editorManager?.instance?.updateOptions({ tabSize: 4 });
      localStorage.setItem(STORAGE_KEY_TAB_SIZE, '4');
      _syncTabBtns();
    };
  }

  // Go to line
  const gotoLineBtn = document.getElementById('toolbarGotoLine');
  if (gotoLineBtn) {
    gotoLineBtn.onclick = () => {
      const instance = _editorManager?.instance;
      if (instance) {
        instance.focus();
        instance.getAction('editor.action.gotoLine')?.run();
      }
    };
  }
}

function _bindCursorPositionUpdate() {
  const posEl = document.getElementById('toolbarCursorPos');
  const instance = _editorManager?.instance;
  if (!instance || !posEl) return;

  const update = () => {
    const pos = instance.getPosition();
    if (pos) posEl.textContent = `${pos.lineNumber}:${pos.column}`;
  };

  update();
  instance.onDidChangeCursorPosition(update);
}

function _bindLanguageBadge() {
  const badge = document.getElementById('toolbarLangBadge');
  const instance = _editorManager?.instance;
  if (!instance || !badge) return;

  const update = () => {
    const langId = instance.getModel()?.getLanguageId() || 'plaintext';
    badge.textContent = langId;
  };

  update();
  instance.onDidChangeModel(update);
  instance.onDidChangeModelLanguage(update);

  badge.onclick = () => {
    const instance = _editorManager?.instance;
    if (!instance) return;
    instance.focus();
    instance.getAction('editor.action.changeLanguageMode')?.run();
  };
}

function _bindRunPanel() {
  const runBtn = document.getElementById('toolbarRun');
  const clearOutputBtn = document.getElementById('clearOutputBtn');
  const toggleOutputBtn = document.getElementById('toggleOutputBtn');
  const outputPanel = document.getElementById('codeOutputPanel');
  const outputContent = document.getElementById('codeOutputContent');
  const outputStatus = document.getElementById('codeOutputStatus');

  if (toggleOutputBtn && outputPanel) {
    toggleOutputBtn.onclick = () => {
      _outputVisible = !_outputVisible;
      outputPanel.classList.toggle('is-visible', _outputVisible);
      toggleOutputBtn.classList.toggle('is-active', _outputVisible);
      // Relayout editor after panel toggles
      setTimeout(() => _editorManager?.layout(), 150);
    };
  }

  if (clearOutputBtn && outputContent) {
    clearOutputBtn.onclick = () => {
      outputContent.textContent = '';
      if (outputStatus) outputStatus.textContent = '';
    };
  }

  if (runBtn) {
    runBtn.onclick = () => _runCurrentFile();
  }
}

async function _runCurrentFile() {
  const filePath = _editorState?.activeFilePath;
  const instance = _editorManager?.instance;
  if (!instance) {
    toast.warning(t('run_no_editor'));
    return;
  }
  if (!filePath) {
    toast.warning(t('run_no_file'));
    return;
  }

  const outputPanel = document.getElementById('codeOutputPanel');
  const outputContent = document.getElementById('codeOutputContent');
  const outputStatus = document.getElementById('codeOutputStatus');
  const runBtn = document.getElementById('toolbarRun');

  // Show output panel
  _outputVisible = true;
  outputPanel?.classList.add('is-visible');
  document.getElementById('toggleOutputBtn')?.classList.add('is-active');
  setTimeout(() => _editorManager?.layout(), 150);

  if (outputContent) outputContent.textContent = '';
  if (outputStatus) {
    outputStatus.textContent = t('run_running');
    outputStatus.className = 'code-output-status running';
  }
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.classList.add('is-running');
  }

  const startTime = Date.now();

  try {
    const code = instance.getValue();
    const langId = instance.getModel()?.getLanguageId() || 'plaintext';
    const ext = filePath.split('.').pop().toLowerCase();

    const res = await api('/api/code/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filePath,
        code,
        language: langId,
        extension: ext,
      }),
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    if (outputContent) {
      outputContent.textContent = res.output || res.stdout || '(出力なし)';
      if (res.stderr) {
        outputContent.textContent += '\n\n--- stderr ---\n' + res.stderr;
      }
    }
    if (outputStatus) {
      const exitCode = res.exitCode ?? 0;
      outputStatus.textContent =
        exitCode === 0
          ? t('run_success', { time: elapsed })
          : t('run_failed', { code: exitCode, time: elapsed });
      outputStatus.className = `code-output-status ${exitCode === 0 ? 'ok' : 'err'}`;
    }
  } catch (e) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    if (outputContent) outputContent.textContent = e.message || String(e);
    if (outputStatus) {
      outputStatus.textContent = t('run_error', { time: elapsed });
      outputStatus.className = 'code-output-status err';
    }
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.classList.remove('is-running');
    }
  }
}
