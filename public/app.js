/**
 * Main application logic for 1min.ai Monaco Client
 * Depends on: js/api.js, js/models.js, js/toast.js
 */

// Initialize Model Pickers
loadModels().then(() => initModelPickers());

// ============================================================
const $ = (id) => document.getElementById(id);

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
    toast.error(`Health check failed: ${e.message}`);
  }
};

const MAX_CHAT_MESSAGES = 200;
const MAX_IMAGE_CARDS = 50;

// chat
const chatAttachments = []; // { file, previewUrl, assetKey, assetUrl }

function pruneChatLog() {
  const log = $("chatLog");
  while (log.children.length > MAX_CHAT_MESSAGES) {
    log.removeChild(log.firstChild);
  }
}

function pruneImageGallery() {
  const gallery = $("imageGallery");
  while (gallery.children.length > MAX_IMAGE_CARDS) {
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
  if (role === "ai" && window.marked) {
    const contentDiv = document.createElement("div");
    contentDiv.className = "msg-content";
    // Parse markdown then sanitize
    const rawHtml = marked.parse(content);
    contentDiv.innerHTML = window.DOMPurify ? DOMPurify.sanitize(rawHtml) : rawHtml;
    div.appendChild(contentDiv);
  } else {
    const contentDiv = document.createElement("div");
    contentDiv.className = "msg-content";
    contentDiv.textContent = content;
    div.appendChild(contentDiv);
  }

  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
  pruneChatLog();
}

// Image attachment handling
function updateAttachmentPreview() {
  const container = $("attachmentPreviews");
  const attachmentsArea = $("chatAttachments");

  if (chatAttachments.length === 0) {
    attachmentsArea.style.display = "none";
    container.innerHTML = "";
    return;
  }

  attachmentsArea.style.display = "block";
  container.innerHTML = "";

  chatAttachments.forEach((att, index) => {
    const thumb = document.createElement("div");
    thumb.className = "attachment-thumb";
    if (att.type === "image" && att.previewUrl) {
      thumb.innerHTML = `
        <img src="${att.previewUrl}" alt="preview" />
        <button type="button" class="remove-attachment" data-index="${index}">×</button>
        ${att.uploading ? '<div class="upload-spinner"></div>' : ""}
      `;
    } else {
      const ext = att.file.name.split(".").pop().toUpperCase();
      thumb.innerHTML = `
        <div class="attachment-file-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          <span class="attachment-file-ext">${ext}</span>
        </div>
        <span class="attachment-file-name" title="${att.file.name}">${att.file.name.length > 20 ? att.file.name.slice(0, 17) + "..." : att.file.name}</span>
        <button type="button" class="remove-attachment" data-index="${index}">×</button>
        ${att.uploading ? '<div class="upload-spinner"></div>' : ""}
      `;
    }
    container.appendChild(thumb);
  });

  // Bind remove buttons
  container.querySelectorAll(".remove-attachment").forEach((btn) => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.index);
      if (chatAttachments[idx].previewUrl) URL.revokeObjectURL(chatAttachments[idx].previewUrl);
      chatAttachments.splice(idx, 1);
      updateAttachmentPreview();
    };
  });
}

// Attach image button
$("attachImageBtn").onclick = () => {
  $("chatImageInput").click();
};

// File input change
$("chatImageInput").onchange = async (e) => {
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
    chatAttachments.push(att);
  }

  updateAttachmentPreview();
  e.target.value = "";
};

// Upload attachments to 1min.ai Asset API (parallel)
async function uploadAttachments() {
  const pending = chatAttachments.filter((att) => !att.assetKey);

  if (pending.length === 0) {
    return chatAttachments.map((att) => ({
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
      const res = await fetch("/api/assets/upload", { method: "POST", body: fd });
      if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
      const data = await res.json();
      const key = data?.asset?.key || data?.fileContent?.path || data?.asset?.location || "";
      const url = key ? assetUrl(key) : "";
      att.assetKey = key;
      att.assetUrl = url;
      att.uploading = false;
      return { type: att.type || "image", assetKey: key, url };
    }),
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === "rejected") {
      pending[i].uploading = false;
      toast.error(`アップロード失敗: ${results[i].reason.message}`);
    }
  }

  updateAttachmentPreview();
  return chatAttachments
    .filter((att) => att.assetKey)
    .map((att) => ({ type: att.type || "image", assetKey: att.assetKey, url: att.assetUrl }));
}

$("sendChat").onclick = async () => {
  const prompt = $("chatPrompt").value.trim();
  if (!prompt && chatAttachments.length === 0) return;

  const sendBtn = $("sendChat");
  sendBtn.disabled = true;

  const imagePreviews = chatAttachments.map((att) => ({ url: att.previewUrl }));
  addMsg("user", prompt || "(画像のみ)", imagePreviews);
  $("chatPrompt").value = "";

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
  $("chatLog").appendChild(aiMsgDiv);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;

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

    const response = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        model: $("chatModel").value,
        conversationId: $("conversationId").value || undefined,
        webSearch: $("webSearch").checked,
        withMemories: $("withMemories")?.checked || false,
        isMixed: $("isMixed")?.checked || false,
        brandVoiceId: $("brandVoiceId")?.value?.trim() || undefined,
        attachments: Object.keys(apiAttachments).length > 0 ? apiAttachments : undefined,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const dataStr = line.slice(6).trim();
          if (!dataStr || dataStr === "[DONE]") continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.content) {
              fullText += data.content;
              if (window.marked) {
                const rawHtml = marked.parse(fullText);
                aiContentDiv.innerHTML = window.DOMPurify
                  ? DOMPurify.sanitize(rawHtml)
                  : rawHtml;
              } else {
                aiContentDiv.textContent = fullText;
              }
              $("chatLog").scrollTop = $("chatLog").scrollHeight;
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

    if (window.marked) {
      const rawHtml = marked.parse(fullText);
      aiContentDiv.innerHTML = window.DOMPurify
        ? DOMPurify.sanitize(rawHtml)
        : rawHtml;
    } else {
      aiContentDiv.textContent = fullText;
    }

    pruneChatLog();
  } catch (e) {
    aiContentDiv.textContent = `Error: ${e.message}`;
    toast.error(`Chat error: ${e.message}`);
    setStatus("エラー", "error");
  } finally {
    sendBtn.disabled = false;
    setStatus("準備完了");
    for (const att of chatAttachments) {
      if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    }
    chatAttachments.length = 0;
    updateAttachmentPreview();
  }
};

$("createConversation").onclick = async () => {
  try {
    const data = await api("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: $("conversationTitle").value, model: $("chatModel").value }),
    });
    const id =
      data?.conversation?.uuid ||
      data?.uuid ||
      data?.aiRecord?.conversationId ||
      data?.conversationId ||
      "";
    $("conversationId").value = id;
    toast.success("会話を作成しました", { duration: 5000 });
  } catch (e) {
    toast.error(`Failed to create conversation: ${e.message}`);
  }
};

// images
function renderImages(data) {
  const images = extractImages(data);
  if (!images.length) {
    const pre = document.createElement("pre");
    pre.className = "json";
    pre.textContent = JSON.stringify(data, null, 2);
    $("imageGallery").prepend(pre);
    return;
  }
  for (const img of images) {
    const card = document.createElement("div");
    card.className = "imageCard";
    const url = assetUrl(img);
    const imgEl = document.createElement("img");
    imgEl.src = url;
    imgEl.alt = "generated";
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
    $("imageGallery").prepend(card);
    pruneImageGallery();
  }
}

$("generateImage").onclick = async () => {
  const imageUrl = $("editorImageUrl").value.trim();
  const prompt = $("imagePrompt").value.trim();
  const model = $("imageModel").value;

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

    $("assetResult").textContent = JSON.stringify(data, null, 2);
    renderImages(data);
  } catch (e) {
    toast.error(`処理に失敗しました: ${e.message}`);
  }
};

$("uploadAsset").onclick = async () => {
  const file = $("assetInput").files[0];
  if (!file) {
    toast.warning("画像ファイルを選択してください");
    return;
  }
  const fd = new FormData();
  fd.append("asset", file);
  try {
    const data = await api("/api/assets/upload", { method: "POST", body: fd });
    $("assetResult").textContent = JSON.stringify(data, null, 2);
    const key = data?.asset?.key || data?.fileContent?.path || data?.asset?.location || "";
    if (key) {
      $("editorImageUrl").value = key;
      updateEditorImagePreview(key);
    }
    toast.success("アップロード完了");
  } catch (e) {
    toast.error(`Asset upload failed: ${e.message}`);
  }
};

function updateEditorImagePreview(imageUrl) {
  const input = $("editorImageUrl");
  const preview = $("editorImagePreview");
  const clearBtn = $("clearImageBtn");
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

$("editorImageUrl").oninput = () => updateEditorImagePreview();

$("clearImageBtn").onclick = () => {
  $("editorImageUrl").value = "";
  $("assetInput").value = "";
  updateEditorImagePreview();
};

// Monaco editor
let activeFilePath = null;

require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs" } });
require(["vs/editor/editor.main"], function () {
  window.editor = monaco.editor.create($("editor"), {
    value: `/* ⬅ 左のツリーからファイルを選択するか、パスを入力して読み込んでください */\n`,
    language: "plaintext",
    theme: "vs-dark",
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    wordWrap: "on",
    inlineSuggest: { enabled: true },
  });

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
          const res = await fetch("/api/code/autocomplete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              code,
              line,
              column,
              fileName: activeFilePath ? activeFilePath.split(/[\\/]/).pop() : "untitled",
              language: model.getLanguageId(),
              model: $("codeModel").value,
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

let isInlineChatOpen = false;
let inlineChatDom = null;

const inlineChatWidget = {
  getId: () => "inline.chat.widget",
  getDomNode: function () {
    if (!inlineChatDom) {
      inlineChatDom = document.createElement("div");
      inlineChatDom.className = "inline-chat-widget";
      inlineChatDom.style.width = "350px";
      inlineChatDom.innerHTML = `
        <div class="inline-chat-input-row">
          <input type="text" id="inlineChatPrompt" placeholder="AIへの指示を入力 (例: ループを追加)..." />
          <button type="button" id="inlineChatSubmit">送信</button>
        </div>
        <div id="inlineChatStatus" class="inline-chat-status" style="display: none;">生成中...</div>
      `;

      const input = inlineChatDom.querySelector("#inlineChatPrompt");
      input.onkeydown = async (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          await submitInlineChat();
        } else if (e.key === "Escape") {
          closeInlineChat();
        }
      };

      const button = inlineChatDom.querySelector("#inlineChatSubmit");
      button.onclick = async () => {
        await submitInlineChat();
      };
    }
    return inlineChatDom;
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
  if (!activeFilePath || !window.editor) return;
  const input = inlineChatDom.querySelector("#inlineChatPrompt");
  const status = inlineChatDom.querySelector("#inlineChatStatus");
  const prompt = input.value.trim();
  if (!prompt) return;

  status.style.display = "block";
  status.className = "inline-chat-status loading";
  input.disabled = true;

  const code = window.editor.getValue();
  const position = window.editor.getPosition();
  const fileName = activeFilePath.split(/[\\/]/).pop();
  const language = window.editor.getModel()?.getLanguageId() || "plaintext";

  try {
    const res = await fetch("/api/code/inline-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        code,
        line: position.lineNumber,
        column: position.column,
        fileName,
        language,
        model: $("codeModel").value,
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
  if (!activeFilePath) {
    toast.warning("ファイルを編集するには、左のツリーからファイルを開いてください。");
    return;
  }
  if (isInlineChatOpen) {
    closeInlineChat();
  } else {
    window.editor.addContentWidget(inlineChatWidget);
    isInlineChatOpen = true;
    setTimeout(() => {
      const input = inlineChatDom?.querySelector("#inlineChatPrompt");
      if (input) input.focus();
    }, 50);
  }
}

function closeInlineChat() {
  if (isInlineChatOpen) {
    window.editor.removeContentWidget(inlineChatWidget);
    isInlineChatOpen = false;
    window.editor.focus();
  }
}

async function loadWorkspace(dirPath = null) {
  try {
    const data = await api(`/api/fs/list${dirPath ? `?dir=${encodeURIComponent(dirPath)}` : ""}`);
    $("explorerPath").value = data.dir;
    $("fileTree").innerHTML = "";
    await renderTreeNodes(data.items, $("fileTree"), 0);
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

    const toggle = document.createElement("span");
    toggle.className = "node-toggle";
    toggle.innerHTML = item.isDirectory ? "▶" : "";
    node.appendChild(toggle);

    const icon = document.createElement("span");
    icon.className = "node-icon";
    icon.innerHTML = item.isDirectory ? "📁" : "📄";
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
      container.appendChild(childrenContainer);

      node.onclick = async (e) => {
        e.stopPropagation();
        const isExpanded = node.classList.toggle("expanded");
        if (isExpanded) {
          childrenContainer.style.display = "flex";
          toggle.innerHTML = "▼";
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
          toggle.innerHTML = "▶";
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

      // Dispose unused models (keep max 20 open)
      const allModels = monaco.editor.getModels();
      if (allModels.length > 20) {
        const unused = allModels.filter((m) => m !== window.editor.getModel());
        for (const m of unused.slice(0, allModels.length - 20)) {
          m.dispose();
        }
      }

      activeFilePath = filePath;
      $("currentFileName").textContent = filePath.replace(/\\/g, "/").split("/").pop();
      $("currentFileName").title = filePath;
      $("saveFileBtn").disabled = false;

      document.querySelectorAll(".tree-node.file").forEach((x) => {
        if (x.dataset.path === filePath) {
          x.classList.add("active");
        } else {
          x.classList.remove("active");
        }
      });
    }
  } catch (e) {
    toast.error(`ファイルの読み込みに失敗しました: ${e.message}`);
  }
}

let _saveStatusTimer = null;

async function saveFile() {
  if (!activeFilePath || !window.editor) return;
  const content = window.editor.getValue();
  try {
    setStatus("保存中...", "warn");
    await api("/api/fs/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: activeFilePath, content }),
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
  const pathVal = $("explorerPath").value.trim();
  loadWorkspace(pathVal || null);
};

$("explorerPath").onkeydown = (e) => {
  if (e.key === "Enter") {
    const pathVal = $("explorerPath").value.trim();
    loadWorkspace(pathVal || null);
  }
};

$("saveFileBtn").onclick = () => {
  saveFile();
};

// ============================================================
// AI Coding Agent Orchestration
// ============================================================
let agentActive = false;
let agentSessionId = null;
let agentConversationHistory = [];
let currentAgentResolver = null;

function setAgentStatus(statusText, statusClass) {
  const badge = $("agentStatus");
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
  const log = $("agentActivityLog");
  if (!log) return;

  // Remove placeholder if present
  const placeholder = log.querySelector(".timeline-placeholder");
  if (placeholder) placeholder.remove();

  const stepId = "step-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);

  const step = document.createElement("div");
  step.className = `agent-step ${type}`;
  step.id = stepId;

  let iconHtml = "";
  if (type === "thought") {
    iconHtml =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="9"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>思考';
  } else if (type === "action") {
    iconHtml =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path><circle cx="12" cy="12" r="3"></circle></svg>ツール呼び出し';
  } else if (type === "result") {
    iconHtml =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><polyline points="20 6 9 17 4 12"></polyline></svg>実行結果';
  } else if (type === "error") {
    iconHtml =
      '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>エラー';
  }

  const time = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  let cardHtml = `
    <div class="agent-step-card">
      <div class="agent-step-header">
        <span class="agent-step-icon">${iconHtml}: ${escapeHtml(title)}</span>
        <span class="agent-step-time">${time}</span>
      </div>
      <div class="agent-step-body">${formatMarkdownLike(body)}</div>
  `;

  if (resultText !== null) {
    cardHtml += `
      <div class="agent-step-result-toggle" onclick="toggleTimelineResult('${stepId}')">
        <span>▶ 実行出力を表示</span>
      </div>
      <pre id="result-${stepId}" class="agent-step-result-box" style="display: none;">${escapeHtml(resultText)}</pre>
    `;
  }

  cardHtml += `</div>`;
  step.innerHTML = cardHtml;

  log.appendChild(step);
  log.scrollTop = log.scrollHeight;
  return stepId;
}

window.toggleTimelineResult = function (stepId) {
  const box = document.getElementById(`result-${stepId}`);
  if (!box) return;
  const toggle = box.previousElementSibling;
  if (box.style.display === "none") {
    box.style.display = "block";
    toggle.querySelector("span").textContent = "▼ 実行出力を非表示";
  } else {
    box.style.display = "none";
    toggle.querySelector("span").textContent = "▶ 実行出力を表示";
  }
};

function addAgentApprovalStep(command, cwd, approvalToken, onApprove, onReject) {
  const log = $("agentActivityLog");
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

  step.innerHTML = `
    <div class="agent-step-card">
      <div class="agent-step-header">
        <span class="agent-step-icon" style="color: #facc15;">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align: middle; margin-right: 4px;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
          承認要求: コマンド実行
        </span>
        <span class="agent-step-time">${time}</span>
      </div>
      <div class="agent-step-body">
        エージェントが以下のコマンドを実行しようとしています。
        <div class="approval-details">
          <strong>コマンド:</strong> <code>${escapeHtml(command)}</code><br>
          <strong>実行ディレクトリ:</strong> <code>${escapeHtml(cwd)}</code>
        </div>
        <input type="text" id="feedback-${stepId}" class="approval-feedback-input" placeholder="却下する場合は理由を入力してください..." />
        <div class="approval-actions">
          <button type="button" class="approval-btn approve" id="approve-${stepId}">許可</button>
          <button type="button" class="approval-btn reject" id="reject-${stepId}">却下</button>
        </div>
      </div>
    </div>
  `;

  log.appendChild(step);
  log.scrollTop = log.scrollHeight;

  const approveBtn = step.querySelector(`#approve-${stepId}`);
  const rejectBtn = step.querySelector(`#reject-${stepId}`);
  const feedbackInput = step.querySelector(`#feedback-${stepId}`);

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

function parseXMLTags(text) {
  const thoughtMatch = text.match(/<thought>([\s\S]*?)<\/thought>/i);
  const finishMatch = text.match(/<finish>([\s\S]*?)<\/finish>/i);
  const toolMatch = text.match(/<call_tool\s+name=["'](\w+)["']\s*>([\s\S]*?)<\/call_tool>/i);

  let toolCall = null;
  if (toolMatch) {
    const toolName = toolMatch[1];
    const innerContent = toolMatch[2];
    const params = {};

    const paramRegex = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let match;
    while ((match = paramRegex.exec(innerContent)) !== null) {
      params[match[1]] = match[2].trim();
    }
    toolCall = { name: toolName, params };
  }

  let thought = null;
  if (thoughtMatch) {
    thought = thoughtMatch[1].trim();
  } else {
    const endIdx = text.search(/<(call_tool|finish)/i);
    if (endIdx > 0) {
      thought = text.substring(0, endIdx).trim();
    }
  }

  return {
    thought,
    finish: finishMatch ? finishMatch[1].trim() : null,
    toolCall,
  };
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
  const workspaceRoot = $("explorerPath").value || "";
  setAgentStatus("初期化中...", "thinking");

  let sessionData;
  try {
    sessionData = await api("/api/agent/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cwd: workspaceRoot,
        task: initialInstruction,
      }),
    });
  } catch (e) {
    addAgentTimelineStep(
      "error",
      "セッション作成失敗",
      `セッションの初期化に失敗しました: ${e.message}`,
    );
    setAgentStatus("エラー", "error");
    return;
  }

  const sessionId = sessionData.session.id;
  agentSessionId = sessionId;
  addAgentTimelineStep(
    "thought",
    "セッション開始",
    `エージェントセッションが開始されました。\nワークスペース: ${workspaceRoot}`,
  );

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

【思考のルール】
各ターンの最初には必ず <thought> タグ内で自身の現状分析、次に行うべきステップ、ツールの選択理由を詳細に論理的に説明してください。

【ツール利用ルール】
思考の直後に、以下のツールのいずれかを必ず1つだけ呼び出してください。
複数のツールを同時に呼び出すことはできません。

1. read_file
   - パラメータ: { "path": "ファイルパス" }
   - 目的: ファイルの内容を確認する。編集前には必ず実行すること。
   <call_tool name="read_file"><parameter name="path">src/main.js</parameter></call_tool>

2. write_file
   - パラメータ: { "path": "ファイルパス", "content": "完全なコード内容" }
   - 目的: ファイルを新規作成または上書きする。変更は最小限ではなく、ファイル全体の正解コードを送ること。
   <call_tool name="write_file"><parameter name="path">utils/helper.js</parameter><parameter name="content">export const add = (a, b) => a + b;</parameter></call_tool>

3. search_files
   - パラメータ: { "query": "検索文字列" }
   - 目的: プロジェクト全体から特定のシンボルや文字列を検索する。
   <call_tool name="search_files"><parameter name="query">app.listen</parameter></call_tool>

4. run_command
   - パラメータ: { "command": "シェルコマンド" }
   - 目的: テストの実行、依存関係の確認など。破壊的な操作は控え、実行前にユーザーの承認を求めることを想定すること。
   <call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>

【完了報告】
目的を完全に達成した場合は、ツールの代わりに <finish>要約</finish> タグを使い、何を行ったか簡潔に報告してください。

【重要な注意】
- 出力は必ず <thought> と <call_tool> (または <finish>) のペアのみにしてください。
- 余計な挨拶、マークダウンのコードブロック、解説文をタグの外側に含めないでください。
- すでに存在するファイルを変更する場合、まず read_file で現在の内容を確認することが必須です。

現在のワークスペース構造:
${workspaceFilesText}

現在 Monaco エディタで開いているファイル:
パス: ${activeFilePath || "なし"}
`;

  agentConversationHistory = [
    { role: "user", content: `${sysPrompt}\n\n【指示】\n${initialInstruction}` },
  ];

  let agentConversationId = null;
  try {
    const convData = await api("/api/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Agent: ${initialInstruction.slice(0, 50)}`,
        model: modelSelected,
      }),
    });
    agentConversationId =
      convData?.conversation?.uuid ||
      convData?.uuid ||
      convData?.aiRecord?.conversationId ||
      convData?.conversationId ||
      null;
  } catch (e) {
    addAgentTimelineStep("thought", "会話作成失敗", `会話履歴なしで続行します: ${e.message}`);
  }

  let loopCount = 0;
  const maxLoops = 20;

  while (agentActive && loopCount < maxLoops) {
    loopCount++;
    setAgentStatus("思考中...", "thinking");

    const lastMsg = agentConversationHistory[agentConversationHistory.length - 1].content;

    let chatRes;
    try {
      chatRes = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: lastMsg,
          model: modelSelected,
          conversationId: agentConversationId,
          history: true,
          webSearch: false,
        }),
      });

      if (!agentConversationId) {
        agentConversationId =
          chatRes?.aiRecord?.conversationId ||
          chatRes?.conversationId ||
          null;
      }
    } catch (e) {
      addAgentTimelineStep("error", "AI通信失敗", `AIとの通信に失敗しました: ${e.message}`);
      setAgentStatus("エラー", "error");
      break;
    }

    const aiText = extractText(chatRes);
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
            body: JSON.stringify({ command, cwd: workspaceRoot, requireApproval: true }),
          });

          if (runRes.requiresApproval) {
            const approvalToken = runRes.approvalToken;

            const approvalPromise = new Promise((resolve) => {
              currentAgentResolver = resolve;

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
            currentAgentResolver = null;

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

      const feedbackMsg = `<tool_response>
${toolResultText}
</tool_response>`;

      agentConversationHistory.push({ role: "assistant", content: aiText });
      agentConversationHistory.push({ role: "user", content: feedbackMsg });
      trimAgentHistory(agentConversationHistory);
    } else {
      const errMsg = `エラー: ツール呼び出しまたはタスク完了タグ (<call_tool> または <finish>) が見つかりませんでした。
指示に従って、思考を <thought>タグで囲み、直後に呼び出すツールを <call_tool> タグで指定してください。`;
      addAgentTimelineStep(
        "error",
        "パース失敗",
        "AIが定義されたXMLフォーマットに準拠していません。自動修正指示を送信します。",
      );

      agentConversationHistory.push({ role: "assistant", content: aiText });
      agentConversationHistory.push({ role: "user", content: errMsg });
      trimAgentHistory(agentConversationHistory);
    }

    await new Promise((resolve) => setTimeout(resolve, 800));
  }

  if (loopCount >= maxLoops && agentActive) {
    addAgentTimelineStep(
      "error",
      "制限到達",
      `実行ステップ数が上限 (${maxLoops}) に達したため、安全のために停止しました。`,
    );
    setAgentStatus("エラー", "error");
  }
}

$("startAgentBtn").onclick = async () => {
  if (agentActive) return;

  const instruction = $("agentInstruction").value.trim();
  if (!instruction) {
    toast.warning("指示を入力してください。");
    return;
  }

  $("startAgentBtn").disabled = true;
  $("agentInstruction").disabled = true;
  $("agentRunningControls").style.display = "flex";
  $("agentFeedbackContainer").style.display = "block";

  const log = $("agentActivityLog");
  if (log) log.innerHTML = "";

  agentActive = true;

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
    agentActive = false;
    $("startAgentBtn").disabled = false;
    $("agentInstruction").disabled = false;
    $("agentRunningControls").style.display = "none";
    $("agentFeedbackContainer").style.display = "none";
  }
};

$("stopAgentBtn").onclick = () => {
  if (!agentActive) return;

  agentActive = false;
  if (currentAgentResolver) {
    currentAgentResolver({ abort: true });
  }
  setAgentStatus("停止", "idle");
  addAgentTimelineStep(
    "thought",
    "一時停止/終了",
    "ユーザーの指示によりエージェントを停止しました。",
  );
};

$("resetAgentBtn").onclick = () => {
  agentActive = false;
  if (currentAgentResolver) {
    currentAgentResolver({ abort: true });
  }
  agentSessionId = null;
  agentConversationHistory = [];

  const log = $("agentActivityLog");
  if (log) {
    log.innerHTML = `<div class="timeline-placeholder" style="color: var(--text-muted); font-size: 0.85rem; text-align: center; padding: 24px 8px; border: 1px dashed rgba(255,255,255,0.05); border-radius: 8px; background: rgba(255,255,255,0.01);">エージェントの実行を開始すると、思考や行動のログがここに表示されます。</div>`;
  }
  $("agentInstruction").value = "";
  setAgentStatus("待機中", "idle");
  toast.success("セッションをリセットしました");
};

$("sendAgentFeedbackBtn").onclick = () => {
  const input = $("agentFeedbackInput");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";

  addAgentTimelineStep("thought", "フィードバック追加", text);

  if (currentAgentResolver) {
    currentAgentResolver({ approved: false, reason: `ユーザー指示: ${text}` });
  } else {
    agentConversationHistory.push({
      role: "user",
      content: `【ユーザーの追加フィードバック】\n${text}`,
    });
  }
};

async function initWorkspace() {
  try {
    const config = await api("/api/fs/config");

    // Populate root selector
    const rootSelector = $("rootSelector");
    if (rootSelector) {
      rootSelector.innerHTML = "";

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
    body.innerHTML = '<div class="folder-picker-loading">フォルダを読み込み中...</div>';
  };

  const renderDrives = async () => {
    try {
      const data = await api("/api/fs/drives");
      drives.innerHTML = "";
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
      drives.innerHTML = "";
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
      body.innerHTML = "";

      const directories = data.items.filter((item) => item.isDirectory);
      if (directories.length === 0) {
        body.innerHTML = '<div class="folder-picker-empty">表示できるフォルダがありません</div>';
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
      body.innerHTML = `<div class="folder-picker-error-text">フォルダを読み込めませんでした: ${err.message}</div>`;
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
  };

  window.closeFolderPicker = () => {
    modal.style.display = "none";
    hideError();
  };

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
