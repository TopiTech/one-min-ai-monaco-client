import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './toast.js';
import { getActiveProvider } from './settings.js';

let _allChatModels = [];
let _allCodeModels = [];
let _allImageModels = [];
let _allVideoModels = [];
let _providerCatalogs = { '1min': null, '1forall': null };
let _activePickerBtn = null;
let _activePickerType = null;
let _activeTag = 'all';
let _creditSaving = false; // synced from app state; gates fast-only filtering
let _modelsCache = []; // cached models for current picker session

/**
 * Sync the credit-saving flag from app state so the picker can restrict the
 * model list to `fast` tagged models. Previously the picker read `state`
 * directly, but it is a separate module and `state` was never in scope, so
 * the check silently always evaluated to false (typeof guard).
 * @param {boolean} enabled
 */
export function setCreditSavingMode(enabled) {
  _creditSaving = Boolean(enabled);
}

// Shared handler refs for cleanup
let _searchHandler = null;
let _tabHandlers = [];
let _outsideClickTimer = null;

export function getAllChatModels() {
  return _allChatModels;
}
export function getAllCodeModels() {
  return _allCodeModels;
}
export function getAllImageModels() {
  return _allImageModels;
}
export function getAllVideoModels() {
  return _allVideoModels;
}

const FALLBACK_CHAT_MODELS = [
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (Fallback)', provider: 'OpenAI', tags: ['flagship'] },
  { id: 'claude-opus-5', label: 'Claude 5 Opus (Fallback)', provider: 'Anthropic', tags: ['flagship'] },
  { id: 'qwen3.7-flash', label: 'Qwen 3.7 Flash (Fallback)', provider: 'Alibaba', tags: ['fast'] },
  { id: 'gpt-4o-mini', label: 'GPT-4o mini (Fallback)', provider: 'OpenAI', tags: ['fast'] },
  {
    id: 'deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (Fallback)',
    provider: 'DeepSeek',
    tags: ['fast'],
  },
];

const FALLBACK_CODE_MODELS = [
  {
    id: 'qwen3.7-plus',
    label: 'Qwen 3.7 Plus (Fallback)',
    provider: 'Alibaba',
    tags: ['code', 'flagship'],
  },
  {
    id: 'qwen3-coder-plus',
    label: 'Qwen3 Coder Plus (Fallback)',
    provider: 'Alibaba',
    tags: ['code', 'flagship'],
  },
  {
    id: 'claude-opus-5',
    label: 'Claude 5 Opus (Fallback)',
    provider: 'Anthropic',
    tags: ['code', 'flagship'],
  },
  {
    id: 'grok-code-fast-1',
    label: 'Grok Code Fast 1 (Fallback)',
    provider: 'xAI',
    tags: ['code', 'fast'],
  },
];

const FALLBACK_IMAGE_MODELS = [
  {
    id: 'gpt-image-2',
    label: 'GPT Image 2 (Fallback)',
    provider: 'OpenAI',
    tags: ['image', 'flagship', 'editor'],
  },
  {
    id: 'qwen-image-max',
    label: 'Qwen Image Max (Fallback)',
    provider: 'Alibaba',
    tags: ['image', 'flagship'],
  },
  {
    id: 'black-forest-labs/flux-2-pro',
    label: 'Flux 2 Pro (Fallback)',
    provider: 'Replicate',
    tags: ['image', 'flagship', 'editor'],
  },
  {
    id: 'gemini-3.1-flash-image-preview',
    label: 'Gemini 3.1 Flash Image Preview (Fallback)',
    provider: 'Google',
    tags: ['image', 'fast', 'editor'],
  },
];

const FALLBACK_VIDEO_MODELS = [
  { id: 'kling', label: 'Kling AI (Fallback)', provider: 'Kling', tags: ['video', 'flagship'] },
  {
    id: 'veo3-video',
    label: 'Google Veo3 Video (Fallback)',
    provider: 'Google',
    tags: ['video', 'flagship'],
  },
  { id: 'sora-2', label: 'OpenAI Sora 2 (Fallback)', provider: 'OpenAI', tags: ['video', 'fast'] },
];

function applyActiveProviderCatalog(providerId = getActiveProvider()) {
  const cat = _providerCatalogs[providerId];
  if (cat) {
    _allChatModels =
      Array.isArray(cat.chatModels) && cat.chatModels.length > 0 ? cat.chatModels : FALLBACK_CHAT_MODELS;
    _allCodeModels =
      Array.isArray(cat.codeModels) && cat.codeModels.length > 0 ? cat.codeModels : FALLBACK_CODE_MODELS;
    _allImageModels =
      Array.isArray(cat.imageModels) && cat.imageModels.length > 0 ? cat.imageModels : FALLBACK_IMAGE_MODELS;
    _allVideoModels =
      Array.isArray(cat.videoModels) && cat.videoModels.length > 0 ? cat.videoModels : FALLBACK_VIDEO_MODELS;
  }
  syncPickerSelectionsToCatalog(providerId);
}

function syncPickerSelectionsToCatalog(providerId = getActiveProvider()) {
  const pairs = [
    { inputId: 'chatModel', labelId: 'chatModelLabel', models: _allChatModels, fallbackId: 'gpt-4o-mini' },
    {
      inputId: 'codeModel',
      labelId: 'codeModelLabel',
      models: _allCodeModels,
      fallbackId: providerId === '1forall' ? 'gpt-4o' : 'qwen3-coder-plus',
    },
    {
      inputId: 'imageModel',
      labelId: 'imageModelLabel',
      models: _allImageModels,
      fallbackId: providerId === '1forall' ? 'black-forest-labs/flux-schnell' : 'gpt-image-2',
    },
    {
      inputId: 'videoModel',
      labelId: 'videoModelLabel',
      models: _allVideoModels,
      fallbackId: providerId === '1forall' ? 'google-veo3' : 'kling',
    },
  ];

  for (const { inputId, labelId, models, fallbackId } of pairs) {
    const inputEl = document.getElementById(inputId);
    const labelEl = document.getElementById(labelId);
    if (!inputEl || !Array.isArray(models) || models.length === 0) continue;

    let selected = models.find((m) => m.id === inputEl.value);
    if (!selected) {
      selected = models.find((m) => m.id === fallbackId) || models[0];
      inputEl.value = selected.id;
    }
    if (labelEl && selected) {
      labelEl.textContent = selected.label;
    }
  }
}

export async function loadModels() {
  try {
    const [data, health] = await Promise.all([api('/api/models'), api('/api/health').catch(() => null)]);

    if (data?.providers) {
      _providerCatalogs = {
        '1min': data.providers['1min'] || null,
        '1forall': data.providers['1forall'] || null,
      };
    }

    const activeProvider = getActiveProvider();
    if (_providerCatalogs[activeProvider]) {
      applyActiveProviderCatalog(activeProvider);
    } else {
      _allChatModels =
        Array.isArray(data.chatModels) && data.chatModels.length > 0 ? data.chatModels : FALLBACK_CHAT_MODELS;
      _allCodeModels =
        Array.isArray(data.codeModels) && data.codeModels.length > 0 ? data.codeModels : FALLBACK_CODE_MODELS;
      _allImageModels =
        Array.isArray(data.imageModels) && data.imageModels.length > 0
          ? data.imageModels
          : FALLBACK_IMAGE_MODELS;
      _allVideoModels =
        Array.isArray(data.videoModels) && data.videoModels.length > 0
          ? data.videoModels
          : FALLBACK_VIDEO_MODELS;
      syncPickerSelectionsToCatalog(activeProvider);
    }

    if (health?.models?.source === 'fallback') {
      console.info(health.models.error || t('model_fetch_warning'));
    }
  } catch (e) {
    console.warn(t('model_fetch_failed'), e);
    _allChatModels = FALLBACK_CHAT_MODELS;
    _allCodeModels = FALLBACK_CODE_MODELS;
    _allImageModels = FALLBACK_IMAGE_MODELS;
    _allVideoModels = FALLBACK_VIDEO_MODELS;
    toast.warning(t('model_fetch_warning'));
  }
}

function providerToSlug(provider) {
  return (
    String(provider || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}

function syncPickerActiveDescendant() {
  const search = document.getElementById('modelPickerSearch');
  const selected = document.querySelector('#modelPickerList .model-picker-item.selected');
  if (!search) return;
  if (selected?.id) {
    search.setAttribute('aria-activedescendant', selected.id);
  } else {
    search.removeAttribute('aria-activedescendant');
  }
}

function setPickerSelectedItem(item) {
  const list = item?.closest('#modelPickerList') || document.getElementById('modelPickerList');
  if (!list) return;
  for (const other of list.querySelectorAll('.model-picker-item')) {
    const isSelected = other === item;
    other.classList.toggle('selected', isSelected);
    other.setAttribute('aria-selected', String(isSelected));
  }
  syncPickerActiveDescendant();
}

function renderPickerList(models, search = '', tag = 'all') {
  const list = document.getElementById('modelPickerList');
  if (!list) return;
  list.textContent = '';
  list.setAttribute('role', 'listbox');

  const q = search.toLowerCase();
  let filtered = models;

  if (tag !== 'all') {
    filtered = filtered.filter((m) => m.tags && m.tags.includes(tag));
  }

  if (q) {
    filtered = filtered.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }

  // Use a Map instead of a plain object so an upstream provider name such as
  // "__proto__" cannot change the grouping object's prototype or crash the UI.
  const groups = new Map();
  for (const m of filtered) {
    if (!groups.has(m.provider)) groups.set(m.provider, []);
    groups.get(m.provider).push(m);
  }

  if (!groups.size) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'model-picker-empty';
    emptyDiv.textContent = t('model_not_found');
    list.appendChild(emptyDiv);
    return;
  }

  const usedOptionIds = new Set();
  for (const [provider, items] of groups.entries()) {
    const header = document.createElement('div');
    header.className = `model-picker-group-header model-picker-group-header--${providerToSlug(provider)}`;
    header.textContent = provider;
    list.appendChild(header);

    for (const m of items) {
      const item = document.createElement('button');
      item.className = 'model-picker-item';
      item.dataset.id = m.id;
      item.dataset.label = m.label;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const targetInput = _activePickerBtn
        ? document.getElementById(_activePickerBtn.dataset.targetInput)
        : null;
      if (targetInput && targetInput.value === m.id) item.classList.add('selected');

      const contentRow = document.createElement('div');
      contentRow.className = 'model-picker-item-content';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'model-picker-item-label';
      labelSpan.textContent = m.label;
      contentRow.appendChild(labelSpan);

      // Dynamic credit cost badge based on tags
      let costBadge = null;
      if (m.tags) {
        if (m.tags.includes('reasoning')) {
          costBadge = { text: t('cost_reasoning'), class: 'cost-high-reasoning', icon: '🧠💰💰' };
        } else if (m.tags.includes('flagship')) {
          costBadge = { text: t('cost_flagship'), class: 'cost-high', icon: '💰💰' };
        } else if (m.tags.includes('fast')) {
          costBadge = { text: t('cost_fast'), class: 'cost-low', icon: '⚡💰' };
        }
      }

      if (costBadge) {
        const bSpan = document.createElement('span');
        bSpan.className = `model-cost-badge ${costBadge.class}`;
        bSpan.textContent = `${costBadge.icon} ${costBadge.text}`;
        contentRow.appendChild(bSpan);
      }

      if (m.meta?.credits != null) {
        const cSpan = document.createElement('span');
        cSpan.className = 'model-tag tag-credits';
        cSpan.textContent = `${m.meta.credits} cr`;
        contentRow.appendChild(cSpan);
      } else if (m.meta?.creditsPerOutputToken != null) {
        const cSpan = document.createElement('span');
        cSpan.className = 'model-tag tag-credits';
        cSpan.textContent = `${m.meta.creditsPerOutputToken}/tok`;
        contentRow.appendChild(cSpan);
      }

      // Tags display
      if (m.tags && m.tags.length > 0) {
        const tagsDiv = document.createElement('div');
        tagsDiv.className = 'model-picker-item-tags';
        for (const t of m.tags) {
          const tSpan = document.createElement('span');
          tSpan.className = `model-tag tag-${t}`;
          tSpan.textContent = t;
          tagsDiv.appendChild(tSpan);
        }
        contentRow.appendChild(tagsDiv);
      }

      item.appendChild(contentRow);

      const idSpan = document.createElement('span');
      idSpan.className = 'model-picker-item-id';
      idSpan.textContent = m.id;
      item.appendChild(idSpan);

      // Assign a unique, stable id for aria-activedescendant support
      if (!item.id) {
        const baseId = `picker-opt-${m.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
        let candidateId = baseId;
        let suffix = 1;
        while (usedOptionIds.has(candidateId)) {
          candidateId = `${baseId}-${++suffix}`;
        }
        usedOptionIds.add(candidateId);
        item.id = candidateId;
      }
      item.addEventListener('focus', () => {
        setPickerSelectedItem(item);
      });
      item.onclick = () => selectModel(m);
      list.appendChild(item);
    }
  }
}

function selectModel(m) {
  if (!_activePickerBtn) return;
  const targetId = _activePickerBtn.dataset.targetInput;
  const hiddenInput = document.getElementById(targetId);
  const labelSpan = _activePickerBtn.querySelector('span:first-of-type');
  if (hiddenInput) hiddenInput.value = m.id;
  if (labelSpan) labelSpan.textContent = m.label;
  closeModelPicker();
}

function openModelPicker(btn, type) {
  _activePickerBtn = btn;
  _activePickerType = type;
  _activeTag = 'all';

  btn.setAttribute('aria-expanded', 'true');
  let models =
    type === 'video'
      ? _allVideoModels
      : type === 'image'
        ? _allImageModels
        : type === 'code'
          ? _allCodeModels
          : _allChatModels;

  if (type === 'image') {
    const isEditMode = !!document.getElementById('editorImageUrl')?.value?.trim();
    if (isEditMode) {
      const editorModels = models.filter((m) => m.tags && m.tags.includes('editor'));
      models = editorModels.length > 0 ? editorModels : models;
    } else {
      models = models.filter((m) => {
        if (!m.tags) return true;
        if (m.tags.includes('editor') && !m.tags.includes('flagship') && !m.tags.includes('fast'))
          return false;
        return true;
      });
    }
  }

  if (type === 'video') {
    const isI2V = !!document.getElementById('editorImageUrl')?.value?.trim();
    if (isI2V) {
      const i2vModels = models.filter(
        (m) =>
          !m.meta?.mode ||
          m.meta.mode === 'IMAGE_TO_VIDEO' ||
          m.tags?.includes('image-to-video') ||
          getActiveProvider() === '1min',
      );
      if (i2vModels.length > 0) models = i2vModels;
    }
  }

  if (_creditSaving) {
    const fastModels = models.filter((m) => m.tags && m.tags.includes('fast'));
    if (fastModels.length > 0) models = fastModels;
  }

  _modelsCache = models;

  const dropdown = document.getElementById('modelPickerDropdown');
  const search = document.getElementById('modelPickerSearch');

  // Reset tabs
  document.querySelectorAll('.picker-tab').forEach((tab) => {
    const isActive = tab.dataset.tag === 'all';
    tab.classList.toggle('active', isActive);
    tab.setAttribute('aria-selected', String(isActive));
  });

  search.value = '';
  search.setAttribute('aria-expanded', 'true');
  refreshPickerList();

  // A11Y-5: Set aria-selected on initial render
  const firstItem = document.querySelector('#modelPickerList .model-picker-item');
  const currentItem = document.querySelector('#modelPickerList .model-picker-item.selected');
  setPickerSelectedItem(currentItem || firstItem);

  // Hide before making visible to prevent layout shift
  // Remove the u-hidden class first; the class applies display:none !important
  // which overrides any inline style.display we set afterwards.
  dropdown.classList.remove('u-hidden');
  dropdown.style.visibility = 'hidden';

  dropdown.style.display = 'flex';

  const rect = btn.getBoundingClientRect();
  const dropH = dropdown.offsetHeight || 480;
  const dropW = Math.max(rect.width, 360);
  const viewportH = window.innerHeight;
  const spaceBelow = viewportH - rect.bottom - 8;
  const spaceAbove = rect.top - 8;

  let topPx;
  let maxHeightPx;
  if (spaceBelow >= Math.min(dropH, 240) || spaceBelow >= spaceAbove) {
    topPx = rect.bottom + 6 + window.scrollY;
    maxHeightPx = Math.max(spaceBelow - 4, 120);
  } else {
    const availH = Math.max(spaceAbove - 4, 120);
    maxHeightPx = availH;
    topPx = rect.top + window.scrollY - Math.min(dropH, availH) - 6;
  }

  const leftPx = Math.max(8, Math.min(rect.left, window.innerWidth - dropW - 8));

  // Apply calculated positions directly to avoid layout shift
  dropdown.style.top = `${topPx}px`;
  dropdown.style.left = `${leftPx}px`;
  dropdown.style.width = `${dropW}px`;
  dropdown.style.maxHeight = `${maxHeightPx}px`;
  dropdown.style.visibility = '';

  search.focus();

  // Attach search handler (removed on close)
  if (_searchHandler) {
    search.removeEventListener('input', _searchHandler);
  }
  _searchHandler = refreshPickerList;
  search.addEventListener('input', _searchHandler);

  // Attach tab click handlers via capsuled function references
  _tabHandlers.forEach((h) => h.remove());
  _tabHandlers = [];
  document.querySelectorAll('.picker-tab').forEach((tab) => {
    const handler = () => {
      document.querySelectorAll('.picker-tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      _activeTag = tab.dataset.tag;
      refreshPickerList();
      const firstItem = document.querySelector('#modelPickerList .model-picker-item');
      if (firstItem) firstItem.focus();
      syncPickerActiveDescendant();
    };
    tab.addEventListener('click', handler);
    _tabHandlers.push({ remove: () => tab.removeEventListener('click', handler) });
  });

  document.removeEventListener('click', closePicker);
  if (_outsideClickTimer !== null) {
    clearTimeout(_outsideClickTimer);
    _outsideClickTimer = null;
  }
  _outsideClickTimer = setTimeout(() => {
    _outsideClickTimer = null;
    if (_activePickerBtn) {
      document.addEventListener('click', closePicker);
    }
  }, 10);
}

/** Re-render the picker list from current cache/state */
function refreshPickerList() {
  const search = document.getElementById('modelPickerSearch');
  if (!search) return;
  renderPickerList(_modelsCache, search.value, _activeTag);
}

function closePicker(e) {
  const dropdown = document.getElementById('modelPickerDropdown');
  if (dropdown && !dropdown.contains(e.target)) {
    closeModelPicker();
  }
}

function closeModelPicker() {
  if (_outsideClickTimer !== null) {
    clearTimeout(_outsideClickTimer);
    _outsideClickTimer = null;
  }
  document.removeEventListener('click', closePicker);
  const dropdown = document.getElementById('modelPickerDropdown');
  const search = document.getElementById('modelPickerSearch');
  if (dropdown) {
    dropdown.style.display = 'none';
    dropdown.classList.add('u-hidden');
    // Clear inline positioning styles set by openModelPicker
    dropdown.style.top = '';
    dropdown.style.left = '';
    dropdown.style.width = '';
    dropdown.style.maxHeight = '';
    dropdown.style.visibility = '';
  }
  // Clean up event handlers to prevent listener leaks
  if (search) {
    search.setAttribute('aria-expanded', 'false');
    search.removeAttribute('aria-activedescendant');
  }
  if (search && _searchHandler) {
    search.removeEventListener('input', _searchHandler);
    _searchHandler = null;
  }
  _tabHandlers.forEach((h) => h.remove());
  _tabHandlers = [];
  _modelsCache = [];
  if (_activePickerBtn) {
    _activePickerBtn.setAttribute('aria-expanded', 'false');
    if (typeof _activePickerBtn.focus === 'function') {
      _activePickerBtn.focus();
    }
  }
  _activePickerBtn = null;
  _activePickerType = null;
}

function navigatePickerItems(direction) {
  const list = document.getElementById('modelPickerList');
  if (!list) return;
  const items = Array.from(list.querySelectorAll('.model-picker-item'));
  if (!items.length) return;

  const currentIdx = items.findIndex((item) => item === document.activeElement);
  let nextIdx;
  if (currentIdx === -1) {
    nextIdx = direction === 'down' ? 0 : items.length - 1;
  } else {
    nextIdx = direction === 'down' ? Math.min(currentIdx + 1, items.length - 1) : Math.max(currentIdx - 1, 0);
  }
  items[nextIdx].focus();
  syncPickerActiveDescendant();
  items[nextIdx].scrollIntoView({ block: 'nearest' });
}

export function initModelPickers() {
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('provider-changed', (e) => {
      const nextProvider = e?.detail?.provider || getActiveProvider();
      applyActiveProviderCatalog(nextProvider);
    });
    window.addEventListener('models-refresh-requested', async (e) => {
      try {
        await api('/api/models/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: e?.detail?.provider }),
        });
        await loadModels();
      } catch (err) {
        console.warn('Model refresh failed:', err);
      }
    });
  }

  document.querySelectorAll('.model-picker-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dropdown = document.getElementById('modelPickerDropdown');
      const isOpen = dropdown && !dropdown.classList.contains('u-hidden');
      if (isOpen && _activePickerBtn === btn) {
        closeModelPicker();
      } else {
        openModelPicker(btn, btn.dataset.modelType);
      }
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _activePickerType) {
      closeModelPicker();
    }
    if (_activePickerType) {
      const tag = e.target?.tagName;
      const isPickerItem = e.target?.classList?.contains('model-picker-item');
      if (tag === 'TEXTAREA' || (tag === 'BUTTON' && !isPickerItem)) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        navigatePickerItems('down');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        navigatePickerItems('up');
      } else if (e.key === 'Enter') {
        if (isPickerItem) {
          e.preventDefault();
          e.target.click();
        } else if (e.target?.id === 'modelPickerSearch') {
          e.preventDefault();
          const selectedOrFirst =
            document.querySelector('#modelPickerList .model-picker-item.selected') ||
            document.querySelector('#modelPickerList .model-picker-item');
          if (selectedOrFirst) {
            selectedOrFirst.click();
          }
        }
      }
    }
  });
}
