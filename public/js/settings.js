/**
 * Settings management module
 * Handles localStorage persistence for user preferences, active AI provider,
 * and BFF-side API key management.
 */

import { t } from './i18n.js';
import { api } from './api.js';
import { toast } from './toast.js';

const STORAGE_KEYS = {
  WEB_SEARCH: 'monaco_client_code_web_search',
  NUM_OF_SITE: 'monaco_client_code_num_of_site',
  MAX_WORD: 'monaco_client_code_max_word',
  CHAT_WEB_SEARCH: 'monaco_client_chat_web_search',
  CHAT_NUM_OF_SITE: 'monaco_client_chat_num_of_site',
  CHAT_MAX_WORD: 'monaco_client_chat_max_word',
  ACTIVE_PROVIDER: 'monaco_client_active_provider',
};

const LOCAL_STORAGE_KEYS = [
  ...Object.values(STORAGE_KEYS),
  'monaco_client_conversation',
  'monaco_client_credit_saving',
  'monaco_client_perf_mode',
  'monaco_client_theme',
  'monaco_client_font_size',
  'monaco_client_word_wrap',
  'monaco_client_minimap',
  'monaco_client_tab_size',
  'diffRenderInline',
];

const DEFAULT_CAPABILITIES = {
  '1min': {
    webSearch: true,
    memories: true,
    serverConversations: true,
    chatAttachments: true,
    imageEdit: true,
    videoGeneration: true,
    imageToVideo: true,
    maxImagesPerRequest: 10,
  },
  '1forall': {
    webSearch: false,
    memories: false,
    serverConversations: false,
    chatAttachments: false,
    imageEdit: true,
    videoGeneration: true,
    imageToVideo: true,
    maxImagesPerRequest: 4,
  },
};

let _providersMeta = {
  '1min': { configured: false, source: 'none', masked: null, capabilities: DEFAULT_CAPABILITIES['1min'] },
  '1forall': {
    configured: false,
    source: 'none',
    masked: null,
    capabilities: DEFAULT_CAPABILITIES['1forall'],
  },
};

export function getActiveProvider() {
  if (typeof localStorage === 'undefined') return '1min';
  const saved = localStorage.getItem(STORAGE_KEYS.ACTIVE_PROVIDER);
  if (saved === '1min' || saved === '1forall') return saved;
  return '1min';
}

export function getProviderCapabilities(providerId = getActiveProvider()) {
  return (
    _providersMeta[providerId]?.capabilities ||
    DEFAULT_CAPABILITIES[providerId] ||
    DEFAULT_CAPABILITIES['1min']
  );
}

export function setActiveProvider(providerId, { notify = true } = {}) {
  const normalized = providerId === '1forall' ? '1forall' : '1min';
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_PROVIDER, normalized);
  }

  if (typeof document !== 'undefined') {
    const topSelect = document.getElementById('activeProviderSelect');
    if (topSelect && topSelect.value !== normalized) topSelect.value = normalized;
    const settingsSelect = document.getElementById('defaultProviderSelect');
    if (settingsSelect && settingsSelect.value !== normalized) settingsSelect.value = normalized;

    applyProviderCapabilitiesToUi(normalized);
  }

  if (notify && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('provider-changed', { detail: { provider: normalized } }));
  }
  return normalized;
}

export function applyProviderCapabilitiesToUi(providerId = getActiveProvider()) {
  const caps = getProviderCapabilities(providerId);
  const unsupportedTip = t('provider_feature_unsupported', {
    provider: providerId === '1forall' ? '1forall.ai' : '1min.ai',
  });

  const setControlState = (id, enabled) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !enabled;
    const container = el.closest('label') || el;
    if (!enabled) {
      container.classList.add('is-provider-disabled');
      container.title = unsupportedTip;
    } else {
      container.classList.remove('is-provider-disabled');
      if (container.title === unsupportedTip) container.title = '';
    }
  };

  setControlState('webSearch', caps.webSearch);
  setControlState('chatNumOfSite', caps.webSearch);
  setControlState('chatMaxWord', caps.webSearch);
  setControlState('withMemories', caps.memories);
  setControlState('isMixed', caps.serverConversations);
  setControlState('brandVoiceId', caps.serverConversations);
  setControlState('createConversation', caps.serverConversations);
  setControlState('conversationId', caps.serverConversations);
  setControlState('attachImageBtn', caps.chatAttachments);
  setControlState('codeWebSearch', caps.webSearch);
  setControlState('codeNumOfSite', caps.webSearch);
  setControlState('codeMaxWord', caps.webSearch);

  const numOutputsInput = document.getElementById('numOutputs');
  if (numOutputsInput) {
    const maxImgs = caps.maxImagesPerRequest || 4;
    numOutputsInput.max = String(maxImgs);
    if (Number(numOutputsInput.value) > maxImgs) {
      numOutputsInput.value = String(maxImgs);
    }
  }

  const dot = document.getElementById('providerConfigDot');
  if (dot) {
    const configured = Boolean(_providersMeta[providerId]?.configured);
    dot.classList.toggle('is-configured', configured);
    dot.title = configured ? t('provider_key_configured') : t('provider_key_missing');
  }
}

function renderKeyRowStatus(providerId, info) {
  const prefix = providerId === '1forall' ? 'oneForAll' : 'oneMin';
  const badge = document.getElementById(`${prefix}KeyStatus`);
  const maskedEl = document.getElementById(`${prefix}KeyMasked`);
  const deleteBtn =
    document.getElementById(`${prefix}KeyDeleteBtn`) ||
    document.getElementById(`delete${providerId === '1forall' ? 'OneForAll' : 'OneMin'}KeyBtn`);

  if (badge) {
    badge.classList.remove('status-configured', 'status-missing');
    if (info?.configured) {
      badge.classList.add('status-configured');
      badge.textContent = info.source === 'ui' ? t('key_status_ui') : t('key_status_env');
    } else {
      badge.classList.add('status-missing');
      badge.textContent = t('key_status_none');
    }
  }
  if (maskedEl) {
    maskedEl.textContent = info?.masked ? info.masked : '-';
  }
  if (deleteBtn) {
    deleteBtn.disabled = info?.source !== 'ui';
  }
}

export async function refreshProvidersStatus() {
  try {
    const data = await api('/api/settings/providers');
    if (data?.providers) {
      _providersMeta = {
        ..._providersMeta,
        ...data.providers,
      };
      renderKeyRowStatus('1min', _providersMeta['1min']);
      renderKeyRowStatus('1forall', _providersMeta['1forall']);

      const saved = localStorage.getItem(STORAGE_KEYS.ACTIVE_PROVIDER);
      if (!saved) {
        // Auto-select whichever provider is configured if default isn't
        const preferred = _providersMeta[data.defaultProvider]?.configured
          ? data.defaultProvider
          : _providersMeta['1forall']?.configured && !_providersMeta['1min']?.configured
            ? '1forall'
            : data.defaultProvider || '1min';
        setActiveProvider(preferred, { notify: true });
      } else {
        applyProviderCapabilitiesToUi(saved);
      }
    }
  } catch (err) {
    console.warn('Failed to fetch provider settings status:', err);
  }
}

function getNumberInRange(value, min, max, defaultValue) {
  const num = parseInt(value, 10);
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

function initProviderAndApiKeySettings() {
  const topSelect = document.getElementById('activeProviderSelect');
  const settingsSelect = document.getElementById('defaultProviderSelect');
  const initialProvider = getActiveProvider();

  if (topSelect) {
    topSelect.value = initialProvider;
    topSelect.addEventListener('change', () => {
      setActiveProvider(topSelect.value);
    });
  }
  if (settingsSelect) {
    settingsSelect.value = initialProvider;
    settingsSelect.addEventListener('change', () => {
      setActiveProvider(settingsSelect.value);
    });
  }

  const bindKeyActions = (providerId, inputId, saveBtnId, deleteBtnId) => {
    const input = document.getElementById(inputId);
    const saveBtn = document.getElementById(saveBtnId);
    const deleteBtn = document.getElementById(deleteBtnId);
    const verifyCheck = document.getElementById('verifyApiKeyOnSave');

    saveBtn?.addEventListener('click', async () => {
      const apiKey = input?.value?.trim() || '';
      if (!apiKey) {
        toast?.warning?.(t('key_input_required'));
        return;
      }
      saveBtn.disabled = true;
      try {
        const verify = verifyCheck ? Boolean(verifyCheck.checked) : true;
        const res = await api('/api/settings/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerId, apiKey, verify }),
        });
        if (input) input.value = '';
        if (res?.provider) {
          _providersMeta[providerId] = {
            ..._providersMeta[providerId],
            ...res.provider,
          };
          renderKeyRowStatus(providerId, _providersMeta[providerId]);
          applyProviderCapabilitiesToUi(getActiveProvider());
        }
        toast?.success?.(
          t('key_saved_success', { provider: providerId === '1forall' ? '1forall.ai' : '1min.ai' }),
        );
        window.dispatchEvent(
          new CustomEvent('models-refresh-requested', { detail: { provider: providerId } }),
        );
      } catch (err) {
        toast?.error?.(t('key_save_failed', { error: err.message }));
      } finally {
        saveBtn.disabled = false;
      }
    });

    deleteBtn?.addEventListener('click', async () => {
      deleteBtn.disabled = true;
      try {
        const res = await api(`/api/settings/keys/${providerId}`, { method: 'DELETE' });
        if (res?.provider) {
          _providersMeta[providerId] = {
            ..._providersMeta[providerId],
            ...res.provider,
          };
          renderKeyRowStatus(providerId, _providersMeta[providerId]);
          applyProviderCapabilitiesToUi(getActiveProvider());
        }
        toast?.success?.(
          t('key_deleted_success', { provider: providerId === '1forall' ? '1forall.ai' : '1min.ai' }),
        );
      } catch (err) {
        toast?.error?.(t('key_delete_failed', { error: err.message }));
      }
    });
  };

  bindKeyActions('1min', 'oneMinApiKeyInput', 'saveOneMinKeyBtn', 'deleteOneMinKeyBtn');
  bindKeyActions('1forall', 'oneForAllApiKeyInput', 'saveOneForAllKeyBtn', 'deleteOneForAllKeyBtn');

  applyProviderCapabilitiesToUi(initialProvider);
  refreshProvidersStatus();
}

let _settingsInitDone = false;

export function bootstrapSettings() {
  if (_settingsInitDone) return;
  _settingsInitDone = true;
  initCodeGeneratorSettings();
  initChatSettings();
  initPerformanceModeSettings();
  initClearLocalData();
  initProviderAndApiKeySettings();
}
