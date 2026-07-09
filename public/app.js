/**
 * Main application logic for 1min.ai Monaco Client
 * Depends on: js/api.js, js/dom-style.js, js/model-picker.js, js/toast.js, js/utils.js
 */

import {
  loadModels,
  initModelPickers,
  getAllChatModels,
  getAllCodeModels,
  getAllImageModels,
} from './js/model-picker.js';
import { api } from './js/api.js';
import { parseXMLTags } from './js/utils.js';
import { initTheme, toggleTheme as toggleThemeFn } from './js/theme.js';
import { bootstrapSettings } from './js/settings.js';
import { createChatManager, createChatState } from './js/chat.js';
import { createImageManager, createImageState } from './js/image.js';
import { createEditorManager, createEditorState } from './js/editor.js';
import { createInlineChatManager } from './js/inline-chat.js';
import { createEditorTabManager } from './js/editor-tabs.js';
import { createDiffDialog } from './js/editor-diff.js';
import { createAgentRuntime } from './js/agent-core.js';
import { createExplorerManager } from './js/explorer.js';
import { initEditorToolbar } from './js/editor-toolbar.js';
import { t, initI18n, setLanguage } from './js/i18n.js';
import { toast } from './js/toast.js';
import { createAgentTimeline } from './js/agent-timeline.js';

// Helper to get element by ID
const $ = (id) => document.getElementById(id);

// Initialize i18n first
await initI18n();

const langSelector = $('langSelector');
if (langSelector) {
  langSelector.addEventListener('change', async () => {
    await setLanguage(langSelector.value);
  });
}

// Initialize Model Pickers
loadModels().then(() => {
  initModelPickers();
  applyCreditSavingMode();
});

// ============================================================
// ============================================================
// DOM Elements Cache
// ============================================================
const dom = {
  chatLog: $('chatLog'),
  chatPrompt: $('chatPrompt'),
  sendChatBtn: $('sendChat'),
  abortChatBtn: $('abortChat'),
  chatModel: $('chatModel'),
  chatModelLabel: $('chatModelLabel'),
  conversationId: $('conversationId'),
  conversationTitle: $('conversationTitle'),
  webSearch: $('webSearch'),
  chatNumOfSite: $('chatNumOfSite'),
  chatMaxWord: $('chatMaxWord'),
  withMemories: $('withMemories'),
  isMixed: $('isMixed'),
  brandVoiceId: $('brandVoiceId'),
  chatAttachments: $('chatAttachments'),
  attachmentPreviews: $('attachmentPreviews'),
  chatImageInput: $('chatImageInput'),
  attachImageBtn: $('attachImageBtn'),

  imagePrompt: $('imagePrompt'),
  imageModel: $('imageModel'),
  imageModelLabel: $('imageModelLabel'),
  imageGallery: $('imageGallery'),
  assetResult: $('assetResult'),
  editorImageUrl: $('editorImageUrl'),
  editorImagePreview: $('editorImagePreview'),
  clearImageBtn: $('clearImageBtn'),
  generateImage: $('generateImage'),
  uploadAsset: $('uploadAsset'),

  explorerPath: $('explorerPath'),
  fileTree: $('fileTree'),
  currentFileName: $('currentFileName'),
  saveFileBtn: $('saveFileBtn'),
  editorTabsBar: $('editorTabsBar'),
  rootSelector: $('rootSelector'),

  agentInstruction: $('agentInstruction'),
  agentStatus: $('agentStatus'),
  agentActivityLog: $('agentActivityLog'),
  startAgentBtn: $('startAgentBtn'),
  stopAgentBtn: $('stopAgentBtn'),
  resetAgentBtn: $('resetAgentBtn'),
  agentFeedbackInput: $('agentFeedbackInput'),
  sendAgentFeedbackBtn: $('sendAgentFeedbackBtn'),
  codeModel: $('codeModel'),
  codeWebSearch: $('codeWebSearch'),
  codeNumOfSite: $('codeNumOfSite'),
  codeMaxWord: $('codeMaxWord'),
};

// ============================================================
// Application State
// ============================================================
const state = {
  chat: null,
  image: null,
  editor: null,
  agent: {
    active: false,
    sessionId: null,
    history: [],
    chatId: null,
    resolver: null,
  },
  theme: {
    current: 'dark',
  },
  creditSaving: false,
};

// Theme toggle handler
function syncMobileThemeUI() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const mobileLabel = $('mobileThemeLabel');
  const darkIcon = $('mobileThemeIconDark');
  const lightIcon = $('mobileThemeIconLight');
  if (mobileLabel) {
    mobileLabel.textContent = currentTheme === 'light' ? t('theme_light') : t('theme_dark');
  }
  if (darkIcon && lightIcon) {
    if (currentTheme === 'light') {
      darkIcon.classList.add('is-hidden');
      lightIcon.classList.remove('is-hidden');
    } else {
      darkIcon.classList.remove('is-hidden');
      lightIcon.classList.add('is-hidden');
    }
  }
}

function toggleTheme() {
  toggleThemeFn();
  editorManager.updateTheme();
  diffDialog.syncTheme();
  syncMobileThemeUI();
}

// Initialize theme and settings on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      initTheme();
      $('themeToggle')?.addEventListener('click', toggleTheme);
      $('mobileThemeToggle')?.addEventListener('click', toggleTheme);
      syncMobileThemeUI();
      bootstrapSettings();
    },
    { once: true },
  );
} else {
  initTheme();
  $('themeToggle')?.addEventListener('click', toggleTheme);
  $('mobileThemeToggle')?.addEventListener('click', toggleTheme);
  syncMobileThemeUI();
  bootstrapSettings();
}

// navigation
const navBtns = document.querySelectorAll('.nav');
const views = document.querySelectorAll('.view');
for (const btn of navBtns) {
  btn.addEventListener('click', () => {
    navBtns.forEach((x) => x.classList.remove('active'));
    views.forEach((x) => x.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.view).classList.add('active');
    $('viewTitle').textContent = btn.textContent.trim();
    if (btn.dataset.view === 'coding') setTimeout(() => editorManager.layout(), 100);
  });
}

$('healthBtn').onclick = async () => {
  const btn = $('healthBtn');
  const originalText = btn.textContent;
  btn.textContent = 'Checking...';
  btn.disabled = true;
  try {
    const data = await api('/api/health');
    const details = [
      `Status: ${data.ok ? 'OK 🟢' : 'Error 🔴'}`,
      `Version: ${data.version || 'N/A'}`,
      `Uptime: ${data.uptime ? Math.round(data.uptime) + 's' : 'N/A'}`,
      `Models: ${data.models?.ok ? 'Synced 🟢' : 'Error 🔴'}`,
    ].join('\n');
    toast.success(`システム状態:\n${details}`, { duration: 8000 });
  } catch (e) {
    toast.error(t('health_check_failed', { error: e.message }));
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
};

// Initialize managers
const chatState = createChatState();
const imageState = createImageState();
const editorState = createEditorState();

const chatManager = createChatManager(dom, { chat: chatState });
chatManager.initCharCounter();
const imageManager = createImageManager(dom);
const editorManager = createEditorManager(editorState);

// Create tab and inline-chat managers
const tabManager = createEditorTabManager(editorState, editorManager, dom);
const inlineChatManager = createInlineChatManager(editorState, editorManager, dom);
const explorerManager = createExplorerManager(dom, (filePath) => tabManager.openFile(filePath));

window.addEventListener('beforeunload', (e) => {
  if (editorManager.isAnyDirty && editorManager.isAnyDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Listen to editor.js keyboard shortcut CustomEvents to avoid global scope pollution.
document.addEventListener('editor-save', () => {
  tabManager.saveFile();
});
document.addEventListener('editor-toggle-inline-chat', () => {
  inlineChatManager.toggleInlineChat();
});

// Merge state for compatibility
state.chat = chatState;
state.image = imageState;
state.editor = editorState;

function translateUiKey(key, params = {}) {
  return t(key, params);
}

const getMonacoThemeName = () =>
  document.documentElement.getAttribute('data-theme') === 'light' ? 'vs' : 'vs-dark';

const diffDialog = createDiffDialog({
  t: translateUiKey,
  getThemeName: getMonacoThemeName,
});

const agentTimeline = createAgentTimeline(dom);

const agentRuntime = createAgentRuntime({
  dom,
  state,
  api,
  t: translateUiKey,
  parseXMLTags,
  setAgentStatus,
  addAgentTimelineStep: agentTimeline.addStep,
  addAgentApprovalStep: agentTimeline.addApprovalStep,
});

// Use chat manager for sending and aborting
$('abortChat').onclick = () => chatManager.abortChat();
dom.sendChatBtn.onclick = () => chatManager.sendChat(setStatus);

// Ctrl+Enter to send chat, Escape to abort
dom.chatPrompt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    chatManager.sendChat(setStatus);
  } else if (e.key === 'Escape' && state.chat.abortController) {
    e.preventDefault();
    chatManager.abortChat();
  }
});

// Attach image button
if (dom.attachImageBtn) {
  dom.attachImageBtn.onclick = () => dom.chatImageInput.click();
}

// File input change
if (dom.chatImageInput) {
  dom.chatImageInput.onchange = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    for (const file of files) {
      const isImage = file.type.startsWith('image/');
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      const att = {
        file,
        previewUrl,
        assetKey: null,
        assetUrl: null,
        uploading: false,
        type: isImage ? 'image' : 'file',
      };
      state.chat.attachments.push(att);
    }

    chatManager.updateAttachmentPreview();
    e.target.value = '';
  };
}

// Check health on startup
async function checkHealth() {
  try {
    const data = await api('/api/health');
    if (!data?.ok) {
      toast.error(t('health_check_failed', { error: '' }), {
        duration: 10000,
      });
      setStatus(t('health_check_failed', { error: '' }), 'err');
    } else if (data.models) {
      if (!data.models.ok) {
        console.warn('Model sync failure:', data.models.error);
        toast.warning(`モデル情報の同期に失敗しています。以前のデータを使用します: ${data.models.error}`, {
          duration: 8000,
        });
      }
    }
  } catch (e) {
    console.error('Health check failed:', e);
  }
}
checkHealth();

$('createConversation').onclick = async () => {
  try {
    const data = await api('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: dom.conversationTitle.value, model: dom.chatModel.value }),
    });
    const id =
      data?.conversation?.uuid || data?.uuid || data?.aiRecord?.conversationId || data?.conversationId || '';
    dom.conversationId.value = id;
    window.__saveConvState?.();
    toast.success('会話を作成しました', { duration: 5000 });
  } catch (e) {
    toast.error(t('conversation_create_failed', { error: e.message }));
  }
};

// Image operations delegated to imageManager

dom.generateImage.onclick = () => imageManager.generateImage();

dom.uploadAsset.onclick = async () => {
  const file = $('assetInput').files[0];
  if (!file) {
    toast.warning('画像ファイルを選択してください');
    return;
  }
  const btn = dom.uploadAsset;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'アップロード中...';
  try {
    await imageManager.performAssetUpload(file, setStatus);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
};

$('assetInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (file) {
    await imageManager.performAssetUpload(file, setStatus);
  }
};

dom.editorImageUrl.oninput = () => imageManager.updateEditorImagePreview();

dom.clearImageBtn.onclick = () => imageManager.clearImage();

// Editor tab management (delegated to tabManager)
const openFile = (filePath) => tabManager.openFile(filePath);
const saveFile = () => tabManager.saveFile();

// Initialize Monaco Editor
require.config({ paths: { vs: '/vs' } });
require(['vs/editor/editor.main'], () => {
  editorManager.init();
  // Initialize editor toolbar after Monaco is ready
  initEditorToolbar(editorManager, editorState);
}, (err) => {
  // #22: Monaco AMD loader failure — show user-visible error
  const msg = err?.message || err || 'Failed to load Monaco Editor from local assets or server';
  toast.error(t('monaco_load_failed', { error: msg }));
  console.error('Monaco AMD load error:', err);

  const container = document.getElementById('editor');
  if (container) {
    container.textContent = '';

    const errorView = document.createElement('div');
    errorView.className = 'editor-load-error';

    const title = document.createElement('h3');
    title.className = 'editor-load-error__title';
    title.textContent = 'エディタの読み込みに失敗しました / Editor Load Failed';

    const message = document.createElement('p');
    message.className = 'editor-load-error__message';
    message.textContent = String(msg);

    const checklist = document.createElement('div');
    checklist.className = 'editor-load-error__checklist';

    const checklistTitle = document.createElement('strong');
    checklistTitle.className = 'editor-load-error__checklist-title';
    checklistTitle.textContent = '🔧 推奨されるチェックリスト / Troubleshooting Checklist:';

    const checklistItems = document.createElement('ul');
    checklistItems.className = 'editor-load-error__list';

    const checklistTexts = [
      'ローカルの BFF サーバーが正常に起動しているか（npm start 等）',
      'ブラウザのネットワーク接続およびセキュリティ設定（Adblockやプロキシなど）に問題がないか',
      'public/vs ディレクトリが存在し、Monaco Editorアセットが正しく配置されているか',
    ];
    for (const text of checklistTexts) {
      const item = document.createElement('li');
      item.textContent = text;
      checklistItems.appendChild(item);
    }

    checklist.appendChild(checklistTitle);
    checklist.appendChild(checklistItems);

    const reloadButton = document.createElement('button');
    reloadButton.type = 'button';
    reloadButton.className = 'editor-load-error__reload';
    reloadButton.textContent = '再読み込み / Reload';
    reloadButton.addEventListener('click', () => window.location.reload());

    errorView.appendChild(title);
    errorView.appendChild(message);
    errorView.appendChild(checklist);
    errorView.appendChild(reloadButton);
    container.appendChild(errorView);
  }
});

// toggleInlineChat and closeInlineChat are set on window above via inlineChatManager

function loadWorkspace(dirPath = null) {
  return explorerManager.loadWorkspace(dirPath);
}

// openFile and saveFile are delegated to tabManager (see editor tab aliases above)

$('explorerRefresh').onclick = () => {
  const pathVal = dom.explorerPath.value.trim();
  loadWorkspace(pathVal || null);
};

dom.explorerPath.onkeydown = (e) => {
  if (e.key === 'Enter') {
    const pathVal = dom.explorerPath.value.trim();
    loadWorkspace(pathVal || null);
  }
};

dom.saveFileBtn.onclick = () => {
  saveFile();
};

// ============================================================
// AI Coding Agent Orchestration
// ============================================================
function setAgentStatus(statusText, statusClass) {
  const badge = dom.agentStatus;
  if (!badge) return;
  badge.textContent = statusText;
  badge.className = `agent-status-badge ${statusClass}`;
}

function setStatus(text, cls) {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.className = cls ? `status ${cls}` : 'status';
}

// Pure helper functions (escapeHtml, renderMarkdownSafely, formatMarkdownLike,
// stripMarkdownCodeBlock, unescapeXmlText, parseXMLTags) and SVG_NS
// are imported from js/utils.js.

// Agent timeline rendering is delegated to the agentTimeline module.
// The agentTimeline instance is created above (after dom is available).

dom.startAgentBtn.onclick = async () => {
  if (state.agent.active) return;
  const instruction = dom.agentInstruction.value.trim();
  if (!instruction) {
    toast.warning(t('agent_instruction_required'));
    return;
  }

  // Clear input so user can type feedback immediately
  dom.agentInstruction.value = '';
  dom.agentInstruction.placeholder = t('agent_instruction_placeholder');
  dom.agentInstruction.style.height = '';
  dom.agentInstruction.dispatchEvent(new Event('input'));

  state.agent.active = true;
  dom.startAgentBtn.classList.add('is-hidden');
  dom.sendAgentFeedbackBtn.classList.add('is-shown');
  dom.stopAgentBtn.classList.add('is-shown');
  dom.resetAgentBtn.classList.add('is-hidden');

  try {
    await agentRuntime.runAgentLoop(instruction);
  } catch (err) {
    console.error('Agent loop crashed:', err);
    setAgentStatus(t('status_error'), 'error');
    agentTimeline.addStep('error', t('agent_crash_title'), t('agent_crash_desc', { error: err.message }));
  } finally {
    state.agent.active = false;
    dom.startAgentBtn.classList.remove('is-hidden');
    dom.sendAgentFeedbackBtn.classList.remove('is-shown');
    dom.stopAgentBtn.classList.remove('is-shown');
    dom.resetAgentBtn.classList.remove('is-hidden');
    dom.agentInstruction.placeholder = t('agent_instruction_placeholder');
  }
};

dom.stopAgentBtn.onclick = () => {
  if (!state.agent.active) return;
  state.agent.active = false;
  if (state.agent.resolver) {
    state.agent.resolver({ abort: true });
  }
  // M-2: pending approvals become orphans once we stop the agent — clean them up.
  document.querySelectorAll('.agent-step.approval').forEach((el) => el.__finalizeApproval?.());
  setAgentStatus(t('agent_stopped'), 'idle');
  agentTimeline.addStep('thought', t('agent_stopped'), t('agent_stopped_by_user'));
};

dom.resetAgentBtn.onclick = async () => {
  const accepted = await toast.confirm(t('agent_reset_confirm'), {
    type: 'warning',
  });
  if (accepted) {
    if (state.agent.resolver) {
      state.agent.resolver({ abort: true });
    }
    // M-2: Clean up any pending approval cards so they don't outlive the
    // session (they would otherwise become "orphan" cards that fail if the
    // user clicks approve after reset).
    document.querySelectorAll('.agent-step.approval').forEach((el) => el.__finalizeApproval?.());
    state.agent.sessionId = null;
    state.agent.history = [];
    const log = dom.agentActivityLog;
    if (log) {
      log.textContent = '';
      const placeholder = document.createElement('div');
      placeholder.className = 'timeline-placeholder timeline-placeholder-inline';
      placeholder.textContent = t('agent_placeholder');
      log.appendChild(placeholder);
    }
    setAgentStatus('待機中', 'idle');
    dom.agentInstruction.placeholder = t('agent_instruction_placeholder');
    dom.startAgentBtn.classList.remove('is-hidden');
    dom.sendAgentFeedbackBtn.classList.remove('is-shown');
    dom.stopAgentBtn.classList.remove('is-shown');
    dom.resetAgentBtn.classList.remove('is-hidden');
    toast.success(t('agent_reset_success'));
  }
};

dom.sendAgentFeedbackBtn.onclick = () => {
  const feedback = dom.agentInstruction.value.trim();
  if (!feedback) return;
  dom.agentInstruction.value = '';
  dom.agentInstruction.style.height = '';
  dom.agentInstruction.dispatchEvent(new Event('input'));

  agentTimeline.addStep('user', t('agent_feedback_label'), feedback);

  if (state.agent.resolver) {
    state.agent.resolver({ approved: false, reason: `ユーザー指示: ${feedback}` });
  } else {
    state.agent.history.push({
      role: 'user',
      content: `【ユーザーの追加フィードバック】\n${feedback}`,
    });
  }
};

dom.agentInstruction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (state.agent.active) {
      dom.sendAgentFeedbackBtn.click();
    } else {
      dom.startAgentBtn.click();
    }
  } else if (e.key === 'Escape' && state.agent.active) {
    e.preventDefault();
    dom.stopAgentBtn.click();
  }
});

async function initWorkspace() {
  try {
    const config = await api('/api/fs/config');

    // Populate root selector
    const rootSelector = $('rootSelector');
    if (rootSelector) {
      rootSelector.textContent = '';

      // Add default root
      const defaultOpt = document.createElement('option');
      defaultOpt.value = config.root;
      defaultOpt.textContent = `📁 ${config.root}`;
      rootSelector.appendChild(defaultOpt);

      // Add allowed roots if different from default
      if (config.allowedRoots && config.allowedRoots.length > 1) {
        for (const root of config.allowedRoots) {
          if (root !== config.root) {
            const opt = document.createElement('option');
            opt.value = root;
            opt.textContent = `📁 ${root}`;
            rootSelector.appendChild(opt);
          }
        }
      }

      // Add "Browse..." option
      const browseOpt = document.createElement('option');
      browseOpt.value = '__browse__';
      browseOpt.textContent = '📂 フォルダを選択...';
      rootSelector.appendChild(browseOpt);

      rootSelector.onchange = async () => {
        if (rootSelector.value === '__browse__') {
          openFolderPicker(config.root);
          rootSelector.value = config.root;
          return;
        }

        $('explorerPath').value = rootSelector.value;
        await loadWorkspace(rootSelector.value);
      };
    }

    // Open folder button
    const openFolderBtn = $('openFolderBtn');
    if (openFolderBtn && rootSelector) {
      openFolderBtn.onclick = () => {
        rootSelector.value = '__browse__';
        rootSelector.onchange();
      };
    }

    loadWorkspace(config.defaultRoot || config.root);
  } catch (e) {
    console.error('Failed to load initial config', e);
    loadWorkspace();
  }
}

let openFolderPicker = () => {};
let closeFolderPicker = () => {};

function initFolderPicker() {
  const modal = $('folderPickerModal');
  const pathInput = $('folderPickerPath');
  const currentPath = $('folderPickerCurrentPath');
  const drives = $('folderPickerDrives');
  const body = $('folderPickerBody');
  const upButton = $('folderPickerUp');
  const openButton = $('folderPickerOpen');
  const cancelButton = $('folderPickerCancel');
  const errorBox = $('folderPickerError');

  if (
    !modal ||
    !pathInput ||
    !currentPath ||
    !drives ||
    !body ||
    !upButton ||
    !openButton ||
    !cancelButton ||
    !errorBox
  ) {
    return;
  }

  let folderPickerCurrentPath = '';

  const hideError = () => {
    errorBox.classList.remove('is-shown');
    errorBox.textContent = '';
  };

  const setLoading = () => {
    body.textContent = '';
    const loadingDiv = document.createElement('div');
    loadingDiv.className = 'folder-picker-loading';
    loadingDiv.textContent = 'フォルダを読み込み中...';
    body.appendChild(loadingDiv);
  };

  const renderDrives = async () => {
    try {
      const data = await api('/api/fs/drives');
      drives.textContent = '';
      data.drives.forEach((drive) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'folder-picker-drive';
        button.textContent = drive.name;
        button.title = drive.path;
        button.onclick = () => {
          renderFolderPickerList(drive.path);
        };
        drives.appendChild(button);
      });
      updateDriveSelection();
    } catch {
      drives.textContent = '';
    }
  };

  const updateDriveSelection = () => {
    [...drives.querySelectorAll('.folder-picker-drive')].forEach((button) => {
      const drivePath = button.title;
      const isDrive =
        folderPickerCurrentPath === drivePath ||
        folderPickerCurrentPath.toLowerCase().startsWith(drivePath.toLowerCase());
      button.classList.toggle('active', isDrive);
    });
  };

  const renderFolderPickerList = async (dir) => {
    folderPickerCurrentPath = dir;
    currentPath.textContent = dir;
    pathInput.value = dir;
    hideError();
    setLoading();
    updateDriveSelection();

    try {
      const data = await api(`/api/fs/list?dir=${encodeURIComponent(dir)}`);
      body.textContent = '';

      const directories = data.items.filter((item) => item.isDirectory);
      if (directories.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'folder-picker-empty';
        emptyDiv.textContent = '表示できるフォルダがありません';
        body.appendChild(emptyDiv);
        return;
      }

      directories.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'folder-picker-item';
        row.tabIndex = 0;
        row.dataset.path = item.path;
        const iconSpan = document.createElement('span');
        iconSpan.className = 'folder-picker-item-icon';
        iconSpan.textContent = '\uD83D\uDCC1';
        row.appendChild(iconSpan);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'folder-picker-item-name';
        nameSpan.textContent = item.name;
        row.appendChild(nameSpan);
        row.onclick = () => {
          pathInput.value = item.path;
          body
            .querySelectorAll('.folder-picker-item.selected')
            .forEach((el) => el.classList.remove('selected'));
          row.classList.add('selected');
          row.focus();
        };
        row.ondblclick = () => renderFolderPickerList(item.path);
        body.appendChild(row);
      });
    } catch (err) {
      body.textContent = '';
      const error = document.createElement('div');
      error.className = 'folder-picker-error-text';
      error.textContent = `フォルダを読み込めませんでした: ${err?.message || '不明なエラー'}`;
      body.appendChild(error);
    }
  };

  openFolderPicker = (initialPath = '') => {
    const initial = initialPath || $('explorerPath').value || '';
    folderPickerCurrentPath = initial;
    hideError();
    modal.classList.remove('u-hidden');
    modal.classList.remove('is-hidden');
    renderDrives();
    renderFolderPickerList(initial);
    setTimeout(() => pathInput.focus(), 0);

    modal._previousFocus = document.activeElement;
    modal.addEventListener('keydown', trapFocus);
  };

  closeFolderPicker = () => {
    modal.classList.add('u-hidden');
    modal.classList.add('is-hidden');
    hideError();
    modal.removeEventListener('keydown', trapFocus);
    if (modal._previousFocus) {
      modal._previousFocus.focus();
    }
  };

  function trapFocus(e) {
    if (e.key !== 'Tab') return;
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  upButton.onclick = () => {
    const normalized = folderPickerCurrentPath.replace(/[\\/]$/, '');
    if (/^[A-Za-z]:[\\/]?$/.test(normalized)) {
      return;
    }

    const lastSlash = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
    if (lastSlash <= 0) {
      return;
    }

    const parentPath = normalized.substring(0, lastSlash) || normalized;
    if (parentPath && parentPath !== folderPickerCurrentPath) {
      renderFolderPickerList(parentPath);
    }
  };

  openButton.onclick = async () => {
    const path = pathInput.value.trim();
    if (!path) {
      errorBox.textContent = 'フォルダの絶対パスを入力してください。';
      errorBox.classList.add('is-shown');
      return;
    }

    try {
      const res = await api('/api/fs/workspace/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: path }),
      });

      const rootSelector = $('rootSelector');
      if (rootSelector) {
        let exists = false;
        for (let i = 0; i < rootSelector.options.length; i++) {
          if (rootSelector.options[i].value === res.dir) {
            exists = true;
            rootSelector.selectedIndex = i;
            break;
          }
        }

        if (!exists) {
          const newOpt = document.createElement('option');
          newOpt.value = res.dir;
          newOpt.textContent = `📁 ${res.dir}`;
          rootSelector.insertBefore(newOpt, rootSelector.lastElementChild);
          rootSelector.value = res.dir;
        }
      }

      $('explorerPath').value = res.dir;
      await loadWorkspace(res.dir);
      closeFolderPicker();
    } catch (err) {
      errorBox.textContent = `フォルダ選択失敗: ${err.message}`;
      errorBox.classList.add('is-shown');
    }
  };

  cancelButton.onclick = closeFolderPicker;

  pathInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      renderFolderPickerList(pathInput.value.trim());
    } else if (event.key === 'Escape') {
      closeFolderPicker();
    }
  };

  body.onkeydown = (event) => {
    if (event.key === 'Enter') {
      const selected = body.querySelector('.folder-picker-item.selected');
      if (selected) {
        renderFolderPickerList(selected.dataset.path);
      }
    } else if (event.key === 'Escape') {
      closeFolderPicker();
    }
  };

  modal.onclick = (event) => {
    if (event.target === modal) {
      closeFolderPicker();
    }
  };
}

function selectModelForPicker(inputId, modelObj) {
  const hiddenInput = document.getElementById(inputId);
  if (hiddenInput) hiddenInput.value = modelObj.id;
  const btn = document.querySelector(`button[data-target-input="${inputId}"]`);
  const labelSpan = btn?.querySelector('span:first-of-type');
  if (labelSpan) labelSpan.textContent = modelObj.label;
}

const STORAGE_KEY_CREDIT_SAVING = 'monaco_client_credit_saving';

function initCreditSavingMode() {
  const toggle = $('creditSavingToggle');
  const mobileToggle = $('mobileCreditSavingToggle');

  const saved = localStorage.getItem(STORAGE_KEY_CREDIT_SAVING);
  state.creditSaving = saved === 'true';

  if (toggle) toggle.checked = state.creditSaving;
  if (mobileToggle) mobileToggle.checked = state.creditSaving;

  const handleChange = (e) => {
    state.creditSaving = e.target.checked;
    localStorage.setItem(STORAGE_KEY_CREDIT_SAVING, state.creditSaving);
    if (toggle) toggle.checked = state.creditSaving;
    if (mobileToggle) mobileToggle.checked = state.creditSaving;
    applyCreditSavingMode();
  };

  if (toggle) toggle.onchange = handleChange;
  if (mobileToggle) mobileToggle.onchange = handleChange;

  applyCreditSavingMode();
}

function applyCreditSavingMode() {
  const webSearch = $('webSearch');
  const codeWebSearch = $('codeWebSearch');
  const numOutputs = $('numOutputs');
  const editorN = $('editorN');
  const editorQuality = $('editorQuality');

  if (state.creditSaving) {
    if (webSearch) {
      webSearch.checked = false;
      webSearch.disabled = true;
      const chatSettings = $('chatWebSearchSettings');
      if (chatSettings) chatSettings.classList.remove('is-shown');
    }
    if (codeWebSearch) {
      codeWebSearch.checked = false;
      codeWebSearch.disabled = true;
    }

    if (numOutputs) {
      numOutputs.value = 1;
      numOutputs.disabled = true;
    }
    if (editorN) {
      editorN.value = 1;
      editorN.disabled = true;
    }
    if (editorQuality) {
      editorQuality.value = 'medium';
      for (let i = 0; i < editorQuality.options.length; i++) {
        if (editorQuality.options[i].value === 'high') {
          editorQuality.options[i].disabled = true;
        }
      }
    }

    const chatModels = getAllChatModels();
    if (chatModels.length > 0) {
      const currentChat = $('chatModel')?.value;
      const currentModelObj = chatModels.find((m) => m.id === currentChat);
      if (
        currentChat &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes('fast'))
      ) {
        const fallback =
          chatModels.find((m) => m.id === 'gpt-4o-mini') ||
          chatModels.find((m) => m.tags && m.tags.includes('fast'));
        if (fallback) selectModelForPicker('chatModel', fallback);
      }
    }

    const codeModels = getAllCodeModels();
    if (codeModels.length > 0) {
      const currentCode = $('codeModel')?.value;
      const currentModelObj = codeModels.find((m) => m.id === currentCode);
      if (
        currentCode &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes('fast'))
      ) {
        const fallback =
          codeModels.find((m) => m.id === 'qwen3-coder-flash') ||
          codeModels.find((m) => m.tags && m.tags.includes('fast'));
        if (fallback) selectModelForPicker('codeModel', fallback);
      }
    }

    const imgModels = getAllImageModels();
    if (imgModels.length > 0) {
      const currentImage = $('imageModel')?.value;
      const currentModelObj = imgModels.find((m) => m.id === currentImage);
      if (
        currentImage &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes('fast'))
      ) {
        const fallback =
          imgModels.find((m) => m.id === 'gpt-image-1-mini') ||
          imgModels.find((m) => m.tags && m.tags.includes('fast'));
        if (fallback) selectModelForPicker('imageModel', fallback);
      }
    }
  } else {
    if (webSearch) webSearch.disabled = false;
    if (codeWebSearch) codeWebSearch.disabled = false;
    if (numOutputs) numOutputs.disabled = false;
    if (editorN) editorN.disabled = false;
    if (editorQuality) {
      for (let i = 0; i < editorQuality.options.length; i++) {
        editorQuality.options[i].disabled = false;
      }
    }
  }
}

function initAgentInstructionControl() {
  const textarea = dom.agentInstruction;
  const startBtn = dom.startAgentBtn;
  const feedbackBtn = dom.sendAgentFeedbackBtn;
  if (!textarea) return;

  const adjustHeight = () => {
    textarea.style.height = 'auto';
    const minHeight = 60;
    const maxHeight = 160;
    const scrollHeight = textarea.scrollHeight;
    const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
    textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  };

  const updateButtons = () => {
    const text = textarea.value.trim();
    const disabled = !text;
    if (startBtn) startBtn.disabled = disabled;
    if (feedbackBtn) feedbackBtn.disabled = disabled;
  };

  textarea.addEventListener('input', () => {
    adjustHeight();
    updateButtons();
  });

  adjustHeight();
  updateButtons();
}

initWorkspace();
initFolderPicker();
initCreditSavingMode();
initAgentInstructionControl();

// Listen to custom events from agent-core.js to decoupled editor UI
document.addEventListener('editor:open-file', (e) => {
  if (e.detail?.path) {
    openFile(e.detail.path);
  }
});

document.addEventListener('editor:show-diff', async (e) => {
  if (e.detail) {
    const { path, oldContent, newContent, resolve } = e.detail;
    try {
      const approved = await diffDialog.showDiffDialog(path, oldContent, newContent);
      if (resolve) resolve(approved);
    } catch {
      if (resolve) resolve(false);
    }
  }
});

// Persist conversation state to localStorage across page reloads.
// Chat form fields (conversationId, webSearch toggle, etc.) are saved
// on every change and restored on startup.
(function initConversationPersistence() {
  const CONV_STORAGE_KEY = 'monaco_client_conversation';

  const convFields = [
    { id: 'conversationId', type: 'value' },
    { id: 'conversationTitle', type: 'value' },
    { id: 'webSearch', type: 'checkbox' },
    { id: 'chatNumOfSite', type: 'value' },
    { id: 'chatMaxWord', type: 'value' },
    { id: 'withMemories', type: 'checkbox' },
    { id: 'isMixed', type: 'checkbox' },
    { id: 'brandVoiceId', type: 'value' },
  ];

  // Restore saved state
  try {
    const saved = localStorage.getItem(CONV_STORAGE_KEY);
    if (saved) {
      const data = JSON.parse(saved);
      for (const { id, type } of convFields) {
        const el = document.getElementById(id);
        if (!el || data[id] === undefined) continue;
        if (type === 'checkbox') el.checked = data[id];
        else el.value = data[id];
      }
    }
  } catch {
    // Corrupted or missing data — ignore
  }

  // Save on every change (debounced)
  let saveTimer = null;
  const save = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const data = {};
      for (const { id, type } of convFields) {
        const el = document.getElementById(id);
        if (!el) continue;
        data[id] = type === 'checkbox' ? el.checked : el.value;
      }
      try {
        localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(data));
      } catch {
        // Storage full — silently ignore
      }
    }, 300);
  };

  for (const { id, type } of convFields) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener(type === 'checkbox' ? 'change' : 'input', save);
  }

  // Expose save so the createConversation handler can trigger persistence.
  // MutationObserver cannot detect .value property changes on inputs, so we
  // rely on callers dispatching an 'input' event or invoking saveConvState()
  // directly.
  window.__saveConvState = save;
})();

// UI-3: Sidebar resize via drag handle (mouse + touch)
(function initSidebarResize() {
  const handle = document.querySelector('.sidebar-resize-handle');
  if (!handle) return;
  const sidebar = handle.closest('.sidebar');
  if (!sidebar) return;
  const root = document.documentElement;

  let isDragging = false;

  function getResizeMetrics() {
    const minW = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-min-width')) || 200;
    const maxW = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-max-width')) || 320;
    const current = parseInt(getComputedStyle(root).getPropertyValue('--sidebar-width')) || 280;
    return { minW, maxW, current };
  }

  function syncResizeAria(width = getResizeMetrics().current) {
    const { minW, maxW } = getResizeMetrics();
    handle.setAttribute('aria-valuemin', String(minW));
    handle.setAttribute('aria-valuemax', String(maxW));
    handle.setAttribute('aria-valuenow', String(width));
  }

  function applyWidth(clientX) {
    const { minW, maxW } = getResizeMetrics();
    let w = clientX;
    if (w < minW) w = minW;
    if (w > maxW) w = maxW;
    root.style.setProperty('--sidebar-width', w + 'px');
    syncResizeAria(w);
  }

  const setDragging = (dragging) => {
    isDragging = dragging;
    syncResizeAria();
  };

  // Mouse events
  handle.addEventListener('mousedown', (e) => {
    setDragging(true);
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    applyWidth(e.clientX);
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      setDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  // Touch events
  handle.addEventListener(
    'touchstart',
    () => {
      setDragging(true);
      document.body.style.userSelect = 'none';
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!isDragging) return;
      const touch = e.touches[0];
      if (touch) applyWidth(touch.clientX);
    },
    { passive: true },
  );

  document.addEventListener('touchend', () => {
    if (isDragging) {
      setDragging(false);
      document.body.style.userSelect = '';
    }
  });

  // Keyboard support
  handle.addEventListener('keydown', (e) => {
    const { minW, maxW, current } = getResizeMetrics();
    const step = e.shiftKey ? 20 : 5;
    let nextWidth;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      nextWidth = Math.max(minW, current - step);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      nextWidth = Math.min(maxW, current + step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextWidth = minW;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextWidth = maxW;
    } else {
      return;
    }
    root.style.setProperty('--sidebar-width', nextWidth + 'px');
    syncResizeAria(nextWidth);
  });

  syncResizeAria();
})();
