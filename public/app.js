/**
 * Main application logic for 1min.ai Monaco Client
 * Depends on: js/api.js, js/dom-style.js, js/models.js, js/toast.js, js/utils.js
 */

import {
  loadModels,
  initModelPickers,
  getAllChatModels,
  getAllCodeModels,
  getAllImageModels,
} from "./js/models.js";
import { api } from "./js/api.js";
import {
  SVG_NS,
  escapeHtml,
  renderMarkdownSafely,
  formatMarkdownLike,
  createSvgIcon,
  appendStepIcon,
  stripMarkdownCodeBlock,
  unescapeXmlText,
  parseXMLTags,
  extractText,
} from "./js/utils.js";
import { initTheme, toggleTheme as toggleThemeFn, updateThemeUI, isDarkTheme } from "./js/theme.js";
import { bootstrapSettings } from "./js/settings.js";
import { createChatManager, createChatState } from "./js/chat.js";
import { createImageManager, createImageState } from "./js/image.js";
import { createEditorManager, createEditorState } from "./js/editor.js";
import { createInlineChatManager } from "./js/inline-chat.js";
import { createEditorTabManager } from "./js/editor-tabs.js";

// Helper to get element by ID
const $ = (id) => document.getElementById(id);

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
  chatLog: $("chatLog"),
  chatPrompt: $("chatPrompt"),
  sendChatBtn: $("sendChat"),
  abortChatBtn: $("abortChat"),
  chatModel: $("chatModel"),
  chatModelLabel: $("chatModelLabel"),
  conversationId: $("conversationId"),
  conversationTitle: $("conversationTitle"),
  webSearch: $("webSearch"),
  chatNumOfSite: $("chatNumOfSite"),
  chatMaxWord: $("chatMaxWord"),
  withMemories: $("withMemories"),
  isMixed: $("isMixed"),
  brandVoiceId: $("brandVoiceId"),
  chatAttachments: $("chatAttachments"),
  attachmentPreviews: $("attachmentPreviews"),
  chatImageInput: $("chatImageInput"),
  attachImageBtn: $("attachImageBtn"),

  imagePrompt: $("imagePrompt"),
  imageModel: $("imageModel"),
  imageModelLabel: $("imageModelLabel"),
  imageGallery: $("imageGallery"),
  assetResult: $("assetResult"),
  editorImageUrl: $("editorImageUrl"),
  editorImagePreview: $("editorImagePreview"),
  clearImageBtn: $("clearImageBtn"),
  generateImage: $("generateImage"),
  uploadAsset: $("uploadAsset"),

  explorerPath: $("explorerPath"),
  fileTree: $("fileTree"),
  currentFileName: $("currentFileName"),
  saveFileBtn: $("saveFileBtn"),
  editorTabsBar: $("editorTabsBar"),
  rootSelector: $("rootSelector"),

  agentInstruction: $("agentInstruction"),
  agentStatus: $("agentStatus"),
  agentActivityLog: $("agentActivityLog"),
  startAgentBtn: $("startAgentBtn"),
  stopAgentBtn: $("stopAgentBtn"),
  resetAgentBtn: $("resetAgentBtn"),
  agentFeedbackInput: $("agentFeedbackInput"),
  sendAgentFeedbackBtn: $("sendAgentFeedbackBtn"),
  codeModel: $("codeModel"),
  codeWebSearch: $("codeWebSearch"),
  codeNumOfSite: $("codeNumOfSite"),
  codeMaxWord: $("codeMaxWord"),
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
    current: "dark",
  },
  creditSaving: false,
};

// Theme toggle handler
function toggleTheme() {
  const next = toggleThemeFn();
  editorManager.updateTheme();
}

// Initialize theme and settings on DOM ready
if (document.readyState === "loading") {
  document.addEventListener(
    "DOMContentLoaded",
    () => {
      initTheme();
      $("themeToggle")?.addEventListener("click", toggleTheme);
      bootstrapSettings();
    },
    { once: true },
  );
} else {
  initTheme();
  $("themeToggle")?.addEventListener("click", toggleTheme);
  bootstrapSettings();
}

// navigation
for (const btn of document.querySelectorAll(".nav")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav,.view").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.view).classList.add("active");
    $("viewTitle").textContent = btn.textContent.trim();
    if (btn.dataset.view === "coding") setTimeout(() => editorManager.layout(), 100);
  });
}

$("healthBtn").onclick = async () => {
  try {
    const data = await api("/api/health");
    toast.success(JSON.stringify(data, null, 2), { duration: 8000 });
  } catch (e) {
    toast.error(`ヘルスチェック失敗: ${e.message}`);
  }
};

// Initialize managers
const chatState = createChatState();
const imageState = createImageState();
const editorState = createEditorState();

const chatManager = createChatManager(dom, { chat: chatState });
const imageManager = createImageManager(dom);
const editorManager = createEditorManager(editorState);

// Create tab and inline-chat managers
const tabManager = createEditorTabManager(editorState, editorManager, dom);
const inlineChatManager = createInlineChatManager(editorState, editorManager, dom);

// Expose for editor.js keyboard shortcuts (saveFile, toggleInlineChat).
// These are needed because editor.js is initialized asynchronously via AMD loader
// and cannot import from app.js directly.
window.saveFile = tabManager.saveFile;
window.toggleInlineChat = inlineChatManager.toggleInlineChat;

// Merge state for compatibility
state.chat = chatState;
state.image = imageState;
state.editor = editorState;

// Use chat manager for sending and aborting
$("abortChat").onclick = () => chatManager.abortChat();
dom.sendChatBtn.onclick = () => chatManager.sendChat(setStatus);

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
      const isImage = file.type.startsWith("image/");
      const previewUrl = isImage ? URL.createObjectURL(file) : null;
      const att = {
        file,
        previewUrl,
        assetKey: null,
        assetUrl: null,
        uploading: false,
        type: isImage ? "image" : "file",
      };
      state.chat.attachments.push(att);
    }

    chatManager.updateAttachmentPreview();
    e.target.value = "";
  };
}

// Check health on startup
async function checkHealth() {
  try {
    const data = await api("/api/health");
    if (!data?.ok) {
      toast.error("サーバーのヘルスチェックに失敗しました。", {
        duration: 10000,
      });
      setStatus("ヘルスチェック失敗", "err");
    } else if (data.models && !data.models.ok) {
      console.warn("Model sync failure:", data.models.error);
      toast.warning(
        `モデル情報の同期に失敗しています。以前のデータを使用します: ${data.models.error}`,
        {
          duration: 8000,
        },
      );
    }
  } catch (e) {
    console.error("Health check failed:", e);
  }
}
checkHealth();

$("createConversation").onclick = async () => {
  try {
    const data = await api("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: dom.conversationTitle.value, model: dom.chatModel.value }),
    });
    const id =
      data?.conversation?.uuid ||
      data?.uuid ||
      data?.aiRecord?.conversationId ||
      data?.conversationId ||
      "";
    dom.conversationId.value = id;
    toast.success("会話を作成しました", { duration: 5000 });
  } catch (e) {
    toast.error(`会話の作成に失敗しました: ${e.message}`);
  }
};

// Image operations delegated to imageManager

dom.generateImage.onclick = () => imageManager.generateImage();

dom.uploadAsset.onclick = async () => {
  const file = $("assetInput").files[0];
  if (!file) {
    toast.warning("画像ファイルを選択してください");
    return;
  }
  await imageManager.performAssetUpload(file, setStatus);
};

$("assetInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (file) {
    await imageManager.performAssetUpload(file, setStatus);
  }
};

dom.editorImageUrl.oninput = () => imageManager.updateEditorImagePreview();

dom.clearImageBtn.onclick = () => imageManager.clearImage();

// Editor tab management (delegated to tabManager)
const renderTabs = () => tabManager.renderTabs();
const switchToTab = (filePath) => tabManager.switchToTab(filePath);
const closeTab = (filePath) => tabManager.closeTab(filePath);
const closeTabInternal = (filePath) => tabManager.closeTabInternal(filePath);
const openFile = (filePath) => tabManager.openFile(filePath);
const saveFile = () => tabManager.saveFile();

// Initialize Monaco Editor
require.config({ paths: { vs: "/vs" } });
require(["vs/editor/editor.main"], () => {
  editorManager.init();
}, (err) => {
  // #22: Monaco AMD loader failure — show user-visible error
  const msg = err?.message || err || "Failed to load Monaco Editor from CDN";
  toast.error(`Monaco Editor の読み込みに失敗しました: ${msg}`);
  console.error("Monaco AMD load error:", err);
});

// Inline chat (delegated to inlineChatManager)
const inlineChatWidget = inlineChatManager.widget;
const submitInlineChat = inlineChatManager.submitInlineChat;
// toggleInlineChat and closeInlineChat are set on window above via inlineChatManager

async function loadWorkspace(dirPath = null) {
  try {
    const tree = dom.fileTree;
    tree.textContent = "";
    // skeleton nodes with createElement
    for (let i = 0; i < 6; i++) {
      const skeleton = document.createElement("div");
      skeleton.className = "skeleton-node";
      const icon = document.createElement("div");
      icon.className = "skeleton skeleton-icon";
      const line = document.createElement("div");
      line.className = "skeleton skeleton-line w-75";
      skeleton.appendChild(icon);
      skeleton.appendChild(line);
      tree.appendChild(skeleton);
    }

    const data = await api(`/api/fs/list${dirPath ? `?dir=${encodeURIComponent(dirPath)}` : ""}`);
    dom.explorerPath.value = data.dir;
    tree.textContent = "";
    await renderTreeNodes(data.items, tree, 0);
  } catch (e) {
    toast.error(`ワークスペースの読み込みに失敗しました: ${e.message}`);
  }
}

async function renderTreeNodes(items, container, depth = 0) {
  for (const item of items) {
    const node = document.createElement("div");
    node.className = `tree-node ${item.isDirectory ? "folder" : "file"}`;
    node.dataset.path = item.path;
    node.dataset.depth = depth;
    node.setAttribute("role", "treeitem");
    node.setAttribute("tabindex", "0");
    if (item.isDirectory) {
      node.setAttribute("aria-expanded", "false");
    }

    const toggle = document.createElement("span");
    toggle.className = "node-toggle";
    if (item.isDirectory) {
      // UI-11: Use SVG arrow for expand/collapse instead of text characters
      toggle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
    }
    node.appendChild(toggle);

    const icon = document.createElement("span");
    icon.className = "node-icon";
    icon.textContent = item.isDirectory ? "📁" : "📄";
    node.appendChild(icon);

    const name = document.createElement("span");
    name.className = "node-name";
    name.textContent = item.name;
    node.appendChild(name);

    container.appendChild(node);

    if (item.isDirectory) {
      const childrenContainer = document.createElement("div");
      childrenContainer.className = "tree-children";
      childrenContainer.setAttribute("role", "group");
      container.appendChild(childrenContainer);

      node.onclick = async (e) => {
        e.stopPropagation();
        const isExpanded = node.classList.toggle("expanded");
        node.setAttribute("aria-expanded", String(isExpanded));
        if (isExpanded) {
          childrenContainer.classList.add("is-expanded");
          toggle.classList.add("expanded");
          if (childrenContainer.childElementCount === 0) {
            try {
              const res = await api(`/api/fs/list?dir=${encodeURIComponent(item.path)}`);
              await renderTreeNodes(res.items, childrenContainer, depth + 1);
            } catch (err) {
              console.error(err);
            }
          }
        } else {
          childrenContainer.classList.remove("is-expanded");
          toggle.classList.remove("expanded");
        }
      };
    } else {
      node.onclick = (e) => {
        e.stopPropagation();
        openFile(item.path);
      };
    }

    node.onkeydown = async (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        node.click();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = getNextVisibleNode(node);
        if (next) next.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = getPrevVisibleNode(node);
        if (prev) prev.focus();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (item.isDirectory) {
          if (!node.classList.contains("expanded")) {
            node.click();
          } else {
            const group = node.nextElementSibling;
            if (group && group.classList.contains("tree-children")) {
              const firstChild = group.querySelector(".tree-node");
              if (firstChild) firstChild.focus();
            }
          }
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (item.isDirectory && node.classList.contains("expanded")) {
          node.click();
        } else {
          const group = node.parentElement;
          if (group && group.classList.contains("tree-children")) {
            const parentNode = group.previousElementSibling;
            if (parentNode && parentNode.classList.contains("tree-node")) {
              parentNode.focus();
            }
          }
        }
      }
    };
  }
}

function getVisibleNodes() {
  const tree = dom.fileTree;
  if (!tree) return [];
  return Array.from(tree.querySelectorAll(".tree-node")).filter((n) => {
    let parentGroup = n.parentElement;
    while (parentGroup && parentGroup !== tree) {
      if (
        parentGroup.classList.contains("tree-children") &&
        !parentGroup.classList.contains("is-expanded")
      ) {
        return false;
      }
      parentGroup = parentGroup.parentElement;
    }
    return true;
  });
}

function getNextVisibleNode(node) {
  const visible = getVisibleNodes();
  const idx = visible.indexOf(node);
  if (idx !== -1 && idx < visible.length - 1) {
    return visible[idx + 1];
  }
  return null;
}

function getPrevVisibleNode(node) {
  const visible = getVisibleNodes();
  const idx = visible.indexOf(node);
  if (idx > 0) {
    return visible[idx - 1];
  }
  return null;
}

// openFile and saveFile are delegated to tabManager (see editor tab aliases above)

$("explorerRefresh").onclick = () => {
  const pathVal = dom.explorerPath.value.trim();
  loadWorkspace(pathVal || null);
};

dom.explorerPath.onkeydown = (e) => {
  if (e.key === "Enter") {
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
  const el = $("status");
  if (!el) return;
  el.textContent = text;
  el.className = cls ? `status ${cls}` : "status";
}

// Pure helper functions (escapeHtml, renderMarkdownSafely, formatMarkdownLike,
// createSvgIcon, appendStepIcon, stripMarkdownCodeBlock, unescapeXmlText,
// parseXMLTags) and SVG_NS are imported from js/utils.js.

function addAgentTimelineStep(type, title, body, resultText = null) {
  const log = dom.agentActivityLog;
  if (!log) return;

  // Remove placeholder if present
  const placeholder = log.querySelector(".timeline-placeholder");
  if (placeholder) placeholder.remove();

  const stepId = "step-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);

  const step = document.createElement("div");
  step.className = `agent-step ${type}`;
  step.id = stepId;

  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const card = document.createElement("div");
  card.className = "agent-step-card";

  const header = document.createElement("div");
  header.className = "agent-step-header";

  const iconSpan = document.createElement("span");
  iconSpan.className = "agent-step-icon";
  appendStepIcon(iconSpan, type);
  iconSpan.appendChild(document.createTextNode(title));
  header.appendChild(iconSpan);

  const timeSpan = document.createElement("span");
  timeSpan.className = "agent-step-time";
  timeSpan.textContent = time;
  header.appendChild(timeSpan);

  card.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "agent-step-body";

  const isLongThought = type === "thought" && body && body.length > 100;
  if (isLongThought) {
    const toggleDiv = document.createElement("div");
    toggleDiv.className = "agent-step-thought-toggle";
    const toggleSpan = document.createElement("span");
    toggleSpan.textContent = "▶ 思考プロセスを展開";
    toggleDiv.appendChild(toggleSpan);

    const thoughtBox = document.createElement("div");
    thoughtBox.className = "agent-step-thought-box u-hidden";
    thoughtBox.appendChild(bodyEl);

    toggleDiv.onclick = () => {
      const willBeHidden = !thoughtBox.classList.contains("u-hidden");
      thoughtBox.classList.toggle("u-hidden", willBeHidden);
      toggleSpan.textContent = willBeHidden ? "▶ 思考プロセスを展開" : "▼ 思考プロセスを折りたたむ";
    };

    card.appendChild(toggleDiv);
    card.appendChild(thoughtBox);
  } else {
    card.appendChild(bodyEl);
  }

  if (resultText !== null) {
    const toggleDiv = document.createElement("div");
    toggleDiv.className = "agent-step-result-toggle";
    const toggleSpan = document.createElement("span");
    toggleSpan.textContent = "▶ 実行出力を表示";
    toggleDiv.appendChild(toggleSpan);
    toggleDiv.onclick = () => toggleTimelineResult(stepId);
    card.appendChild(toggleDiv);

    const resultPre = document.createElement("pre");
    resultPre.id = "result-" + stepId;
    resultPre.className = "agent-step-result-box u-hidden";
    resultPre.textContent = resultText;
    card.appendChild(resultPre);
  }

  step.appendChild(card);
  if (bodyEl) {
    renderMarkdownSafely(bodyEl, body);
  }

  log.appendChild(step);
  log.scrollTop = log.scrollHeight;
  return stepId;
}

window.toggleTimelineResult = function (stepId) {
  const box = document.getElementById(`result-${stepId}`);
  if (!box) return;
  const toggle = box.previousElementSibling;
  const toggleSpan = toggle.querySelector("span");
  const willBeHidden = !box.classList.contains("u-hidden");
  box.classList.toggle("u-hidden", willBeHidden);
  if (toggleSpan) {
    toggleSpan.textContent = willBeHidden ? "▶ 実行出力を表示" : "▼ 実行出力を非表示";
  }
};

function addAgentApprovalStep(command, cwd, approvalToken, onApprove, onReject) {
  const log = dom.agentActivityLog;
  if (!log) return;
  const placeholder = log.querySelector(".timeline-placeholder");
  if (placeholder) placeholder.remove();

  const stepId = "step-approval-" + Date.now();

  const step = document.createElement("div");
  step.className = `agent-step approval`;
  step.id = stepId;

  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const card = document.createElement("div");
  card.className = "agent-step-card";

  const header = document.createElement("div");
  header.className = "agent-step-header";

  const iconSpan = document.createElement("span");
  iconSpan.className = "agent-step-icon";
  appendStepIcon(iconSpan, "approval");
  iconSpan.appendChild(document.createTextNode("コマンド実行"));

  const timeSpan = document.createElement("span");
  timeSpan.className = "agent-step-time";
  timeSpan.textContent = time;

  header.appendChild(iconSpan);
  header.appendChild(timeSpan);

  const body = document.createElement("div");
  body.className = "agent-step-body";
  body.textContent = "エージェントが以下のコマンドを実行しようとしています。";

  const details = document.createElement("div");
  details.className = "approval-details";

  const cmdLabel = document.createElement("strong");
  cmdLabel.textContent = "コマンド: ";
  const cmdCode = document.createElement("code");
  cmdCode.textContent = command;

  const dirLabel = document.createElement("strong");
  dirLabel.textContent = "実行ディレクトリ: ";
  const dirCode = document.createElement("code");
  dirCode.textContent = cwd;

  details.appendChild(cmdLabel);
  details.appendChild(cmdCode);
  details.appendChild(document.createElement("br"));
  details.appendChild(dirLabel);
  details.appendChild(dirCode);

  const feedbackInput = document.createElement("input");
  feedbackInput.type = "text";
  feedbackInput.id = `feedback-${stepId}`;
  feedbackInput.className = "approval-feedback-input";
  feedbackInput.placeholder = "却下する場合は理由を入力してください...";

  const actions = document.createElement("div");
  actions.className = "approval-actions";

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "approval-btn approve";
  approveBtn.id = `approve-${stepId}`;
  approveBtn.textContent = "許可";

  const rejectBtn = document.createElement("button");
  rejectBtn.type = "button";
  rejectBtn.className = "approval-btn reject";
  rejectBtn.id = `reject-${stepId}`;
  rejectBtn.textContent = "却下";

  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);

  body.appendChild(details);
  body.appendChild(feedbackInput);
  body.appendChild(actions);

  card.appendChild(header);
  card.appendChild(body);

  step.textContent = "";
  step.appendChild(card);

  log.appendChild(step);
  log.scrollTop = log.scrollHeight;

  // M-9: Fade out the approval step once it has been resolved (after a short
  // delay so the user can still read the final state). This avoids leaving
  // stale approval cards on screen that may confuse the user about whether
  // an action is still pending.
  let finalized = false;
  const finalizeStep = () => {
    if (finalized) return;
    finalized = true;
    setTimeout(() => {
      step.classList.add("is-fading");
      setTimeout(() => {
        step.remove();
      }, 450);
    }, 1500);
  };
  // M-2: Expose finalizeStep on the step element so external flows (reset,
  // stop) can clean up pending approval cards without leaving orphan UI.
  step.__finalizeApproval = finalizeStep;

  approveBtn.onclick = () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    feedbackInput.disabled = true;
    approveBtn.textContent = "許可済み";
    approveBtn.classList.add("is-disabled");
    onApprove();
    finalizeStep();
  };

  rejectBtn.onclick = () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    feedbackInput.disabled = true;
    rejectBtn.textContent = "却下済み";
    rejectBtn.classList.add("is-disabled");
    const reason = feedbackInput.value.trim() || "ユーザーによって却下されました";
    onReject(reason);
    finalizeStep();
  };
}

let diffEditor = null;

async function showDiffDialog(filePath, oldContent, newContent) {
  try {
    const modal = $("diffModal");
    const container = $("diffEditorContainer");
    const pathLabel = $("diffFilePath");
    const inlineToggle = $("diffInlineToggle");

    pathLabel.textContent = `ファイル: ${filePath}`;
    modal.classList.remove("u-hidden");

    const isInline = localStorage.getItem("diffRenderInline") === "true";
    if (inlineToggle) {
      inlineToggle.checked = isInline;
      inlineToggle.onchange = (e) => {
        const inline = e.target.checked;
        localStorage.setItem("diffRenderInline", inline);
        if (diffEditor) diffEditor.updateOptions({ renderSideBySide: !inline });
      };
    }

    if (!diffEditor) {
      diffEditor = monaco.editor.createDiffEditor(container, {
        theme: document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark",
        automaticLayout: true,
        readOnly: true,
        renderSideBySide: !isInline,
      });
    } else {
      diffEditor.updateOptions({
        theme: document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark",
        renderSideBySide: !isInline,
      });
    }

    const baseName =
      filePath
        .split(/[\\/]/)
        .pop()
        .replace(/[^a-zA-Z0-9_.-]/g, "_") || "file";
    const safePath = "/" + baseName;
    const originalUri = monaco.Uri.from({ scheme: "diff-original", path: safePath });
    const modifiedUri = monaco.Uri.from({ scheme: "diff-modified", path: safePath });

    let originalModel = monaco.editor.getModel(originalUri);
    if (originalModel) originalModel.dispose();
    let modifiedModel = monaco.editor.getModel(modifiedUri);
    if (modifiedModel) modifiedModel.dispose();

    originalModel = monaco.editor.createModel(oldContent, undefined, originalUri);
    modifiedModel = monaco.editor.createModel(newContent, undefined, modifiedUri);
    diffEditor.setModel({ original: originalModel, modified: modifiedModel });

    // Precise layout calculation when modal becomes visible
    const observer = new ResizeObserver(() => {
      if (diffEditor && modal.offsetParent !== null) {
        diffEditor.layout();
      }
    });
    observer.observe(container);

    return new Promise((resolve) => {
      const cleanup = (val) => {
        observer.disconnect();
        modal.classList.add("u-hidden");
        if (diffEditor) diffEditor.setModel(null);
        originalModel.dispose();
        modifiedModel.dispose();
        document.removeEventListener("keydown", onKey);
        resolve(val);
      };
      $("diffApply").onclick = () => cleanup(true);
      $("diffCancel").onclick = () => cleanup(false);

      // #19: Close diff dialog on Escape, cleaning up ResizeObserver
      const onKey = (e) => {
        if (e.key === "Escape" && !modal.classList.contains("u-hidden")) {
          cleanup(false);
        }
      };
      document.addEventListener("keydown", onKey);
    });
  } catch (error) {
    console.error("showDiffDialog error:", error);
    toast.error("差分表示エラー: " + error.message);
    $("diffModal").classList.add("u-hidden");
    return false;
  }
}

function resolvePathRelativeToWorkspace(workspaceRoot, filePath) {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("/") || filePath.startsWith("\\")) {
    return filePath;
  }
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const rootTrimmed = workspaceRoot.replace(/[\\/]+$/, "");
  const fileTrimmed = filePath.replace(/^[\\/]+/, "");
  return `${rootTrimmed}${separator}${fileTrimmed}`;
}

function estimateTokens(text) {
  if (!text) return 0;
  // Better heuristic for English vs Japanese:
  // Latin characters are ~4 per token. Japanese/CJK characters are ~1.2 per token.
  const latinMatch = text.match(/[a-zA-Z0-9\s!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/g);
  const latinCount = latinMatch ? latinMatch.length : 0;
  const multiByteCount = text.length - latinCount;
  return Math.ceil(latinCount / 4 + multiByteCount * 1.2);
}

function trimAgentHistory(history, maxTokens) {
  if (maxTokens === undefined) {
    maxTokens = state.creditSaving ? 15000 : 45000;
  }
  let totalTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    totalTokens += estimateTokens(history[i].content);
    if (totalTokens > maxTokens && i > 0) {
      const removed = history.splice(0, i);
      history.unshift({
        role: "user",
        content: `[コンテキスト省略: ${removed.length}件のメッセージを要約]\n前回までの操作を continues してください。`,
      });
      return;
    }
  }
}

const AGENT_TOOL_HANDLERS = {
  read_file: async ({ sessionId, workspaceRoot, params }) => {
    const { path: filePath } = params;
    if (!filePath) throw new Error("path パラメータが必要です");
    const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
    const data = await api(
      `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
    );
    await openFile(fullPath);
    return { text: data.content, success: true };
  },
  write_file: async ({ sessionId, workspaceRoot, params }) => {
    const { path: filePath, content } = params;
    if (!filePath) throw new Error("path パラメータが必要です");
    const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
    await api(`/api/agent/sessions/${sessionId}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath, content }),
    });
    await openFile(fullPath);
    return { text: `ファイル ${filePath} の書き込みに成功しました。`, success: true };
  },
  apply_diff: async ({ sessionId, workspaceRoot, params }) => {
    const { path: filePath, diff } = params;
    if (!filePath) throw new Error("path パラメータが必要です");
    if (diff === undefined) throw new Error("diff パラメータが必要です");
    const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);

    const current = await api(
      `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
    );
    const preview = await api(`/api/agent/sessions/${sessionId}/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: fullPath, diff, dryRun: true }),
    });

    if (await showDiffDialog(filePath, current.content, preview.newContent || current.content)) {
      const res = await api(`/api/agent/sessions/${sessionId}/diff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fullPath, diff }),
      });
      await openFile(fullPath);
      return { text: res.message || "置換成功", success: true };
    }
    return { text: "ユーザーによって拒否されました", success: false };
  },
  list_directory: async ({ sessionId, workspaceRoot, params }) => {
    const dirPath = params.path || "";
    const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, dirPath);
    const data = await api(
      `/api/agent/sessions/${sessionId}/dir?path=${encodeURIComponent(fullPath)}`,
    );
    const text = data.items?.length
      ? data.items.map((i) => `- ${i.isDirectory ? "[Dir] " : "[File] "}${i.name}`).join("\n")
      : "ディレクトリは空または存在しません。";
    return { text, success: true };
  },
  search_files: async ({ sessionId, workspaceRoot, params }) => {
    const { query } = params;
    if (!query) throw new Error("query パラメータが必要です");
    const data = await api(
      `/api/agent/sessions/${sessionId}/search?query=${encodeURIComponent(query)}`,
    );
    const text = data.results?.length
      ? data.results.map((r) => `${r.file}:${r.line}: ${r.content}`).join("\n")
      : "検索結果なし";
    return { text, success: true };
  },
  run_command: async ({ sessionId, workspaceRoot, params }) => {
    const { command } = params;
    if (!command) throw new Error("command パラメータが必要です");

    // M-10: Reject nested approval requests. If a previous command is still
    // awaiting user approval, the resolver would be overwritten and the prior
    // Promise would hang forever. Force the agent to wait for the user to
    // resolve the in-flight approval.
    // M-1: signal this with a distinct marker so the agent loop can skip
    // burning an iteration (and an LLM call) on a recoverable condition.
    if (state.agent.resolver) {
      return {
        text: "別のコマンドが承認待ちです。先に承認/却下してください。",
        success: false,
        retryable: true,
      };
    }

    setAgentStatus("承認待ち...", "awaiting_approval");
    const runRes = await api(`/api/agent/sessions/${sessionId}/commands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, cwd: workspaceRoot }),
    });

    if (!runRes.requiresApproval) {
      return {
        text: `Exit Code: ${runRes.exitCode}\n\nSTDOUT:\n${runRes.stdout}\n\nSTDERR:\n${runRes.stderr}`,
        success: runRes.exitCode === 0,
      };
    }

    const approvalResult = await new Promise((resolve) => {
      state.agent.resolver = resolve;
      addAgentApprovalStep(
        command,
        workspaceRoot,
        runRes.approvalToken,
        async () => {
          setAgentStatus("実行中...", "executing");
          try {
            const res = await api(`/api/agent/sessions/${sessionId}/approve`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ approvalToken: runRes.approvalToken }),
            });
            resolve({ approved: true, result: res });
          } catch (e) {
            resolve({ approved: true, error: e });
          }
        },
        (reason) => resolve({ approved: false, reason }),
      );
    });

    state.agent.resolver = null;
    if (approvalResult.abort) return { text: "ABORTED", success: false, abort: true };
    if (!approvalResult.approved)
      return { text: `拒否されました: ${approvalResult.reason}`, success: false };
    if (approvalResult.error)
      return { text: `エラー: ${approvalResult.error.message}`, success: false };

    const { result } = approvalResult;
    return {
      text: `Exit Code: ${result.exitCode}\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`,
      success: result.exitCode === 0,
    };
  },
};

async function runAgentLoop(initialInstruction) {
  const workspaceRoot = dom.explorerPath.value || "";
  setAgentStatus("初期化中...", "thinking");

  // Show user's initial message as a user chat bubble
  addAgentTimelineStep("user", "指示", initialInstruction);

  if (!state.agent.sessionId) {
    try {
      const sessionData = await api("/api/agent/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: workspaceRoot,
          task: initialInstruction,
        }),
      });
      state.agent.sessionId = sessionData.session.id;
      addAgentTimelineStep(
        "thought",
        "セッション開始",
        `エージェントセッションが開始されました。\nワークスペース: ${workspaceRoot}`,
      );
    } catch (e) {
      addAgentTimelineStep(
        "error",
        "セッション作成失敗",
        `セッションの初期化に失敗しました: ${e.message}`,
      );
      setAgentStatus("エラー", "error");
      return;
    }
  } else {
    addAgentTimelineStep("thought", "セッション再開", `既存のセッションで追加指示を実行します。`);
  }

  const sessionId = state.agent.sessionId;

  let workspaceFilesText = `ワークスペースパス: ${workspaceRoot}\n`;
  try {
    const listRes = await api(`/api/fs/list?dir=${encodeURIComponent(workspaceRoot)}`);
    const filesList = listRes.items
      .map((item) => `- ${item.isDirectory ? "[Dir] " : "[File] "}${item.name}`)
      .join("\n");
    workspaceFilesText += filesList;
  } catch (err) {
    workspaceFilesText += "(ファイル一覧の取得に失敗しました)";
  }

  const modelSelected = $("codeModel").value;

  const sysPrompt = `あなたは極めて優秀なソフトウェアエンジニアAIエージェントです。
あなたの目的は、ユーザーの指示を「正確に」かつ「安全に」達成することです。
あなたは現在、隔離されたワークスペース内のファイルを直接操作できる特権セッションにいます。

【必須XML出力スキーマ】
各ターンは必ず以下の形式だけを出力してください。Markdownコードブロック、JSON、自由形式の説明文は禁止です。
<thought>...</thought><call_tool name="tool名"><parameter name="パラメータ名">値</parameter></call_tool>

1. read_file
   - パラメータ: { "path": "ファイルパス" }
   - 目的: 指定したファイルの内容を読み取る。ファイルを変更する前にすべて現在の内容を確認するために使用すること。
   <call_tool name="read_file"><parameter name="path">utils/helper.js</parameter></call_tool>

2. write_file
    - 【必須】このツールの <parameter> 値は XML テキストなので、& < > はそれぞれ &amp; &lt; &gt; に、完全なコードは省略せずにエスケープして出力してください。
   - パラメータ: { "path": "ファイルパス", "content": "完全なコード内容" }
   - 目的: 新規ファイルを作成するか、既存ファイル全体を上書きする。
   - **注意点**:
     - \`content\` パラメータには、絶対にマークダウンのコードブロック（例: \`\`\`js ... \`\`\`）を含めず、**プログラムの生テキストのみ**を直接記述してください。
     - HTML/XMLの実体参照エスケープ（\`&lt;\`や\`&gt;\`、\`&amp;\`など）は**一切行わず**、そのままの記号（\`<\`, \`>\`, \`&\`）で記述してください。
     - コードの途中で省略（例: \`// ... 残りのコード ...\`）せず、完全な内容を出力してください。
   <call_tool name="write_file"><parameter name="path">utils/helper.js</parameter><parameter name="content">export const add = (a, b) => a + b;</parameter></call_tool>

3. apply_diff
   - パラメータ: { "path": "ファイルパス", "diff": "SEARCH/REPLACEブロック形式の差分" }
   - 目的: ファイルの特定箇所のみを置換（編集）する。全文を書き換える write_file よりも軽量で安全なため、既存ファイルの編集にはこちらを使用すること。複数の箇所の置換（マルチブロック）も同時に実行可能です。
   - **注意点**:
     - \`diff\` パラメータには、絶対にマークダウンのコードブロック（例: \`\`\`diff ... \`\`\`）を含めず、かつ実体参照エスケープを行わずに、**以下のSEARCH/REPLACE形式のみ**を記述してください。
     - SEARCHブロックの内容は、ファイル内の対象コード（インデント・改行等含む）と完全に一致する必要があります。一意に特定できるように、十分な長さ（前後の行を含む）で指定してください。
     - 形式見本:
<<<<<<< SEARCH
[置換前の元のコード]
=======
[置換後の新しいコード]
>>>>>>> REPLACE
   <call_tool name="apply_diff"><parameter name="path">utils/helper.js</parameter><parameter name="diff"><<<<<<< SEARCH
export const add = (a, b) => a + b;
=======
export const add = (a, b) => {
  return a + b;
};
>>>>>>> REPLACE</parameter></call_tool>

4. list_directory
   - パラメータ: { "path": "ディレクトリパス" }
   - 目的: 指定したディレクトリの直下にあるファイルやフォルダの一覧を取得する。フォルダ構成や中身を把握する際に最初に使用すること。
   <call_tool name="list_directory"><parameter name="path">src</parameter></call_tool>

5. search_files
   - パラメータ: { "query": "検索文字列" }
   - 目的: プロジェクト全体から特定のシンボルや文字列を検索する。
   <call_tool name="search_files"><parameter name="query">app.listen</parameter></call_tool>

6. run_command
   - パラメータ: { "command": "シェルコマンド" }
   - 目的: テストの実行、依存関係の確認など。破壊的な操作は控え、実行前にユーザーの承認を求めることを想定すること。
   <call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>

【完了報告】
目的を完全に達成した場合は、ツールの代わりに <finish>要約</finish> タグを使い、何を行ったか簡潔に報告してください。

【重要な注意】
- 出力は必ず <thought> と <call_tool> (または <finish>) のペアのみにしてください。
- 余計な挨拶、マークダウンのコードブロック、解説文をタグの外側に含めないでください。
- parameter の値（特に content と diff）は XML テキストなので、& は &amp;、< は &lt;、> は &gt; に必ずエスケープしてください。
- diff の SEARCH/REPLACE マーカー（<<<<<<<、=======、>>>>>>>）も XML 内では &lt;&lt;&lt;&lt;&lt;&lt;&lt;、&gt;&gt;&gt;&gt;&gt;&gt;&gt; にエスケープしてください。
- 値の中身に Markdown のコードブロック記号は使わないでください。
- すでに存在するファイルを変更する場合、まず read_file で現在の内容を確認するか、または search_files や list_directory でファイル構成を把握することが必須です。

現在のワークスペース構造:
${workspaceFilesText}

現在の Monaco エディタで開いているファイル:
パス: ${state.editor.activeFilePath || "なし"}
`;

  if (state.agent.history.length === 0) {
    state.agent.history = [
      { role: "user", content: `${sysPrompt}\n\n【指示】\n${initialInstruction}` },
    ];
  } else {
    state.agent.history.push({
      role: "user",
      content: `【ユーザーからの追加指示】\n${initialInstruction}`,
    });
    trimAgentHistory(state.agent.history);
  }

  let loopCount = 0;
  const maxLoops = 20;

  while (state.agent.active && loopCount < maxLoops) {
    loopCount++;
    setAgentStatus("思考中...", "thinking");

    let chatRes;
    try {
      chatRes = await api("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: state.agent.history,
          model: modelSelected,
          webSearch: false,
        }),
      });
    } catch (e) {
      addAgentTimelineStep("error", "AI通信失敗", `AIとの通信に失敗しました: ${e.message}`);
      setAgentStatus("エラー", "error");
      break;
    }

    const aiText = chatRes.text || "";
    if (!aiText) {
      addAgentTimelineStep("error", "応答空", "AIからの応答が空でした。");
      setAgentStatus("エラー", "error");
      break;
    }

    const parsed = parseXMLTags(aiText);

    if (parsed.thought) {
      addAgentTimelineStep("thought", "思考プロセス", parsed.thought);
    } else {
      addAgentTimelineStep("thought", "思考プロセス", aiText);
    }

    if (parsed.finish) {
      addAgentTimelineStep(
        "result",
        "タスク完了",
        `エージェントがタスクの完了を報告しました。\n\n要約:\n${parsed.finish}`,
      );
      setAgentStatus("完了", "completed");
      break;
    }

    if (parsed.toolCall) {
      const toolName = parsed.toolCall.name;
      const params = parsed.toolCall.params;

      const paramListStr = Object.entries(params)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join("\n");
      addAgentTimelineStep("action", `ツール呼び出し: ${toolName}`, paramListStr);
      setAgentStatus("実行中...", "executing");

      let toolResultText = "";
      let toolSuccess = false;

      try {
        const handler = AGENT_TOOL_HANDLERS[toolName];
        if (!handler) throw new Error(`未知のツール: ${toolName}`);

        const result = await handler({
          sessionId,
          workspaceRoot,
          params,
        });

        if (result.abort) break;

        // M-1: If the handler signals a retryable condition (e.g. another
        // command is awaiting approval), don't burn an LLM iteration on it —
        // requeue the same AI output and continue without incrementing
        // loopCount. This avoids draining maxLoops while the user is
        // reviewing approvals.
        if (result.retryable) {
          state.agent.history.push({ role: "assistant", content: aiText });
          state.agent.history.push({
            role: "user",
            content: `<tool_response>\n${result.text}\n</tool_response>`,
          });
          trimAgentHistory(state.agent.history);
          loopCount = Math.max(0, loopCount - 1);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }

        toolResultText = result.text;
        toolSuccess = result.success;
      } catch (err) {
        toolResultText = `エラー: ${err.message}`;
        toolSuccess = false;
      }

      addAgentTimelineStep(
        toolSuccess ? "result" : "error",
        `ツール結果: ${toolName}`,
        toolSuccess ? "ツールの実行が完了しました。" : "エラーまたはキャンセルが発生しました。",
        toolResultText,
      );

      const feedbackMsg = `<tool_response>\n${toolResultText}\n</tool_response>`;

      state.agent.history.push({ role: "assistant", content: aiText });
      state.agent.history.push({ role: "user", content: feedbackMsg });
      trimAgentHistory(state.agent.history);
    } else {
      const errMsg = `エラー: ツール呼び出しまたはタスク完了タグ (<call_tool> または <finish>) が見つかりませんでした。\n指示に従って、思考を <thought>タグで囲み、直後に呼び出すツールを <call_tool> タグで指定してください。`;
      addAgentTimelineStep(
        "error",
        "パース失敗",
        "AIが定義されたXMLフォーマットに準拠していません。自動修正指示を送信します。",
      );

      state.agent.history.push({ role: "assistant", content: aiText });
      state.agent.history.push({ role: "user", content: errMsg });
      trimAgentHistory(state.agent.history);
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  if (loopCount >= maxLoops && state.agent.active) {
    addAgentTimelineStep(
      "error",
      "制限到達",
      `実行ステップ数が上限 (${maxLoops}) に達したため、安全のために停止しました。`,
    );
    setAgentStatus("エラー", "error");
  }

  state.agent.active = false;
  dom.startAgentBtn.classList.remove("is-hidden");
  dom.sendAgentFeedbackBtn.classList.remove("is-shown");
  dom.stopAgentBtn.classList.remove("is-shown");
  dom.resetAgentBtn.classList.remove("is-hidden");
  dom.agentInstruction.placeholder = "指示を入力してエージェントを開始...";
  if (dom.agentStatus.textContent !== "完了" && dom.agentStatus.textContent !== "エラー") {
    setAgentStatus("待機中", "idle");
  }
}

dom.startAgentBtn.onclick = async () => {
  if (state.agent.active) return;
  const instruction = dom.agentInstruction.value.trim();
  if (!instruction) {
    toast.warning("エージェントへの指示を入力してください");
    return;
  }

  // Clear input so user can type feedback immediately
  dom.agentInstruction.value = "";
  dom.agentInstruction.placeholder = "追加の指示やヒントを入力...";

  state.agent.active = true;
  dom.startAgentBtn.classList.add("is-hidden");
  dom.sendAgentFeedbackBtn.classList.add("is-shown");
  dom.stopAgentBtn.classList.add("is-shown");
  dom.resetAgentBtn.classList.add("is-hidden");

  try {
    await runAgentLoop(instruction);
  } catch (err) {
    console.error("Agent loop crashed:", err);
    setAgentStatus("エラー", "error");
    addAgentTimelineStep(
      "error",
      "システムクラッシュ",
      `エージェントのループ処理中に問題が発生しました: ${err.message}`,
    );
  } finally {
    state.agent.active = false;
    dom.startAgentBtn.classList.remove("is-hidden");
    dom.sendAgentFeedbackBtn.classList.remove("is-shown");
    dom.stopAgentBtn.classList.remove("is-shown");
    dom.resetAgentBtn.classList.remove("is-hidden");
    dom.agentInstruction.placeholder = "指示を入力してエージェントを開始...";
  }
};

dom.stopAgentBtn.onclick = () => {
  if (!state.agent.active) return;
  state.agent.active = false;
  if (state.agent.resolver) {
    state.agent.resolver({ abort: true });
  }
  // M-2: pending approvals become orphans once we stop the agent — clean them up.
  document.querySelectorAll(".agent-step.approval").forEach((el) => el.__finalizeApproval?.());
  setAgentStatus("停止", "idle");
  addAgentTimelineStep("thought", "停止", "ユーザーによって停止されました。");
};

dom.resetAgentBtn.onclick = async () => {
  const accepted = await toast.confirm("エージェントのセッション履歴をリセットしますか？", {
    type: "warning",
  });
  if (accepted) {
    if (state.agent.resolver) {
      state.agent.resolver({ abort: true });
    }
    // M-2: Clean up any pending approval cards so they don't outlive the
    // session (they would otherwise become "orphan" cards that fail if the
    // user clicks approve after reset).
    document.querySelectorAll(".agent-step.approval").forEach((el) => el.__finalizeApproval?.());
    state.agent.sessionId = null;
    state.agent.history = [];
    const log = dom.agentActivityLog;
    if (log) {
      log.textContent = "";
      const placeholder = document.createElement("div");
      placeholder.className = "timeline-placeholder timeline-placeholder-inline";
      placeholder.textContent = "指示を入力して、エージェントとのチャットを開始してください。";
      log.appendChild(placeholder);
    }
    setAgentStatus("待機中", "idle");
    dom.agentInstruction.placeholder = "指示を入力してエージェントを開始...";
    dom.startAgentBtn.classList.remove("is-hidden");
    dom.sendAgentFeedbackBtn.classList.remove("is-shown");
    dom.stopAgentBtn.classList.remove("is-shown");
    dom.resetAgentBtn.classList.remove("is-hidden");
    toast.success("セッションをリセットしました");
  }
};

dom.sendAgentFeedbackBtn.onclick = () => {
  const feedback = dom.agentInstruction.value.trim();
  if (!feedback) return;
  dom.agentInstruction.value = "";

  addAgentTimelineStep("user", "追加指示", feedback);

  if (state.agent.resolver) {
    state.agent.resolver({ approved: false, reason: `ユーザー指示: ${feedback}` });
  } else {
    state.agent.history.push({
      role: "user",
      content: `【ユーザーの追加フィードバック】\n${feedback}`,
    });
  }
};

dom.agentInstruction.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (state.agent.active) {
      dom.sendAgentFeedbackBtn.click();
    } else {
      dom.startAgentBtn.click();
    }
  }
});

async function initWorkspace() {
  try {
    const config = await api("/api/fs/config");

    // Populate root selector
    const rootSelector = $("rootSelector");
    if (rootSelector) {
      rootSelector.textContent = "";

      // Add default root
      const defaultOpt = document.createElement("option");
      defaultOpt.value = config.root;
      defaultOpt.textContent = `📁 ${config.root}`;
      rootSelector.appendChild(defaultOpt);

      // Add allowed roots if different from default
      if (config.allowedRoots && config.allowedRoots.length > 1) {
        for (const root of config.allowedRoots) {
          if (root !== config.root) {
            const opt = document.createElement("option");
            opt.value = root;
            opt.textContent = `📁 ${root}`;
            rootSelector.appendChild(opt);
          }
        }
      }

      // Add "Browse..." option
      const browseOpt = document.createElement("option");
      browseOpt.value = "__browse__";
      browseOpt.textContent = "📂 フォルダを選択...";
      rootSelector.appendChild(browseOpt);

      rootSelector.onchange = async () => {
        if (rootSelector.value === "__browse__") {
          openFolderPicker(config.root);
          rootSelector.value = config.root;
          return;
        }

        $("explorerPath").value = rootSelector.value;
        await loadWorkspace(rootSelector.value);
      };
    }

    // Open folder button
    const openFolderBtn = $("openFolderBtn");
    if (openFolderBtn && rootSelector) {
      openFolderBtn.onclick = () => {
        rootSelector.value = "__browse__";
        rootSelector.onchange();
      };
    }

    loadWorkspace(config.defaultRoot || config.root);
  } catch (e) {
    console.error("Failed to load initial config", e);
    loadWorkspace();
  }
}

function initFolderPicker() {
  const modal = $("folderPickerModal");
  const pathInput = $("folderPickerPath");
  const currentPath = $("folderPickerCurrentPath");
  const drives = $("folderPickerDrives");
  const body = $("folderPickerBody");
  const upButton = $("folderPickerUp");
  const openButton = $("folderPickerOpen");
  const cancelButton = $("folderPickerCancel");
  const errorBox = $("folderPickerError");

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

  let folderPickerCurrentPath = "";

  const hideError = () => {
    errorBox.classList.remove("is-shown");
    errorBox.textContent = "";
  };

  const setLoading = () => {
    body.textContent = "";
    const loadingDiv = document.createElement("div");
    loadingDiv.className = "folder-picker-loading";
    loadingDiv.textContent = "フォルダを読み込み中...";
    body.appendChild(loadingDiv);
  };

  const renderDrives = async () => {
    try {
      const data = await api("/api/fs/drives");
      drives.textContent = "";
      data.drives.forEach((drive) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "folder-picker-drive";
        button.textContent = drive.name;
        button.title = drive.path;
        button.onclick = () => {
          renderFolderPickerList(drive.path);
        };
        drives.appendChild(button);
      });
      updateDriveSelection();
    } catch (err) {
      drives.textContent = "";
    }
  };

  const updateDriveSelection = () => {
    [...drives.querySelectorAll(".folder-picker-drive")].forEach((button) => {
      const drivePath = button.title;
      const isDrive =
        folderPickerCurrentPath === drivePath ||
        folderPickerCurrentPath.toLowerCase().startsWith(drivePath.toLowerCase());
      button.classList.toggle("active", isDrive);
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
      body.textContent = "";

      const directories = data.items.filter((item) => item.isDirectory);
      if (directories.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "folder-picker-empty";
        emptyDiv.textContent = "表示できるフォルダがありません";
        body.appendChild(emptyDiv);
        return;
      }

      directories.forEach((item) => {
        const row = document.createElement("div");
        row.className = "folder-picker-item";
        row.tabIndex = 0;
        row.dataset.path = item.path;
        const iconSpan = document.createElement("span");
        iconSpan.className = "folder-picker-item-icon";
        iconSpan.textContent = "\uD83D\uDCC1";
        row.appendChild(iconSpan);
        const nameSpan = document.createElement("span");
        nameSpan.className = "folder-picker-item-name";
        nameSpan.textContent = item.name;
        row.appendChild(nameSpan);
        row.onclick = () => {
          pathInput.value = item.path;
          body
            .querySelectorAll(".folder-picker-item.selected")
            .forEach((el) => el.classList.remove("selected"));
          row.classList.add("selected");
          row.focus();
        };
        row.ondblclick = () => renderFolderPickerList(item.path);
        body.appendChild(row);
      });
    } catch (err) {
      body.textContent = "";
      const error = document.createElement("div");
      error.className = "folder-picker-error-text";
      error.textContent = `フォルダを読み込めませんでした: ${err?.message || "不明なエラー"}`;
      body.appendChild(error);
    }
  };

  window.openFolderPicker = (initialPath = "") => {
    const initial = initialPath || $("explorerPath").value || "";
    folderPickerCurrentPath = initial;
    hideError();
    modal.classList.remove("u-hidden");
    modal.classList.remove("is-hidden");
    renderDrives();
    renderFolderPickerList(initial);
    setTimeout(() => pathInput.focus(), 0);

    modal._previousFocus = document.activeElement;
    modal.addEventListener("keydown", trapFocus);
  };

  window.closeFolderPicker = () => {
    modal.classList.add("u-hidden");
    modal.classList.add("is-hidden");
    hideError();
    modal.removeEventListener("keydown", trapFocus);
    if (modal._previousFocus) {
      modal._previousFocus.focus();
    }
  };

  function trapFocus(e) {
    if (e.key !== "Tab") return;
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
    const normalized = folderPickerCurrentPath.replace(/[\\/]$/, "");
    if (/^[A-Za-z]:[\\/]?$/.test(normalized)) {
      return;
    }

    const lastSlash = Math.max(normalized.lastIndexOf("\\"), normalized.lastIndexOf("/"));
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
      errorBox.textContent = "フォルダの絶対パスを入力してください。";
      errorBox.classList.add("is-shown");
      return;
    }

    try {
      const res = await api("/api/fs/workspace/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: path }),
      });

      const rootSelector = $("rootSelector");
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
          const newOpt = document.createElement("option");
          newOpt.value = res.dir;
          newOpt.textContent = `📁 ${res.dir}`;
          rootSelector.insertBefore(newOpt, rootSelector.lastElementChild);
          rootSelector.value = res.dir;
        }
      }

      $("explorerPath").value = res.dir;
      await loadWorkspace(res.dir);
      window.closeFolderPicker();
    } catch (err) {
      errorBox.textContent = `フォルダ選択失敗: ${err.message}`;
      errorBox.classList.add("is-shown");
    }
  };

  cancelButton.onclick = window.closeFolderPicker;

  pathInput.onkeydown = (event) => {
    if (event.key === "Enter") {
      renderFolderPickerList(pathInput.value.trim());
    } else if (event.key === "Escape") {
      window.closeFolderPicker();
    }
  };

  body.onkeydown = (event) => {
    if (event.key === "Enter") {
      const selected = body.querySelector(".folder-picker-item.selected");
      if (selected) {
        renderFolderPickerList(selected.dataset.path);
      }
    } else if (event.key === "Escape") {
      window.closeFolderPicker();
    }
  };

  modal.onclick = (event) => {
    if (event.target === modal) {
      window.closeFolderPicker();
    }
  };
}

function selectModelForPicker(inputId, modelObj) {
  const hiddenInput = document.getElementById(inputId);
  if (hiddenInput) hiddenInput.value = modelObj.id;
  const btn = document.querySelector(`button[data-target-input="${inputId}"]`);
  const labelSpan = btn?.querySelector("span:first-of-type");
  if (labelSpan) labelSpan.textContent = modelObj.label;
}

const STORAGE_KEY_CREDIT_SAVING = "monaco_client_credit_saving";

function initCreditSavingMode() {
  const toggle = $("creditSavingToggle");
  if (!toggle) return;

  const saved = localStorage.getItem(STORAGE_KEY_CREDIT_SAVING);
  state.creditSaving = saved === "true";
  toggle.checked = state.creditSaving;

  toggle.onchange = (e) => {
    state.creditSaving = e.target.checked;
    localStorage.setItem(STORAGE_KEY_CREDIT_SAVING, state.creditSaving);
    applyCreditSavingMode();
  };

  applyCreditSavingMode();
}

function applyCreditSavingMode() {
  const webSearch = $("webSearch");
  const codeWebSearch = $("codeWebSearch");
  const numOutputs = $("numOutputs");
  const editorN = $("editorN");
  const editorQuality = $("editorQuality");

  if (state.creditSaving) {
    if (webSearch) {
      webSearch.checked = false;
      webSearch.disabled = true;
      const chatSettings = $("chatWebSearchSettings");
      if (chatSettings) chatSettings.classList.remove("is-shown");
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
      editorQuality.value = "medium";
      for (let i = 0; i < editorQuality.options.length; i++) {
        if (editorQuality.options[i].value === "high") {
          editorQuality.options[i].disabled = true;
        }
      }
    }

    const chatModels = getAllChatModels();
    if (chatModels.length > 0) {
      const currentChat = $("chatModel")?.value;
      const currentModelObj = chatModels.find((m) => m.id === currentChat);
      if (
        currentChat &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          chatModels.find((m) => m.id === "gpt-4o-mini") ||
          chatModels.find((m) => m.tags && m.tags.includes("fast"));
        if (fallback) selectModelForPicker("chatModel", fallback);
      }
    }

    const codeModels = getAllCodeModels();
    if (codeModels.length > 0) {
      const currentCode = $("codeModel")?.value;
      const currentModelObj = codeModels.find((m) => m.id === currentCode);
      if (
        currentCode &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          codeModels.find((m) => m.id === "qwen3-coder-flash") ||
          codeModels.find((m) => m.tags && m.tags.includes("fast"));
        if (fallback) selectModelForPicker("codeModel", fallback);
      }
    }

    const imgModels = getAllImageModels();
    if (imgModels.length > 0) {
      const currentImage = $("imageModel")?.value;
      const currentModelObj = imgModels.find((m) => m.id === currentImage);
      if (
        currentImage &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          imgModels.find((m) => m.id === "gpt-image-1-mini") ||
          imgModels.find((m) => m.tags && m.tags.includes("fast"));
        if (fallback) selectModelForPicker("imageModel", fallback);
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

initWorkspace();
initFolderPicker();
initCreditSavingMode();

// UI-3: Sidebar resize via drag handle
(function initSidebarResize() {
  const handle = document.querySelector(".sidebar-resize-handle");
  if (!handle) return;
  const sidebar = handle.closest(".sidebar");
  if (!sidebar) return;
  const root = document.documentElement;

  let isDragging = false;

  handle.addEventListener("mousedown", (e) => {
    isDragging = true;
    e.preventDefault();
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const minW = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-min-width")) || 200;
    const maxW = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-max-width")) || 320;
    let w = e.clientX;
    if (w < minW) w = minW;
    if (w > maxW) w = maxW;
    root.style.setProperty("--sidebar-width", w + "px");
  });

  document.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  });

  // Keyboard support
  handle.addEventListener("keydown", (e) => {
    const current = parseInt(getComputedStyle(root).getPropertyValue("--sidebar-width")) || 280;
    const step = e.shiftKey ? 20 : 5;
    if (e.key === "ArrowLeft") {
      root.style.setProperty("--sidebar-width", Math.max(200, current - step) + "px");
    } else if (e.key === "ArrowRight") {
      root.style.setProperty("--sidebar-width", Math.min(320, current + step) + "px");
    }
  });
})();
