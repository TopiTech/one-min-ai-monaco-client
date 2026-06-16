/**
 * Main application logic for 1min.ai Monaco Client
 * Depends on: js/api.js, js/models.js, js/toast.js
 */

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
  chat: {
    attachments: [],
    abortController: null,
    maxMessages: 200,
  },
  image: {
    maxCards: 50,
  },
  editor: {
    activeFilePath: null,
    openTabs: [],
    maxOpenModels: 20,
    isInlineChatOpen: false,
    inlineChatDom: null,
  },
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

// LocalStorage keys
const STORAGE_KEY_WEB_SEARCH = "monaco_client_code_web_search";
const STORAGE_KEY_NUM_OF_SITE = "monaco_client_code_num_of_site";
const STORAGE_KEY_MAX_WORD = "monaco_client_code_max_word";
const STORAGE_KEY_CHAT_WEB_SEARCH = "monaco_client_chat_web_search";
const STORAGE_KEY_CHAT_NUM_OF_SITE = "monaco_client_chat_num_of_site";
const STORAGE_KEY_CHAT_MAX_WORD = "monaco_client_chat_max_word";
const STORAGE_KEY_THEME = "monaco_client_theme";

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY_THEME);
  if (saved) {
    document.documentElement.setAttribute("data-theme", saved);
  }
  updateThemeUI();
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  let next;
  if (current === "light") {
    next = "dark";
  } else if (current === "dark") {
    next = "light";
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    next = prefersDark ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(STORAGE_KEY_THEME, next);
  updateThemeUI();
  if (window.editor) {
    window.editor.updateOptions({ theme: next === "light" ? "vs" : "vs-dark" });
  }
}

function updateThemeUI() {
  const theme = document.documentElement.getAttribute("data-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = theme === "dark" || (!theme && prefersDark);
  const iconDark = $("themeIconDark");
  const iconLight = $("themeIconLight");
  const label = $("themeLabel");
  if (iconDark) iconDark.style.display = isDark ? "none" : "block";
  if (iconLight) iconLight.style.display = isDark ? "block" : "none";
  if (label) label.textContent = isDark ? "ライトモード" : "ダークモード";
}

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  $("themeToggle")?.addEventListener("click", toggleTheme);
});

function initCodeGeneratorSettings() {
  const wsInput = $("codeWebSearch");
  const nosInput = $("codeNumOfSite");
  const mwInput = $("codeMaxWord");

  if (!wsInput || !nosInput || !mwInput) return;

  // Restore
  const savedWebSearch = localStorage.getItem(STORAGE_KEY_WEB_SEARCH);
  if (savedWebSearch !== null) {
    wsInput.checked = savedWebSearch === "true";
  }
  const savedNumOfSite = localStorage.getItem(STORAGE_KEY_NUM_OF_SITE);
  if (savedNumOfSite !== null) {
    nosInput.value = savedNumOfSite;
  }
  const savedMaxWord = localStorage.getItem(STORAGE_KEY_MAX_WORD);
  if (savedMaxWord !== null) {
    mwInput.value = savedMaxWord;
  }

  // Save on change
  wsInput.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEY_WEB_SEARCH, wsInput.checked);
  });
  nosInput.addEventListener("change", () => {
    let val = parseInt(nosInput.value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 10) val = 10;
    nosInput.value = val;
    localStorage.setItem(STORAGE_KEY_NUM_OF_SITE, val);
  });
  mwInput.addEventListener("change", () => {
    let val = parseInt(mwInput.value);
    if (isNaN(val) || val < 100) val = 100;
    if (val > 10000) val = 10000;
    mwInput.value = val;
    localStorage.setItem(STORAGE_KEY_MAX_WORD, val);
  });
}

function initChatSettings() {
  const wsInput = $("webSearch");
  const nosInput = $("chatNumOfSite");
  const mwInput = $("chatMaxWord");
  const settingsBox = $("chatWebSearchSettings");

  if (!wsInput || !nosInput || !mwInput || !settingsBox) return;

  const updateVisibility = () => {
    settingsBox.style.display = wsInput.checked ? "block" : "none";
  };

  // Restore
  const savedWebSearch = localStorage.getItem(STORAGE_KEY_CHAT_WEB_SEARCH);
  if (savedWebSearch !== null) {
    wsInput.checked = savedWebSearch === "true";
  }
  const savedNumOfSite = localStorage.getItem(STORAGE_KEY_CHAT_NUM_OF_SITE);
  if (savedNumOfSite !== null) {
    nosInput.value = savedNumOfSite;
  }
  const savedMaxWord = localStorage.getItem(STORAGE_KEY_CHAT_MAX_WORD);
  if (savedMaxWord !== null) {
    mwInput.value = savedMaxWord;
  }

  updateVisibility();

  // Save on change
  wsInput.addEventListener("change", () => {
    localStorage.setItem(STORAGE_KEY_CHAT_WEB_SEARCH, wsInput.checked);
    updateVisibility();
  });
  nosInput.addEventListener("change", () => {
    let val = parseInt(nosInput.value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 10) val = 10;
    nosInput.value = val;
    localStorage.setItem(STORAGE_KEY_CHAT_NUM_OF_SITE, val);
  });
  mwInput.addEventListener("change", () => {
    let val = parseInt(mwInput.value);
    if (isNaN(val) || val < 100) val = 100;
    if (val > 10000) val = 10000;
    mwInput.value = val;
    localStorage.setItem(STORAGE_KEY_CHAT_MAX_WORD, val);
  });
}

// Call on startup
document.addEventListener("DOMContentLoaded", () => {
  initCodeGeneratorSettings();
  initChatSettings();
});
if (document.readyState === "complete" || document.readyState === "interactive") {
  initCodeGeneratorSettings();
  initChatSettings();
}

// navigation
for (const btn of document.querySelectorAll(".nav")) {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav,.view").forEach((x) => x.classList.remove("active"));
    btn.classList.add("active");
    $(btn.dataset.view).classList.add("active");
    $("viewTitle").textContent = btn.textContent.trim();
    if (btn.dataset.view === "coding") setTimeout(() => window.editor?.layout(), 100);
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

const MAX_CHAT_MESSAGES = 200;
const MAX_IMAGE_CARDS = 50;

// chat
function pruneChatLog() {
  const log = dom.chatLog;
  if (!log) return;
  while (log.children.length > state.chat.maxMessages) {
    log.removeChild(log.firstChild);
  }
}

function pruneImageGallery() {
  const gallery = dom.imageGallery;
  if (!gallery) return;
  while (gallery.children.length > state.image.maxCards) {
    gallery.removeChild(gallery.lastChild);
  }
}

function addMsg(role, content, images = []) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "ai"}`;

  // Role label (safe text content)
  const roleSpan = document.createElement("span");
  roleSpan.className = "role";
  roleSpan.textContent = role;
  div.appendChild(roleSpan);

  // Add images if present
  if (images && images.length > 0) {
    const imagesDiv = document.createElement("div");
    imagesDiv.className = "msg-images";
    for (const img of images) {
      const imgEl = document.createElement("img");
      imgEl.className = "msg-image";
      imgEl.alt = "attached";
      imgEl.src = img.url || img.assetUrl || img;
      imgEl.onerror = function () {
        this.style.display = "none";
      };
      imagesDiv.appendChild(imgEl);
    }
    div.appendChild(imagesDiv);
  }

  // Add text content
  const contentDiv = document.createElement("div");
  contentDiv.className = "msg-content";
  if (role === "ai") {
    renderMarkdownSafely(contentDiv, content);
  } else {
    contentDiv.textContent = content;
  }
  div.appendChild(contentDiv);

  dom.chatLog.appendChild(div);
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
  pruneChatLog();
}

// Image attachment handling
function updateAttachmentPreview() {
  const container = dom.attachmentPreviews;
  const attachmentsArea = dom.chatAttachments;
  const attachments = state.chat.attachments;

  if (!container || !attachmentsArea) return;

  if (attachments.length === 0) {
    attachmentsArea.style.display = "none";
    container.textContent = "";
    return;
  }

  attachmentsArea.style.display = "block";
  container.textContent = "";

  attachments.forEach((att, index) => {
    const thumb = document.createElement("div");
    thumb.className = "attachment-thumb";

    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "remove-attachment";
    removeButton.dataset.index = index;
    removeButton.textContent = "×";

    if (att.type === "image" && att.previewUrl) {
      const img = document.createElement("img");
      img.src = att.previewUrl;
      img.alt = "preview";
      img.onerror = function () {
        this.style.display = "none";
      };
      thumb.appendChild(img);
    } else {
      const ext = att.file.name.split(".").pop().toUpperCase();

      const icon = document.createElement("div");
      icon.className = "attachment-file-icon";
      // Trusted SVG icon
      const svgIcon = document.createElementNS(SVG_NS, "svg");
      svgIcon.setAttribute("width", "24");
      svgIcon.setAttribute("height", "24");
      svgIcon.setAttribute("viewBox", "0 0 24 24");
      svgIcon.setAttribute("fill", "none");
      svgIcon.setAttribute("stroke", "currentColor");
      svgIcon.setAttribute("stroke-width", "2");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z");
      svgIcon.appendChild(path);
      const poly = document.createElementNS(SVG_NS, "polyline");
      poly.setAttribute("points", "14 2 14 8 20 8");
      svgIcon.appendChild(poly);
      icon.appendChild(svgIcon);

      const extSpan = document.createElement("span");
      extSpan.className = "attachment-file-ext";
      extSpan.textContent = ext;
      icon.appendChild(extSpan);

      const nameSpan = document.createElement("span");
      nameSpan.className = "attachment-file-name";
      nameSpan.textContent =
        att.file.name.length > 20 ? att.file.name.slice(0, 17) + "..." : att.file.name;
      nameSpan.title = att.file.name;

      thumb.appendChild(icon);
      thumb.appendChild(nameSpan);
    }

    thumb.appendChild(removeButton);
    if (att.uploading) {
      const spinner = document.createElement("div");
      spinner.className = "upload-spinner";
      thumb.appendChild(spinner);
    }

    container.appendChild(thumb);
  });

  // Bind remove buttons
  container.querySelectorAll(".remove-attachment").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.index);
      const attachments = state.chat.attachments;
      if (attachments[idx].previewUrl) URL.revokeObjectURL(attachments[idx].previewUrl);
      attachments.splice(idx, 1);
      updateAttachmentPreview();
    };
  });
}

// Attach image button
if (dom.attachImageBtn) {
  dom.attachImageBtn.onclick = () => {
    dom.chatImageInput.click();
  };
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

    updateAttachmentPreview();
    e.target.value = "";
  };
}

// Upload attachments to 1min.ai Asset API (parallel)
async function uploadAttachments() {
  const attachments = state.chat.attachments;
  const pending = attachments.filter((att) => !att.assetKey);

  if (pending.length === 0) {
    return attachments.map((att) => ({
      type: att.type || "image",
      assetKey: att.assetKey,
      url: att.assetUrl,
    }));
  }

  for (const att of pending) {
    att.uploading = true;
  }
  updateAttachmentPreview();

  const results = await Promise.allSettled(
    pending.map(async (att) => {
      const fd = new FormData();
      fd.append("asset", att.file);
      const data = await api("/api/assets/upload", { method: "POST", body: fd });
      const key =
        data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || "";
      const url = data?.url || (key ? assetUrl(key) : "");
      att.assetKey = key;
      att.assetUrl = url;
      att.uploading = false;
      return { type: att.type || "image", assetKey: key, url };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      pending[i].uploading = false;
      toast.error(`アップロード失敗: ${results[i].reason?.message || "不明なエラー"}`);
    }
  }

  updateAttachmentPreview();
  return attachments
    .filter((att) => att.assetKey)
    .map((att) => ({ type: att.type || "image", assetKey: att.assetKey, url: att.assetUrl }));
}

let currentChatAbortController = null;

$("abortChat").onclick = () => {
  if (state.chat.abortController) {
    state.chat.abortController.abort();
    state.chat.abortController = null;
  }
};

dom.sendChatBtn.onclick = async () => {
  const prompt = dom.chatPrompt.value.trim();
  const attachments = state.chat.attachments;
  if (!prompt && attachments.length === 0) return;

  const sendBtn = dom.sendChatBtn;
  const abortBtn = dom.abortChatBtn;
  sendBtn.disabled = true;
  sendBtn.style.display = "none";
  abortBtn.style.display = "inline-flex";

  state.chat.abortController = new AbortController();

  const imagePreviews = attachments.map((att) => ({ url: att.previewUrl }));
  addMsg("user", prompt || "(画像のみ)", imagePreviews);
  dom.chatPrompt.value = "";

  const aiMsgDiv = document.createElement("div");
  aiMsgDiv.className = "msg ai";
  const aiRoleSpan = document.createElement("span");
  aiRoleSpan.className = "role";
  aiRoleSpan.textContent = "ai";
  aiMsgDiv.appendChild(aiRoleSpan);
  const aiContentDiv = document.createElement("div");
  aiContentDiv.className = "msg-content";
  aiContentDiv.innerHTML = '<span class="streaming-cursor">▊</span>';
  aiMsgDiv.appendChild(aiContentDiv);
  dom.chatLog.appendChild(aiMsgDiv);
  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;

  setStatus("通信中...", "warn");
  let fullText = "";

  try {
    const uploadedAttachments = await uploadAttachments();

    const apiAttachments = {};
    const imageKeys = uploadedAttachments
      .filter((a) => a.type === "image" && a.assetKey)
      .map((a) => a.assetKey);
    const fileKeys = uploadedAttachments
      .filter((a) => a.type === "file" && a.assetKey)
      .map((a) => a.assetKey);
    if (imageKeys.length > 0) apiAttachments.images = imageKeys;
    if (fileKeys.length > 0) apiAttachments.files = fileKeys;

    const response = await api("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: dom.chatModel.value,
        conversationId: dom.conversationId.value || undefined,
        webSearch: dom.webSearch.checked,
        numOfSite: dom.chatNumOfSite?.value ? parseInt(dom.chatNumOfSite.value) : undefined,
        maxWord: dom.chatMaxWord?.value ? parseInt(dom.chatMaxWord.value) : undefined,
        withMemories: dom.withMemories?.checked || false,
        isMixed: dom.isMixed?.checked || false,
        brandVoiceId: dom.brandVoiceId?.value?.trim() || undefined,
        attachments: Object.keys(apiAttachments).length > 0 ? apiAttachments : undefined,
      }),
      signal: state.chat.abortController.signal,
      raw: true,
    });

    if (!response.ok) {
      if (response.status === 422) {
        throw new Error("無効なリクエスト形式");
      } else if (response.status >= 500) {
        throw new Error("サーバーエラー");
      } else {
        throw new Error(`HTTP ${response.status}`);
      }
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEvent = "content";
    let streamDone = false;
    let streamError = null;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (!line.startsWith("data: ")) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);

          if (currentEvent === "error") {
            streamError = new Error(data?.error || data?.message || "Stream error");
            streamDone = true;
            break;
          }

          if (currentEvent === "done") {
            streamDone = true;
            break;
          }

          if (currentEvent === "result") {
            // 1min.ai streams may end with a final result event containing
            // the entire aiRecord. Use it as a fallback if no content chunks
            // were received.
            const text = extractText(data?.aiRecord || data);
            if (text && !fullText) {
              fullText = text;
              renderMarkdownSafely(aiContentDiv, fullText);
            }
            continue;
          }

          const content =
            data?.content ||
            data?.choices?.[0]?.delta?.content ||
            data?.choices?.[0]?.message?.content ||
            data?.message?.content ||
            data?.delta?.content ||
            data?.text;
          if (content) {
            fullText += content;
            renderMarkdownSafely(aiContentDiv, fullText);
            dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
          }
        } catch {
          // Non-JSON data line, skip
        }
      }
    }

    if (streamError) throw streamError;

    if (!fullText) {
      fullText = "(応答が空でした)";
    }

    renderMarkdownSafely(aiContentDiv, fullText);
    pruneChatLog();
  } catch (e) {
    if (e.name === "AbortError") {
      fullText += "\n\n*(キャンセルされました)*";
      renderMarkdownSafely(aiContentDiv, fullText);
      setStatus("キャンセルしました", "warn");
    } else {
      const message = e?.message || "不明なエラー";
      aiContentDiv.textContent = `エラー: ${message}`;
      toast.error(`チャットエラー: ${message}`);
      setStatus("エラー", "error");
    }
  } finally {
    state.chat.abortController = null;
    sendBtn.disabled = false;
    sendBtn.style.display = "inline-flex";
    abortBtn.style.display = "none";
    setStatus("準備完了");
    state.chat.attachments.length = 0;
    updateAttachmentPreview();
  }
};

// Check health on startup
async function checkHealth() {
  try {
    const data = await api("/api/health");
    if (!data?.ok) {
      toast.error("サーバーのヘルスチェックに失敗しました。", {
        duration: 10000,
      });
      setStatus("ヘルスチェック失敗", "err");
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

// images
function renderImages(data, sourceImageUrl = null) {
  const images = extractImages(data);
  if (!images.length) {
    const pre = document.createElement("pre");
    pre.className = "json";
    pre.textContent = JSON.stringify(data, null, 2);
    dom.imageGallery.prepend(pre);
    return;
  }
  for (const img of images) {
    const card = document.createElement("div");
    card.className = "imageCard";
    const url = assetUrl(img);

    if (sourceImageUrl) {
      // Create slider comparison card
      const sourceUrl = assetUrl(sourceImageUrl);
      const slider = document.createElement("div");
      slider.className = "image-comparison-slider";

      const afterImg = document.createElement("img");
      afterImg.src = url;
      afterImg.alt = "After";
      afterImg.className = "image-after";
      slider.appendChild(afterImg);

      const beforeImg = document.createElement("img");
      beforeImg.src = sourceUrl;
      beforeImg.alt = "Before";
      beforeImg.className = "image-before";
      beforeImg.style.clipPath = "polygon(0 0, 50% 0, 50% 100%, 0 100%)";
      slider.appendChild(beforeImg);

      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.value = "50";
      range.className = "slider-range";
      range.setAttribute("aria-label", "画像比較スライダー");
      slider.appendChild(range);

      const divider = document.createElement("div");
      divider.className = "slider-divider";
      divider.style.left = "50%";
      const handle = document.createElement("div");
      handle.className = "slider-handle";
      divider.appendChild(handle);
      slider.appendChild(divider);

      range.addEventListener("input", (e) => {
        const val = e.target.value;
        beforeImg.style.clipPath = `polygon(0 0, ${val}% 0, ${val}% 100%, 0 100%)`;
        divider.style.left = val + "%";
      });
      card.appendChild(slider);
    } else {
      const imgEl = document.createElement("img");
      imgEl.src = url;
      imgEl.alt = "AI生成画像";
      imgEl.onerror = function () {
        this.style.display = "none";
      };
      card.appendChild(imgEl);
    }

    // Info row under the image/slider
    const infoRow = document.createElement("div");
    infoRow.style.marginTop = "10px";
    infoRow.style.display = "flex";
    infoRow.style.flexDirection = "column";
    infoRow.style.gap = "4px";

    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = img.length > 30 ? img.slice(0, 27) + "..." : img;
    link.title = img;
    link.style.display = "block";
    link.style.textAlign = "center";
    infoRow.appendChild(link);

    if (sourceImageUrl) {
      const modelName =
        document.getElementById("imageModelLabel")?.textContent?.trim() || "AI Model";
      const modelLabel = document.createElement("span");
      modelLabel.textContent = `編集モデル: ${modelName}`;
      modelLabel.style.fontSize = "0.7rem";
      modelLabel.style.color = "var(--text-muted)";
      modelLabel.style.textAlign = "center";
      infoRow.appendChild(modelLabel);
    }

    card.appendChild(infoRow);
    dom.imageGallery.prepend(card);
    pruneImageGallery();
  }
}

dom.generateImage.onclick = async () => {
  const imageUrl = dom.editorImageUrl.value.trim();
  const prompt = dom.imagePrompt.value.trim();
  const model = dom.imageModel.value;

  if (!prompt) {
    toast.warning("プロンプトを入力してください");
    return;
  }

  const isEditMode = !!imageUrl;

  try {
    let data;
    if (isEditMode) {
      data = await api("/api/images/text-editor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageUrl,
          prompt,
          model,
          size: $("editorSize").value.trim(),
          quality: $("editorQuality").value,
          n: $("editorN").value,
          background: $("editorBackground").value,
          output_format: $("editorOutputFormat").value,
          output_compression: $("editorOutputCompression").value || undefined,
        }),
      });
      toast.success("画像を編集しました");
      dom.assetResult.textContent = JSON.stringify(data, null, 2);
      renderImages(data, imageUrl);
    } else {
      data = await api("/api/images/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          model,
          num_outputs: $("numOutputs").value,
          aspect_ratio: $("aspectRatio").value,
        }),
      });
      toast.success("画像を生成しました");
      dom.assetResult.textContent = JSON.stringify(data, null, 2);
      renderImages(data);
    }
  } catch (e) {
    toast.error(`処理に失敗しました: ${e.message}`);
  }
};

async function performAssetUpload(file) {
  if (!file) return;
  const generateBtn = dom.generateImage;
  const assetInput = $("assetInput");

  if (generateBtn) generateBtn.disabled = true;
  if (assetInput) assetInput.disabled = true;
  setStatus("アップロード中...", "warn");

  const fd = new FormData();
  fd.append("asset", file);
  try {
    const data = await api("/api/assets/upload", { method: "POST", body: fd });
    dom.assetResult.textContent = JSON.stringify(data, null, 2);
    const key =
      data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || "";
    const url = data?.url || (key ? assetUrl(key) : "");
    if (key) {
      dom.editorImageUrl.value = url || key;
      updateEditorImagePreview(url || key);
    }
    toast.success("アップロード完了");
  } catch (e) {
    toast.error(`アセットのアップロードに失敗しました: ${e.message}`);
  } finally {
    if (generateBtn) generateBtn.disabled = false;
    if (assetInput) assetInput.disabled = false;
    setStatus("準備完了", "ok");
  }
}

// Auto-upload on file selection
$("assetInput").onchange = async (e) => {
  const file = e.target.files[0];
  if (file) {
    await performAssetUpload(file);
  }
};

dom.uploadAsset.onclick = async () => {
  const file = $("assetInput").files[0];
  if (!file) {
    toast.warning("画像ファイルを選択してください");
    return;
  }
  await performAssetUpload(file);
};

function updateEditorImagePreview(imageUrl) {
  const input = dom.editorImageUrl;
  const preview = dom.editorImagePreview;
  const clearBtn = dom.clearImageBtn;
  const imgToImgParams = $("imageToImageParams");
  const textToImgParams = $("textToImageParams");
  const btnText = $("generateImageBtnText");
  const value = (imageUrl || input?.value || "").trim();

  const currentModelId = dom.imageModel.value;
  const modelObj =
    typeof _allImageModels !== "undefined"
      ? _allImageModels.find((m) => m.id === currentModelId)
      : null;

  if (!value) {
    if (preview) preview.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
    if (imgToImgParams) imgToImgParams.style.display = "none";
    if (textToImgParams) textToImgParams.style.display = "block";
    if (btnText) btnText.textContent = "画像を生成";

    // Switch model if current model is editor-only
    if (
      modelObj &&
      modelObj.tags &&
      modelObj.tags.includes("editor") &&
      !modelObj.tags.includes("image")
    ) {
      const defaultGen = (typeof _allImageModels !== "undefined" &&
        _allImageModels.find(
          (m) => !m.tags || !m.tags.includes("editor") || m.id.startsWith("gpt-image"),
        )) || { id: "gpt-image-2", label: "GPT Image 2" };
      dom.imageModel.value = defaultGen.id;
      dom.imageModelLabel.textContent = defaultGen.label;
    }
    return;
  }

  if (preview) {
    preview.src = assetUrl(value);
    preview.style.display = "block";
  }
  if (clearBtn) clearBtn.style.display = "block";
  if (imgToImgParams) imgToImgParams.style.display = "block";
  if (textToImgParams) textToImgParams.style.display = "none";
  if (btnText) btnText.textContent = "画像を編集";

  // Switch model if current model doesn't support editing
  const isEditorModel = modelObj && modelObj.tags && modelObj.tags.includes("editor");
  if (!isEditorModel) {
    const defaultEditor = (typeof _allImageModels !== "undefined" &&
      _allImageModels.find((m) => m.tags && m.tags.includes("editor"))) || {
      id: "gpt-image-2",
      label: "GPT Image 2",
    };
    dom.imageModel.value = defaultEditor.id;
    dom.imageModelLabel.textContent = defaultEditor.label;
  }
}

dom.editorImageUrl.oninput = () => updateEditorImagePreview();

dom.clearImageBtn.onclick = () => {
  dom.editorImageUrl.value = "";
  $("assetInput").value = "";
  updateEditorImagePreview();
};

// Monaco editor
function renderTabs() {
  const container = dom.editorTabsBar;
  if (!container) return;
  container.textContent = "";

  state.editor.openTabs.forEach((pathVal) => {
    const fileName = pathVal.replace(/\\/g, "/").split("/").pop();
    const tabEl = document.createElement("div");
    tabEl.className = `editor-tab ${pathVal === state.editor.activeFilePath ? "active" : ""}`;
    tabEl.title = pathVal;

    const nameSpan = document.createElement("span");
    nameSpan.textContent = fileName;
    nameSpan.onclick = () => {
      if (pathVal !== state.editor.activeFilePath) {
        switchToTab(pathVal);
      }
    };
    tabEl.appendChild(nameSpan);

    const closeBtn = document.createElement("span");
    closeBtn.className = "close-tab-btn";
    closeBtn.textContent = "×";
    closeBtn.onclick = (e) => {
      e.stopPropagation();
      closeTab(pathVal);
    };
    tabEl.appendChild(closeBtn);

    container.appendChild(tabEl);
  });
}

async function switchToTab(filePath) {
  const fileUri = monaco.Uri.file(filePath);
  let model = monaco.editor.getModel(fileUri);

  if (model) {
    if (window.editor) {
      window.editor.setModel(model);
      state.editor.activeFilePath = filePath;
      dom.currentFileName.textContent = filePath.replace(/\\/g, "/").split("/").pop();
      dom.currentFileName.title = filePath;
      dom.saveFileBtn.disabled = false;

      document.querySelectorAll(".tree-node.file").forEach((x) => {
        if (x.dataset.path === filePath) {
          x.classList.add("active");
        } else {
          x.classList.remove("active");
        }
      });
      renderTabs();
    }
  } else {
    await openFile(filePath);
  }
}

async function closeTab(filePath) {
  const tabIndex = state.editor.openTabs.indexOf(filePath);
  if (tabIndex === -1) return;

  const accepted = await toast.confirm(`タブを閉じますか？未保存の変更は失われます。`, {
    confirmText: "閉じる",
    cancelText: "キャンセル",
    type: "warning",
  });
  if (!accepted) return;

  state.editor.openTabs.splice(tabIndex, 1);

  const fileUri = monaco.Uri.file(filePath);
  const model = monaco.editor.getModel(fileUri);
  if (model) {
    model.dispose();
  }

  if (state.editor.activeFilePath === filePath) {
    if (state.editor.openTabs.length > 0) {
      const nextActivePath =
        state.editor.openTabs[Math.min(tabIndex, state.editor.openTabs.length - 1)];
      await switchToTab(nextActivePath);
    } else {
      state.editor.activeFilePath = null;
      if (window.editor) {
        window.editor.setModel(monaco.editor.createModel("", "plaintext"));
      }
      dom.currentFileName.textContent = "ファイルが選択されていません";
      dom.currentFileName.title = "";
      dom.saveFileBtn.disabled = true;
      document.querySelectorAll(".tree-node.file").forEach((x) => x.classList.remove("active"));
    }
  }
  renderTabs();
}

require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs" } });
require(["vs/editor/editor.main"], function () {
  const savedTheme = localStorage.getItem(STORAGE_KEY_THEME);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = savedTheme === "dark" || (!savedTheme && prefersDark);

  window.editor = monaco.editor.create($("editor"), {
    value: `/* ⬅ 左のツリーからファイルを選択するか、パスを入力して読み込んでください */\n`,
    language: "plaintext",
    theme: isDark ? "vs-dark" : "vs",
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    wordWrap: "on",
    inlineSuggest: { enabled: true },
  });

  const container = $("editor");
  if (container) {
    const observer = new ResizeObserver(() => {
      if (window.editor) window.editor.layout();
    });
    observer.observe(container);
  }

  window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    saveFile();
  });

  window.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => {
    toggleInlineChat();
  });

  const languages = [
    "javascript",
    "typescript",
    "python",
    "html",
    "css",
    "json",
    "markdown",
    "plaintext",
  ];
  for (const lang of languages) {
    monaco.languages.registerInlineCompletionsProvider(lang, {
      provideInlineCompletions: async function (model, position, context, token) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (token.isCancellationRequested) return;

        const code = model.getValue();
        const line = position.lineNumber;
        const column = position.column;

        try {
          const data = await api("/api/code/autocomplete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              line,
              column,
              fileName: state.editor.activeFilePath
                ? state.editor.activeFilePath.split(/[\\/]/).pop()
                : "untitled",
              language: model.getLanguageId(),
              model: dom.codeModel.value,
              webSearch: dom.codeWebSearch?.checked || false,
              numOfSite: dom.codeNumOfSite?.value ? parseInt(dom.codeNumOfSite.value) : undefined,
              maxWord: dom.codeMaxWord?.value ? parseInt(dom.codeMaxWord.value) : undefined,
            }),
            signal: token.signal,
          });
          if (!data.suggestion || token.isCancellationRequested) return;

          return {
            items: [
              {
                insertText: data.suggestion,
                range: new monaco.Range(line, column, line, column),
              },
            ],
          };
        } catch (e) {
          if (e.name !== "AbortError") console.error("Autocomplete error:", e);
        }
      },
      freeInlineCompletions: function () {},
    });
  }
});

const inlineChatWidget = {
  getId: () => "inline.chat.widget",
  getDomNode: function () {
    if (!state.editor.inlineChatDom) {
      state.editor.inlineChatDom = document.createElement("div");
      state.editor.inlineChatDom.className = "inline-chat-widget";
      state.editor.inlineChatDom.style.width = "350px";

      const inputRow = document.createElement("div");
      inputRow.className = "inline-chat-input-row";

      const promptInput = document.createElement("input");
      promptInput.type = "text";
      promptInput.id = "inlineChatPrompt";
      promptInput.placeholder = "AIへの指示を入力 (例: ループを追加)...";

      const submitBtn = document.createElement("button");
      submitBtn.type = "button";
      submitBtn.id = "inlineChatSubmit";
      submitBtn.textContent = "送信";

      inputRow.appendChild(promptInput);
      inputRow.appendChild(submitBtn);

      const statusDiv = document.createElement("div");
      statusDiv.id = "inlineChatStatus";
      statusDiv.className = "inline-chat-status";
      statusDiv.style.display = "none";
      statusDiv.textContent = "生成中...";

      state.editor.inlineChatDom.appendChild(inputRow);
      state.editor.inlineChatDom.appendChild(statusDiv);

      promptInput.onkeydown = async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          await submitInlineChat();
        } else if (e.key === "Escape") {
          closeInlineChat();
        }
      };

      submitBtn.onclick = async () => {
        await submitInlineChat();
      };
    }
    return state.editor.inlineChatDom;
  },
  getPosition: function () {
    return {
      position: window.editor.getPosition(),
      preference: [
        monaco.editor.ContentWidgetPositionPreference.BELOW,
        monaco.editor.ContentWidgetPositionPreference.ABOVE,
      ],
    };
  },
};

async function submitInlineChat() {
  if (!state.editor.activeFilePath || !window.editor) return;
  const domNode = state.editor.inlineChatDom;
  const input = domNode.querySelector("#inlineChatPrompt");
  const status = domNode.querySelector("#inlineChatStatus");
  const prompt = input.value.trim();
  if (!prompt) return;

  status.style.display = "block";
  status.className = "inline-chat-status loading";
  input.disabled = true;

  const code = window.editor.getValue();
  const position = window.editor.getPosition();
  const fileName = state.editor.activeFilePath.split(/[\\/]/).pop();
  const language = window.editor.getModel()?.getLanguageId() || "plaintext";

  try {
    const data = await api("/api/code/inline-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        code,
        line: position.lineNumber,
        column: position.column,
        fileName,
        language,
        model: dom.codeModel.value,
        webSearch: dom.codeWebSearch?.checked || false,
        numOfSite: dom.codeNumOfSite?.value ? parseInt(dom.codeNumOfSite.value) : undefined,
        maxWord: dom.codeMaxWord?.value ? parseInt(dom.codeMaxWord.value) : undefined,
      }),
    });

    if (data.code) {
      const accepted = await toast.confirm("AIがコードを生成しました。適用しますか？", {
        confirmText: "適用",
        cancelText: "破棄",
        type: "info",
      });

      if (accepted) {
        const range = new monaco.Range(
          position.lineNumber,
          position.column,
          position.lineNumber,
          position.column,
        );
        const id = { major: 1, minor: 1 };
        const op = { identifier: id, range: range, text: data.code, forceMoveMarkers: true };
        window.editor.executeEdits("copilot-inline-chat", [op]);
        toast.success("コードを適用しました");
      } else {
        toast.info("生成されたコードを破棄しました");
      }
    }
  } catch (e) {
    toast.error(`AIコード生成に失敗しました: ${e.message}`);
  } finally {
    status.style.display = "none";
    status.className = "inline-chat-status";
    input.disabled = false;
    input.value = "";
    closeInlineChat();
  }
}

function toggleInlineChat() {
  if (!state.editor.activeFilePath) {
    toast.warning("ファイルを編集するには、左のツリーからファイルを開いてください。");
    return;
  }
  if (state.editor.isInlineChatOpen) {
    closeInlineChat();
  } else {
    window.editor.addContentWidget(inlineChatWidget);
    state.editor.isInlineChatOpen = true;
    setTimeout(() => {
      const input = state.editor.inlineChatDom?.querySelector("#inlineChatPrompt");
      if (input) input.focus();
    }, 50);
  }
}

function closeInlineChat() {
  if (state.editor.isInlineChatOpen) {
    window.editor.removeContentWidget(inlineChatWidget);
    state.editor.isInlineChatOpen = false;
    window.editor.focus();
  }
}

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
    toggle.textContent = item.isDirectory ? "▶" : "";
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
      childrenContainer.style.display = "none";
      childrenContainer.setAttribute("role", "group");
      container.appendChild(childrenContainer);

      node.onclick = async (e) => {
        e.stopPropagation();
        const isExpanded = node.classList.toggle("expanded");
        node.setAttribute("aria-expanded", String(isExpanded));
        if (isExpanded) {
          childrenContainer.style.display = "flex";
          toggle.textContent = "▼";
          if (childrenContainer.childElementCount === 0) {
            try {
              const res = await api(`/api/fs/list?dir=${encodeURIComponent(item.path)}`);
              await renderTreeNodes(res.items, childrenContainer, depth + 1);
            } catch (err) {
              console.error(err);
            }
          }
        } else {
          childrenContainer.style.display = "none";
          toggle.textContent = "▶";
        }
      };
    } else {
      node.onclick = (e) => {
        e.stopPropagation();
        openFile(item.path);
      };
    }
  }
}

async function openFile(filePath) {
  try {
    const data = await api(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
    if (window.editor) {
      const fileUri = monaco.Uri.file(filePath);
      let model = monaco.editor.getModel(fileUri);
      if (model) {
        model.setValue(data.content);
      } else {
        model = monaco.editor.createModel(data.content, undefined, fileUri);
      }
      window.editor.setModel(model);

      if (!state.editor.openTabs.includes(filePath)) {
        state.editor.openTabs.push(filePath);
      }

      // Dispose unused models (keep max 20 open, excluding active or open tab models)
      const allModels = monaco.editor.getModels();
      if (allModels.length > state.editor.maxOpenModels) {
        const unused = allModels.filter(
          (m) => m !== window.editor.getModel() && !state.editor.openTabs.includes(m.uri.fsPath),
        );
        for (const m of unused.slice(0, allModels.length - state.editor.maxOpenModels)) {
          m.dispose();
        }
      }

      state.editor.activeFilePath = filePath;
      dom.currentFileName.textContent = filePath.replace(/\\/g, "/").split("/").pop();
      dom.currentFileName.title = filePath;
      dom.saveFileBtn.disabled = false;

      document.querySelectorAll(".tree-node.file").forEach((x) => {
        if (x.dataset.path === filePath) {
          x.classList.add("active");
        } else {
          x.classList.remove("active");
        }
      });
      renderTabs();
    }
  } catch (e) {
    toast.error(`ファイルの読み込みに失敗しました: ${e.message}`);
  }
}

let _saveStatusTimer = null;

async function saveFile() {
  if (!state.editor.activeFilePath || !window.editor) return;
  const content = window.editor.getValue();
  try {
    setStatus("保存中...", "warn");
    await api("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.editor.activeFilePath, content }),
    });
    setStatus("保存完了", "ok");
    toast.success("ファイルを保存しました");
    if (_saveStatusTimer) clearTimeout(_saveStatusTimer);
    _saveStatusTimer = setTimeout(() => {
      if ($("status")?.textContent === "保存完了") setStatus("準備完了");
    }, 2000);
  } catch (e) {
    toast.error(`ファイルの保存に失敗しました: ${e.message}`);
  }
}

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

function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderMarkdownSafely(element, markdown) {
  if (!element) return;
  if (typeof markdown !== "string") {
    element.textContent = "";
    return;
  }

  if (!window.marked || !window.DOMPurify) {
    element.textContent = markdown;
    return;
  }

  element.innerHTML = DOMPurify.sanitize(marked.parse(markdown));
}

function formatMarkdownLike(text) {
  if (typeof text !== "string") return "";
  let html = escapeHtml(text);

  // Format inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Format bold text
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return html;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function createSvgIcon(viewBox, paths) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.style.verticalAlign = "middle";
  svg.style.marginRight = "4px";

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", paths);
  svg.appendChild(path);
  return svg;
}

function appendStepIcon(container, type) {
  const iconMap = {
    thought: {
      label: "思考",
      viewBox: "0 0 24 24",
      paths: "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01M12 21a9 9 0 1 0-9-9",
    },
    action: {
      label: "ツール呼び出し",
      viewBox: "0 0 24 24",
      paths:
        "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm8.94-2.83 1.72 2.99a1 1 0 0 1-.41 1.36l-3.06 1.49a1 1 0 0 1-1.26-.27l-1.15-1.4a8 8 0 0 1-1.86.78l-.34 1.65A1 1 0 0 1 14 19h-4a1 1 0 0 1-1-.83l-.34-1.65a8 8 0 0 1-1.86-.78l-1.15 1.4a1 1 0 0 1-1.26.27L1.33 16.5a1 1 0 0 1-.41-1.36l1.72-2.99A8 8 0 0 1 3 10.5c0-.6.07-1.18.21-1.74L1.5 6.5a1 1 0 0 1 .41-1.36l3.06-1.49a1 1 0 0 1 1.26.27l1.15 1.4a8 8 0 0 1 1.86-.78L9.58 3a1 1 0 0 1 1-.83h4a1 1 0 0 1 1 .83l.34 1.65a8 8 0 0 1 1.86.78l1.15-1.4a1 1 0 0 1 1.26-.27l3.06 1.49a1 1 0 0 1 .41 1.36l-1.72 2.99c.14.56.21 1.14.21 1.74z",
    },
    result: {
      label: "実行結果",
      viewBox: "0 0 24 24",
      paths: "M20 6 9 17l-5-5",
    },
    error: {
      label: "エラー",
      viewBox: "0 0 24 24",
      paths: "M12 9v4m0 4h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
    },
    approval: {
      label: "承認要求",
      viewBox: "0 0 24 24",
      paths:
        "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4m0 4h.01",
    },
  };

  const cfg = iconMap[type] || iconMap.thought;
  container.appendChild(createSvgIcon(cfg.viewBox, cfg.paths));
  container.appendChild(document.createTextNode(cfg.label + ": "));
}

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
    thoughtBox.className = "agent-step-thought-box";
    thoughtBox.style.display = "none";
    thoughtBox.appendChild(bodyEl);

    toggleDiv.onclick = () => {
      if (thoughtBox.style.display === "none") {
        thoughtBox.style.display = "block";
        toggleSpan.textContent = "▼ 思考プロセスを折りたたむ";
      } else {
        thoughtBox.style.display = "none";
        toggleSpan.textContent = "▶ 思考プロセスを展開";
      }
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
    resultPre.className = "agent-step-result-box";
    resultPre.style.display = "none";
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
  if (box.style.display === "none") {
    box.style.display = "block";
    if (toggleSpan) toggleSpan.textContent = "▼ 実行出力を非表示";
  } else {
    box.style.display = "none";
    if (toggleSpan) toggleSpan.textContent = "▶ 実行出力を表示";
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
  iconSpan.style.color = "#facc15";
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

  approveBtn.onclick = () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    feedbackInput.disabled = true;
    approveBtn.textContent = "許可済み";
    approveBtn.style.opacity = "0.7";
    onApprove();
  };

  rejectBtn.onclick = () => {
    approveBtn.disabled = true;
    rejectBtn.disabled = true;
    feedbackInput.disabled = true;
    rejectBtn.textContent = "却下済み";
    rejectBtn.style.opacity = "0.7";
    const reason = feedbackInput.value.trim() || "ユーザーによって却下されました";
    onReject(reason);
  };
}

function stripMarkdownCodeBlock(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:xml|js|javascript|json|text)?\s*\n?([\s\S]*?)\n?```$/i);
  return match ? match[1].trim() : text;
}

function unescapeXmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseXMLTags(text) {
  if (!text || typeof text !== "string") return { thought: null, finish: null, toolCall: null };
  const normalizedText = stripMarkdownCodeBlock(text);

  // Helper to extract by tag name (handles loose/unclosed tags)
  const extractTag = (input, tag) => {
    const startTag = `<${tag}>`;
    const endTag = `</${tag}>`;
    const startIdx = input.indexOf(startTag);
    if (startIdx === -1) return null;

    const contentStart = startIdx + startTag.length;
    const endIdx = input.indexOf(endTag, contentStart);
    return endIdx !== -1
      ? input.substring(contentStart, endIdx).trim()
      : input.substring(contentStart).trim();
  };

  // 1. Try Tool Call Parsing
  let toolCall = null;
  const toolMatch = normalizedText.match(
    /<call_tool\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/call_tool>|$)/i,
  );
  if (toolMatch) {
    const params = {};
    const paramRegex =
      /<parameter\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/parameter>|$)/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(toolMatch[2])) !== null) {
      params[pMatch[1]] = unescapeXmlText(pMatch[2].trim());
    }
    toolCall = { name: toolMatch[1], params };
  }

  const thought = extractTag(normalizedText, "thought");
  const finish = extractTag(normalizedText, "finish");

  // 2. JSON Fallback
  if (!toolCall && !finish) {
    const jsonMatch = normalizedText.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      try {
        const data = JSON.parse(jsonMatch[0]);
        const jsonTool =
          data.tool || data.toolName || data.call_tool || data.toolCall?.name || data.action;
        const jsonParams =
          data.parameters || data.params || data.toolCall?.params || data.arguments || data.args;

        if (jsonTool) toolCall = { name: String(jsonTool), params: jsonParams || {} };
        if (data.thought && !thought)
          return { thought: data.thought, finish: data.finish || null, toolCall };
        if (data.finish && !finish) return { thought, finish: data.finish, toolCall };
      } catch {
        /* ignore */
      }
    }
  }

  return { thought, finish, toolCall };
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
        resolve(val);
      };
      $("diffApply").onclick = () => cleanup(true);
      $("diffCancel").onclick = () => cleanup(false);
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

    // Compile full conversation history into a single prompt string for stateless execution
    const compiledPrompt = state.agent.history.map((msg) => msg.content).join("\n\n");

    let chatRes;
    try {
      chatRes = await api("/api/agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: compiledPrompt,
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
  dom.startAgentBtn.style.display = "flex";
  dom.sendAgentFeedbackBtn.style.display = "none";
  dom.stopAgentBtn.style.display = "none";
  dom.resetAgentBtn.style.display = "flex";
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
  dom.startAgentBtn.style.display = "none";
  dom.sendAgentFeedbackBtn.style.display = "flex";
  dom.stopAgentBtn.style.display = "flex";
  dom.resetAgentBtn.style.display = "none";

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
    dom.startAgentBtn.style.display = "flex";
    dom.sendAgentFeedbackBtn.style.display = "none";
    dom.stopAgentBtn.style.display = "none";
    dom.resetAgentBtn.style.display = "flex";
    dom.agentInstruction.placeholder = "指示を入力してエージェントを開始...";
  }
};

dom.stopAgentBtn.onclick = () => {
  if (!state.agent.active) return;
  state.agent.active = false;
  if (state.agent.resolver) {
    state.agent.resolver({ abort: true });
  }
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
    state.agent.sessionId = null;
    state.agent.history = [];
    const log = dom.agentActivityLog;
    if (log) {
      log.textContent = "";
      const placeholder = document.createElement("div");
      placeholder.className = "timeline-placeholder";
      placeholder.style.cssText =
        "color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 24px 8px; border: 1px dashed rgba(255,255,255,0.05); border-radius: 8px; background: rgba(255,255,255,0.01);";
      placeholder.textContent = "指示を入力して、エージェントとのチャットを開始してください。";
      log.appendChild(placeholder);
    }
    setAgentStatus("待機中", "idle");
    dom.agentInstruction.placeholder = "指示を入力してエージェントを開始...";
    dom.startAgentBtn.style.display = "flex";
    dom.sendAgentFeedbackBtn.style.display = "none";
    dom.stopAgentBtn.style.display = "none";
    dom.resetAgentBtn.style.display = "flex";
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
    errorBox.style.display = "none";
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
    modal.style.display = "flex";
    renderDrives();
    renderFolderPickerList(initial);
    setTimeout(() => pathInput.focus(), 0);

    modal._previousFocus = document.activeElement;
    modal.addEventListener("keydown", trapFocus);
  };

  window.closeFolderPicker = () => {
    modal.style.display = "none";
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
      errorBox.style.display = "block";
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
      errorBox.style.display = "block";
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
      if (chatSettings) chatSettings.style.display = "none";
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

    if (typeof _allChatModels !== "undefined" && _allChatModels.length > 0) {
      const currentChat = $("chatModel")?.value;
      const currentModelObj = _allChatModels.find((m) => m.id === currentChat);
      if (
        currentChat &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          _allChatModels.find((m) => m.id === "gpt-4o-mini") ||
          _allChatModels.find((m) => m.tags && m.tags.includes("fast"));
        if (fallback) selectModelForPicker("chatModel", fallback);
      }
    }

    if (typeof _allCodeModels !== "undefined" && _allCodeModels.length > 0) {
      const currentCode = $("codeModel")?.value;
      const currentModelObj = _allCodeModels.find((m) => m.id === currentCode);
      if (
        currentCode &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          _allCodeModels.find((m) => m.id === "qwen3-coder-flash") ||
          _allCodeModels.find((m) => m.tags && m.tags.includes("fast"));
        if (fallback) selectModelForPicker("codeModel", fallback);
      }
    }

    if (typeof _allImageModels !== "undefined" && _allImageModels.length > 0) {
      const currentImage = $("imageModel")?.value;
      const currentModelObj = _allImageModels.find((m) => m.id === currentImage);
      if (
        currentImage &&
        (!currentModelObj || !currentModelObj.tags || !currentModelObj.tags.includes("fast"))
      ) {
        const fallback =
          _allImageModels.find((m) => m.id === "gpt-image-1-mini") ||
          _allImageModels.find((m) => m.tags && m.tags.includes("fast"));
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
