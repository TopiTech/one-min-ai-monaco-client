import { injectStyle } from './dom-style.js';
import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

let _allChatModels = [];
let _allCodeModels = [];
let _allImageModels = [];
let _activePickerBtn = null;
let _activePickerType = null;
let _activeTag = 'all';
let _modelsCache = []; // cached models for current picker session

// Shared handler refs for cleanup
let _searchHandler = null;
let _tabHandlers = [];

export function getAllChatModels() {
  return _allChatModels;
}
export function getAllCodeModels() {
  return _allCodeModels;
}
export function getAllImageModels() {
  return _allImageModels;
}

const FALLBACK_CHAT_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI', tags: ['fast'] },
  { id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', tags: ['flagship'] },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'Anthropic', tags: ['flagship'] },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'Google', tags: ['fast'] },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'Google', tags: ['flagship'] },
  { id: 'deepseek-chat', label: 'DeepSeek Chat', provider: 'DeepSeek', tags: ['fast'] },
  { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', provider: 'DeepSeek', tags: ['reasoning'] },
];

const FALLBACK_CODE_MODELS = [
  { id: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', provider: 'Alibaba', tags: ['code', 'flagship'] },
  { id: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', provider: 'Alibaba', tags: ['code', 'fast'] },
  { id: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet', provider: 'Anthropic', tags: ['code', 'flagship'] },
  { id: 'deepseek-chat', label: 'DeepSeek V3.2 Chat', provider: 'DeepSeek', tags: ['code', 'fast'] },
];

const FALLBACK_IMAGE_MODELS = [
  { id: 'gpt-image-2', label: 'GPT Image 2', provider: 'OpenAI', tags: ['image', 'flagship', 'editor'] },
  {
    id: 'gpt-image-1-mini',
    label: 'GPT Image 1 Mini',
    provider: 'OpenAI',
    tags: ['image', 'fast', 'editor'],
  },
  { id: 'black-forest-labs/flux-2-max', label: 'Flux 2 Max', provider: 'Flux', tags: ['image', 'flagship'] },
  {
    id: 'black-forest-labs/flux-kontext-pro',
    label: 'Flux Kontext Pro',
    provider: 'Flux',
    tags: ['image', 'flagship', 'editor'],
  },
  {
    id: 'qwen-image-edit-plus',
    label: 'Qwen Image Edit Plus',
    provider: 'Alibaba',
    tags: ['image', 'editor'],
  },
];

export async function loadModels() {
  try {
    const [data, health] = await Promise.all([api('/api/models'), api('/api/health').catch(() => null)]);

    _allChatModels =
      Array.isArray(data.chatModels) && data.chatModels.length > 0 ? data.chatModels : FALLBACK_CHAT_MODELS;
    _allCodeModels =
      Array.isArray(data.codeModels) && data.codeModels.length > 0 ? data.codeModels : FALLBACK_CODE_MODELS;
    _allImageModels =
      Array.isArray(data.imageModels) && data.imageModels.length > 0
        ? data.imageModels
        : FALLBACK_IMAGE_MODELS;

    if (health?.models?.source === 'fallback') {
      // Keep the fallback state visible only in the console so the UI does not
      // repeat the same notice on every reload.
      console.info(health.models.error || t('model_fetch_warning'));
    }
  } catch (e) {
    console.warn(t('model_fetch_failed'), e);
    _allChatModels = FALLBACK_CHAT_MODELS;
    _allCodeModels = FALLBACK_CODE_MODELS;
    _allImageModels = FALLBACK_IMAGE_MODELS;
    toast.warning(t('model_fetch_warning'));
  }
}

function getProviderColor(provider) {
  const map = {
    OpenAI: '#10a37f',
    Anthropic: '#d4793c',
    Google: '#4285f4',
    DeepSeek: '#5b6cf9',
    xAI: '#e7e7e7',
    Mistral: '#ff7000',
    Alibaba: '#ff6a00',
    Perplexity: '#20b2aa',
    Cohere: '#39d3aa',
    Meta: '#0866ff',
    Flux: '#a855f7',
    'Magic Art': '#ec4899',
    Stability: '#7c3aed',
    Leonardo: '#f59e0b',
    Ideogram: '#06b6d4',
    Recraft: '#84cc16',
  };
  return map[provider] || 'var(--accent)';
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
      (m) => m.label.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q),
    );
  }

  const groups = {};
  for (const m of filtered) {
    if (!groups[m.provider]) groups[m.provider] = [];
    groups[m.provider].push(m);
  }

  if (!Object.keys(groups).length) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'model-picker-empty';
    emptyDiv.textContent = t('model_not_found');
    list.appendChild(emptyDiv);
    return;
  }

  for (const [provider, items] of Object.entries(groups)) {
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

      // Assign a stable id for aria-activedescendant support
      if (!item.id) {
        item.id = `picker-opt-${m.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
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

function selectActivePickerItem() {
  const list = document.getElementById('modelPickerList');
  const active = list?.querySelector('.model-picker-item.selected');
  if (active) active.click();
}

function openModelPicker(btn, type) {
  _activePickerBtn = btn;
  _activePickerType = type;
  _activeTag = 'all';

  btn.setAttribute('aria-expanded', 'true');
  let models = type === 'image' ? _allImageModels : type === 'code' ? _allCodeModels : _allChatModels;

  if (typeof state !== 'undefined' && state.creditSaving) {
    models = models.filter((m) => m.tags && m.tags.includes('fast'));
  }

  if (type === 'image') {
    const isEditMode = !!document.getElementById('editorImageUrl')?.value?.trim();
    if (isEditMode) {
      // Show only models with the "editor" tag for image editing
      models = _allImageModels.filter((m) => m.tags && m.tags.includes('editor'));
    } else {
      // For generation: show flagship + fast models (exclude editor-only models)
      models = _allImageModels.filter((m) => {
        if (!m.tags) return true;
        if (m.tags.includes('editor') && !m.tags.includes('flagship') && !m.tags.includes('fast'))
          return false;
        return true;
      });
    }
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
  dropdown.style.visibility = 'hidden';

  dropdown.classList.remove('u-hidden');
  dropdown.classList.add('u-flex');

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

  const leftPx = Math.min(rect.left, window.innerWidth - dropW - 8);

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
  setTimeout(() => {
    document.addEventListener('click', closePicker);
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
    document.removeEventListener('click', closePicker);
  }
}

function closeModelPicker() {
  const dropdown = document.getElementById('modelPickerDropdown');
  const search = document.getElementById('modelPickerSearch');
  if (dropdown) {
    dropdown.classList.add('u-hidden');
    dropdown.classList.remove('u-flex');
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
  if (_activePickerBtn) _activePickerBtn.setAttribute('aria-expanded', 'false');
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
      } else if (e.key === 'Enter' && isPickerItem) {
        e.preventDefault();
        e.target.click();
      }
    }
  });
}
