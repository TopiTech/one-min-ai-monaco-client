/**
 * Settings management module
 * Handles localStorage persistence for user preferences
 */

import { t } from './i18n.js';
import { api } from './api.js';

const STORAGE_KEYS = {
  WEB_SEARCH: 'monaco_client_code_web_search',
  NUM_OF_SITE: 'monaco_client_code_num_of_site',
  MAX_WORD: 'monaco_client_code_max_word',
  CHAT_WEB_SEARCH: 'monaco_client_chat_web_search',
  CHAT_NUM_OF_SITE: 'monaco_client_chat_num_of_site',
  CHAT_MAX_WORD: 'monaco_client_chat_max_word',
};

const LOCAL_STORAGE_KEYS = [
  ...Object.values(STORAGE_KEYS),
  'monaco_client_conversation',
  'monaco_client_credit_saving',
  'monaco_client_perf_mode',
  'monaco_client_theme',
  'diffRenderInline',
];

function getNumberInRange(value, min, max, defaultValue) {
  const num = parseInt(value);
  if (isNaN(num)) return defaultValue;
  if (num < min) return min;
  if (num > max) return max;
  return num;
}

function initCodeGeneratorSettings() {
  const wsInput = document.getElementById('codeWebSearch');
  const nosInput = document.getElementById('codeNumOfSite');
  const mwInput = document.getElementById('codeMaxWord');

  if (!wsInput || !nosInput || !mwInput) return;

  const savedWebSearch = localStorage.getItem(STORAGE_KEYS.WEB_SEARCH);
  if (savedWebSearch !== null) wsInput.checked = savedWebSearch === 'true';

  const savedNumOfSite = localStorage.getItem(STORAGE_KEYS.NUM_OF_SITE);
  if (savedNumOfSite !== null) nosInput.value = savedNumOfSite;

  const savedMaxWord = localStorage.getItem(STORAGE_KEYS.MAX_WORD);
  if (savedMaxWord !== null) mwInput.value = savedMaxWord;

  wsInput.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEYS.WEB_SEARCH, wsInput.checked);
  });

  nosInput.addEventListener('change', () => {
    nosInput.value = getNumberInRange(nosInput.value, 1, 10, 3);
    localStorage.setItem(STORAGE_KEYS.NUM_OF_SITE, nosInput.value);
  });

  mwInput.addEventListener('change', () => {
    mwInput.value = getNumberInRange(mwInput.value, 100, 10000, 1000);
    localStorage.setItem(STORAGE_KEYS.MAX_WORD, mwInput.value);
  });
}

function initChatSettings() {
  const wsInput = document.getElementById('webSearch');
  const nosInput = document.getElementById('chatNumOfSite');
  const mwInput = document.getElementById('chatMaxWord');
  const settingsBox = document.getElementById('chatWebSearchSettings');

  if (!wsInput || !nosInput || !mwInput || !settingsBox) return;

  const updateVisibility = () => {
    settingsBox.classList.toggle('is-shown', wsInput.checked);
  };

  const savedWebSearch = localStorage.getItem(STORAGE_KEYS.CHAT_WEB_SEARCH);
  if (savedWebSearch !== null) wsInput.checked = savedWebSearch === 'true';

  const savedNumOfSite = localStorage.getItem(STORAGE_KEYS.CHAT_NUM_OF_SITE);
  if (savedNumOfSite !== null) nosInput.value = savedNumOfSite;

  const savedMaxWord = localStorage.getItem(STORAGE_KEYS.CHAT_MAX_WORD);
  if (savedMaxWord !== null) mwInput.value = savedMaxWord;

  updateVisibility();

  wsInput.addEventListener('change', () => {
    localStorage.setItem(STORAGE_KEYS.CHAT_WEB_SEARCH, wsInput.checked);
    updateVisibility();
  });

  nosInput.addEventListener('change', () => {
    nosInput.value = getNumberInRange(nosInput.value, 1, 10, 3);
    localStorage.setItem(STORAGE_KEYS.CHAT_NUM_OF_SITE, nosInput.value);
  });

  mwInput.addEventListener('change', () => {
    mwInput.value = getNumberInRange(mwInput.value, 100, 10000, 1000);
    localStorage.setItem(STORAGE_KEYS.CHAT_MAX_WORD, mwInput.value);
  });
}

function initPerformanceModeSettings() {
  const perfToggle = document.getElementById('perfModeToggle');
  const mobilePerfToggle = document.getElementById('mobilePerfModeToggle');

  const updatePerfMode = (isEnabled) => {
    document.documentElement.classList.toggle('perf-mode', isEnabled);
  };

  const savedPerfMode = localStorage.getItem('monaco_client_perf_mode');
  let isEnabled = false;
  if (savedPerfMode !== null) {
    isEnabled = savedPerfMode === 'true';
  } else {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      isEnabled = true;
    }
  }

  if (perfToggle) perfToggle.checked = isEnabled;
  if (mobilePerfToggle) mobilePerfToggle.checked = isEnabled;
  updatePerfMode(isEnabled);

  const handleChange = (checked) => {
    localStorage.setItem('monaco_client_perf_mode', checked);
    if (perfToggle) perfToggle.checked = checked;
    if (mobilePerfToggle) mobilePerfToggle.checked = checked;
    updatePerfMode(checked);
  };

  perfToggle?.addEventListener('change', () => handleChange(perfToggle.checked));
  mobilePerfToggle?.addEventListener('change', () => handleChange(mobilePerfToggle.checked));
}

function initClearLocalData() {
  const clearBtn = document.getElementById('clearLocalDataBtn');
  if (!clearBtn) return;

  clearBtn.addEventListener('click', async () => {
    const confirmed = await window.toast?.confirm?.(t('confirm_clear_data'), {
      confirmText: t('btn_delete_reload'),
      cancelText: t('btn_cancel'),
      type: 'warning',
    });

    if (!confirmed) return;

    try {
      await api('/api/agent/sessions/all', { method: 'DELETE' });
    } catch (err) {
      console.error('Failed to delete server sessions', err);
      window.toast?.error?.(t('failed_clear_data') || 'セッションの削除に失敗しました');
      return;
    }

    for (const key of LOCAL_STORAGE_KEYS) {
      localStorage.removeItem(key);
    }
    window.location.reload();
  });
}

let _settingsInitDone = false;

export function bootstrapSettings() {
  if (_settingsInitDone) return;
  _settingsInitDone = true;
  initCodeGeneratorSettings();
  initChatSettings();
  initPerformanceModeSettings();
  initClearLocalData();
}
