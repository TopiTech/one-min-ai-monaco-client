/**
 * Main application logic for 1min.ai Monaco Client
 * Depends on: js/api.js, js/models.js, js/toast.js
 */

// Helper to get element by ID
const $ = (id) => document.getElementById(id);

// Initialize Model Pickers
loadModels().then(() => initModelPickers());

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
};

const getBffToken = () => document.querySelector('meta[name="local-bff-token"]')?.content || "";

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
      const svgIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`;
      icon.innerHTML = svgIcon;

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
      const headers = {};
      const token = getBffToken();
      if (token) headers["x-local-bff-token"] = token;
      const res = await fetch("/api/assets/upload", { method: "POST", headers, body: fd });
      if (!res.ok) throw new Error(`アップロード失敗: ${res.status}`);
      const data = await res.json();
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

    const headers = { "Content-Type": "application/json" };
    const token = getBffToken();
    if (token) headers["x-local-bff-token"] = token;

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers,
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

    while (true) {
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

        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);

            if (currentEvent === "error") {
              const errorMsg = data?.error || data?.message || "Stream error";
              throw new Error(errorMsg);
            }

            if (currentEvent === "done") {
              break;
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
    }

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

// Check health and API key on startup
async function checkHealth() {
  try {
    const data = await api("/api/health");
    if (!data.hasApiKey) {
      toast.error("サーバーに 1min.ai APIキーが設定されていません。.env を確認してください。", {
        duration: 10000,
      });
      setStatus("APIキー未設定", "err");
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
function renderImages(data) {
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
    const imgEl = document.createElement("img");
    imgEl.src = url;
    imgEl.alt = "AI生成画像";
    imgEl.onerror = function () {
      this.style.display = "none";
    };
    card.appendChild(imgEl);
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = img;
    card.appendChild(link);
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
    }

    dom.assetResult.textContent = JSON.stringify(data, null, 2);
    renderImages(data);
  } catch (e) {
    toast.error(`処理に失敗しました: ${e.message}`);
  }
};

dom.uploadAsset.onclick = async () => {
  const file = $("assetInput").files[0];
  if (!file) {
    toast.warning("画像ファイルを選択してください");
    return;
  }
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
  }
};

function updateEditorImagePreview(imageUrl) {
  const input = dom.editorImageUrl;
  const preview = dom.editorImagePreview;
  const clearBtn = dom.clearImageBtn;
  const imgToImgParams = $("imageToImageParams");
  const textToImgParams = $("textToImageParams");
  const btnText = $("generateImageBtnText");
  const value = (imageUrl || input?.value || "").trim();

  if (!value) {
    if (preview) preview.style.display = "none";
    if (clearBtn) clearBtn.style.display = "none";
    if (imgToImgParams) imgToImgParams.style.display = "none";
    if (textToImgParams) textToImgParams.style.display = "block";
    if (btnText) btnText.textContent = "画像を生成";
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
          const headers = { "Content-Type": "application/json" };
          const token = getBffToken();
          if (token) headers["x-local-bff-token"] = token;

          const res = await fetch("/api/code/autocomplete", {
            method: "POST",
            headers,
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
          });
          if (!res.ok || token.isCancellationRequested) return;
          const data = await res.json();
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
          console.error("Autocomplete error:", e);
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
    const headers = { "Content-Type": "application/json" };
    const token = getBffToken();
    if (token) headers["x-local-bff-token"] = token;

    const res = await fetch("/api/code/inline-chat", {
      method: "POST",
      headers,
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

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

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

  // Use createElement for icon and title to avoid innerHTML on untrusted title
  const iconImg = document.createElement("span");
  if (type === "thought") {
    iconImg.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="9"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>思考';
  } else if (type === "action") {
    iconImg.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>ツール呼び出し';
  } else if (type === "result") {
    iconImg.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"></polyline></svg>実行結果';
  } else if (type === "error") {
    iconImg.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>エラー';
  }

  iconSpan.appendChild(iconImg);
  iconSpan.appendChild(document.createTextNode(": " + title));
  header.appendChild(iconSpan);

  const timeSpan = document.createElement("span");
  timeSpan.className = "agent-step-time";
  timeSpan.textContent = time;
  header.appendChild(timeSpan);

  card.appendChild(header);

  const bodyEl = document.createElement("div");
  bodyEl.className = "agent-step-body";
  card.appendChild(bodyEl);

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
  iconSpan.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
  iconSpan.appendChild(document.createTextNode("承認要求: コマンド実行"));

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

function extractClosedTag(text, tagName) {
  const escapedName = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`<${escapedName}\\b[^>]*>([\\s\\S]*?)<\\/${escapedName}>`, "i"));
  return match ? match[1].trim() : null;
}

function parseXMLTags(text) {
  const normalizedText = stripMarkdownCodeBlock(text || "");

  const toolMatch = normalizedText.match(
    /<call_tool\s+name=["']?([\w-]+)["']?\s*>([\s\S]*?)<\/call_tool>/i,
  );

  let toolCall = null;
  if (toolMatch) {
    const params = {};
    const paramRegex = /<parameter\s+name=["']?([\w-]+)["']?\s*>([\s\S]*?)<\/parameter>/gi;
    let match;
    while ((match = paramRegex.exec(toolMatch[2])) !== null) {
      params[match[1]] = unescapeXmlText(match[2].trim());
    }

    if (Object.keys(params).length > 0) {
      toolCall = { name: toolMatch[1], params };
    }
  }

  return {
    thought: extractClosedTag(normalizedText, "thought"),
    finish: extractClosedTag(normalizedText, "finish"),
    toolCall,
  };
}
let diffEditor = null;

async function showDiffDialog(filePath, oldContent, newContent) {
  const modal = $("diffModal");
  const container = $("diffEditorContainer");
  const pathLabel = $("diffFilePath");

  pathLabel.textContent = `ファイル: ${filePath}`;
  modal.classList.remove("u-hidden");

  if (!diffEditor) {
    diffEditor = monaco.editor.createDiffEditor(container, {
      theme: document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark",
      automaticLayout: true,
      readOnly: true,
      renderSideBySide: true,
    });
  }

  const originalModel = monaco.editor.createModel(oldContent);
  const modifiedModel = monaco.editor.createModel(newContent);
  diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel,
  });

  return new Promise((resolve) => {
    $("diffApply").onclick = () => {
      modal.classList.add("u-hidden");
      if (diffEditor) diffEditor.setModel(null);
      originalModel.dispose();
      modifiedModel.dispose();
      resolve(true);
    };
    $("diffCancel").onclick = () => {
      modal.classList.add("u-hidden");
      if (diffEditor) diffEditor.setModel(null);
      originalModel.dispose();
      modifiedModel.dispose();
      resolve(false);
    };
  });
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
  return Math.ceil(text.length / 3);
}

function trimAgentHistory(history, maxTokens = 90000) {
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

async function runAgentLoop(initialInstruction) {
  const workspaceRoot = dom.explorerPath.value || "";
  setAgentStatus("初期化中...", "thinking");

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
        if (toolName === "read_file") {
          const filePath = params.path;
          if (!filePath) throw new Error("path パラメータが必要です");

          const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
          const fileData = await api(
            `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
          );
          toolResultText = fileData.content;
          toolSuccess = true;

          await openFile(fullPath);
        } else if (toolName === "write_file") {
          const filePath = params.path;
          const content = params.content;
          if (!filePath) throw new Error("path パラメータが必要です");

          const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);
          await api(`/api/agent/sessions/${sessionId}/files`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: fullPath, content }),
          });
          toolResultText = `ファイル ${filePath} の書き込みに成功しました。`;
          toolSuccess = true;

          await openFile(fullPath);
        } else if (toolName === "apply_diff") {
          const filePath = params.path;
          const diff = params.diff;
          if (!filePath) throw new Error("path パラメータが必要です");
          if (diff === undefined) throw new Error("diff パラメータが必要です");

          const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, filePath);

          // 既存の内容を取得してプレビューを表示
          const currentFileData = await api(
            `/api/agent/sessions/${sessionId}/files?path=${encodeURIComponent(fullPath)}`,
          );
          const oldContent = currentFileData.content;

          // サーバーサイドのロジックをシミュレートして新しい内容を生成（プレビュー用）
          const patchResPreview = await api(`/api/agent/sessions/${sessionId}/diff`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: fullPath, diff, dryRun: true }),
          });
          const newContent = patchResPreview.newContent || oldContent;

          const accepted = await showDiffDialog(filePath, oldContent, newContent);

          if (accepted) {
            const patchRes = await api(`/api/agent/sessions/${sessionId}/diff`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: fullPath, diff }),
            });
            toolResultText = patchRes.message || `ファイル ${filePath} の置換に成功しました。`;
            toolSuccess = true;
            await openFile(fullPath);
          } else {
            toolResultText = "ユーザーによって変更が拒否されました。";
            toolSuccess = false;
          }
        } else if (toolName === "list_directory") {
          const dirPath = params.path || "";
          const fullPath = resolvePathRelativeToWorkspace(workspaceRoot, dirPath);
          const dirData = await api(
            `/api/agent/sessions/${sessionId}/dir?path=${encodeURIComponent(fullPath)}`,
          );
          if (dirData.items && dirData.items.length > 0) {
            toolResultText = dirData.items
              .map((item) => `- ${item.isDirectory ? "[Dir] " : "[File] "}${item.name}`)
              .join("\n");
          } else {
            toolResultText = "ディレクトリは空、または存在しません。";
          }
          toolSuccess = true;
        } else if (toolName === "search_files") {
          const query = params.query;
          if (!query) throw new Error("query パラメータが必要です");

          const searchData = await api(
            `/api/agent/sessions/${sessionId}/search?query=${encodeURIComponent(query)}`,
          );
          if (searchData.results && searchData.results.length > 0) {
            toolResultText = searchData.results
              .map((r) => `${r.file}:${r.line}: ${r.content}`)
              .join("\n");
          } else {
            toolResultText = "一致する検索結果が見つかりませんでした。";
          }
          toolSuccess = true;
        } else if (toolName === "run_command") {
          const command = params.command;
          if (!command) throw new Error("command パラメータが必要です");

          setAgentStatus("承認待ち...", "awaiting_approval");

          const runRes = await api(`/api/agent/sessions/${sessionId}/commands`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ command, cwd: workspaceRoot }),
          });

          if (runRes.requiresApproval) {
            const approvalToken = runRes.approvalToken;

            const approvalPromise = new Promise((resolve) => {
              state.agent.resolver = resolve;

              addAgentApprovalStep(
                command,
                workspaceRoot,
                approvalToken,
                async () => {
                  setAgentStatus("実行中...", "executing");
                  try {
                    const approveRes = await api(`/api/agent/sessions/${sessionId}/approve`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ approvalToken }),
                    });
                    resolve({ approved: true, result: approveRes });
                  } catch (e) {
                    resolve({ approved: true, error: e });
                  }
                },
                (reason) => {
                  resolve({ approved: false, reason });
                },
              );
            });

            const approvalResult = await approvalPromise;
            state.agent.resolver = null;

            if (approvalResult.abort) {
              break;
            }

            if (approvalResult.approved) {
              if (approvalResult.error) {
                toolResultText = `コマンド実行エラー: ${approvalResult.error.message}`;
                toolSuccess = false;
              } else {
                const resData = approvalResult.result;
                toolResultText = `Exit Code: ${resData.exitCode}\n\nSTDOUT:\n${resData.stdout}\n\nSTDERR:\n${resData.stderr}`;
                toolSuccess = resData.exitCode === 0;
              }
            } else {
              toolResultText = `コマンド実行が却下されました。理由: ${approvalResult.reason}`;
              toolSuccess = false;
            }
          } else {
            toolResultText = `Exit Code: ${runRes.exitCode}\n\nSTDOUT:\n${runRes.stdout}\n\nSTDERR:\n${runRes.stderr}`;
            toolSuccess = runRes.exitCode === 0;
          }
        } else {
          throw new Error(`未知のツール: ${toolName}`);
        }
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
  $("agentRunningControls").style.display = "none";
  dom.agentInstruction.disabled = false;
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

  state.agent.active = true;
  dom.startAgentBtn.style.display = "none";
  $("agentRunningControls").style.display = "flex";
  dom.agentInstruction.disabled = true;

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
    dom.agentInstruction.disabled = false;
    $("agentRunningControls").style.display = "none";
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
      placeholder.textContent =
        "エージェントの実行を開始すると、思考や行動のログがここに表示されます。";
      log.appendChild(placeholder);
    }
    setAgentStatus("待機中", "idle");
    toast.success("セッションをリセットしました");
  }
};

dom.sendAgentFeedbackBtn.onclick = () => {
  const feedback = dom.agentFeedbackInput.value.trim();
  if (!feedback) return;
  dom.agentFeedbackInput.value = "";

  addAgentTimelineStep("thought", "フィードバック追加", feedback);

  if (state.agent.resolver) {
    state.agent.resolver({ approved: false, reason: `ユーザー指示: ${feedback}` });
  } else {
    state.agent.history.push({
      role: "user",
      content: `【ユーザーの追加フィードバック】\n${feedback}`,
    });
  }
};

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

initWorkspace();
initFolderPicker();
