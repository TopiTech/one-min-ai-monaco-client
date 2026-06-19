/**
 * Chat functionality module
 * Handles chat messaging, streaming, and attachments
 */

import { api, assetUrl } from "./api.js";
import { renderMarkdownSafely } from "./utils.js";

const MAX_MESSAGES = 200;
const MAX_STREAM_MS = 5 * 60 * 1000;
const UPLOAD_CONCURRENCY = 3;

export function createChatState() {
  return {
    attachments: [],
    abortController: null,
  };
}

export function createChatManager(dom, state) {
  function pruneChatLog() {
    const log = dom.chatLog;
    if (!log) return;

    // UI-10: Preserve scroll position when pruning from the top
    const isAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 80;
    let scrollOffset = 0;
    if (!isAtBottom) {
      // User has scrolled up; track the visual anchor
      scrollOffset = log.scrollTop;
    }

    while (log.children.length > MAX_MESSAGES) {
      log.removeChild(log.firstChild);
    }

    if (!isAtBottom) {
      // Restore approximate scroll position
      log.scrollTop = Math.max(0, log.scrollTop);
    }
  }

  function addMsg(role, content, images = []) {
    const div = document.createElement("div");
    div.className = `msg ${role === "user" ? "user" : "ai"}`;

    const roleSpan = document.createElement("span");
    roleSpan.className = "role";
    roleSpan.textContent = role;
    div.appendChild(roleSpan);

    if (images && images.length > 0) {
      const imagesDiv = document.createElement("div");
      imagesDiv.className = "msg-images";
      for (const img of images) {
        const imgEl = document.createElement("img");
        imgEl.className = "msg-image";
        imgEl.alt = "attached";
        imgEl.src = img.url || img.assetUrl || img;
        imgEl.onerror = function () {
          this.classList.add("is-error-hidden");
        };
        imagesDiv.appendChild(imgEl);
      }
      div.appendChild(imagesDiv);
    }

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

  function updateAttachmentPreview() {
    const container = dom.attachmentPreviews;
    const attachmentsArea = dom.chatAttachments;
    const attachments = state.chat.attachments;

    if (!container || !attachmentsArea) return;

    if (attachments.length === 0) {
      attachmentsArea.classList.add("u-hidden");
      container.textContent = "";
      return;
    }

    attachmentsArea.classList.remove("u-hidden");
    container.textContent = "";

    attachments.forEach((att, index) => {
      const thumb = document.createElement("div");
      thumb.className = "attachment-thumb";

      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "remove-attachment";
      removeButton.dataset.index = index;
      removeButton.textContent = "\u00d7";

      if (att.type === "image" && att.previewUrl) {
        const img = document.createElement("img");
        img.src = att.previewUrl;
        img.alt = "preview";
        img.onerror = function () {
          this.classList.add("is-error-hidden");
        };
        thumb.appendChild(img);
      } else {
        const ext = att.file.name.split(".").pop().toUpperCase();
        const icon = document.createElement("div");
        icon.className = "attachment-file-icon";
        icon.textContent = ext;
        thumb.appendChild(icon);

        const nameSpan = document.createElement("span");
        nameSpan.className = "attachment-file-name";
        nameSpan.textContent = att.file.name.length > 20 ? att.file.name.slice(0, 17) + "..." : att.file.name;
        nameSpan.title = att.file.name;
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

    const queue = [...pending];
    const results = new Array(pending.length);

    const worker = async () => {
      while (queue.length > 0) {
        const index = pending.length - queue.length;
        const att = queue.shift();
        dom.chatLog.setAttribute("aria-busy", "true");

        try {
          const fd = new FormData();
          fd.append("asset", att.file);
          const data = await api("/api/assets/upload", { method: "POST", body: fd });
          const key = data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || "";
          const url = data?.url || (key ? assetUrl(key) : "");
          att.assetKey = key;
          att.assetUrl = url;
          att.uploading = false;
          results[index] = {
            status: "fulfilled",
            value: { type: att.type || "image", assetKey: key, url },
          };
        } catch (err) {
          att.uploading = false;
          results[index] = { status: "rejected", reason: err };
          if (typeof toast !== "undefined") {
            toast.error(`アップロード失敗 (${att.file.name}): ${err.message || "不明なエラー"}`);
          }
        }
        updateAttachmentPreview();
      }
    };

    const workers = Array(Math.min(UPLOAD_CONCURRENCY, queue.length))
      .fill(null)
      .map(() => worker());

    await Promise.all(workers);

    return attachments
      .filter((att) => att.assetKey)
      .map((att) => ({ type: att.type || "image", assetKey: att.assetKey, url: att.assetUrl }));
  }

  async function sendChat(setStatus) {
    const prompt = dom.chatPrompt.value.trim();
    const attachments = state.chat.attachments;
    if (!prompt && attachments.length === 0) return;

    const sendBtn = dom.sendChatBtn;
    const abortBtn = dom.abortChatBtn;
    sendBtn.disabled = true;
    sendBtn.classList.add("u-hidden");
    abortBtn.classList.add("is-shown");

    state.chat.abortController = new AbortController();

    const imagePreviews = attachments.map((att) => ({ url: att.previewUrl }));
    addMsg("user", prompt || "(画像のみ)", imagePreviews);
    dom.chatPrompt.value = "";

    const aiMsgDiv = document.createElement("div");
    aiMsgDiv.className = "msg ai streaming";
    const aiRoleSpan = document.createElement("span");
    aiRoleSpan.className = "role";
    aiRoleSpan.textContent = "ai";
    aiMsgDiv.appendChild(aiRoleSpan);
    const aiContentDiv = document.createElement("div");
    aiContentDiv.className = "msg-content";
    aiContentDiv.innerHTML = '<span class="streaming-indicator"></span>';
    aiMsgDiv.appendChild(aiContentDiv);
    dom.chatLog.appendChild(aiMsgDiv);
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;

    setStatus("応答を受信中...", "warn");
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
      let streamDone = false;
      let streamError = null;
      let currentEvent = "content";

      const streamTimeoutId = setTimeout(() => {
        if (!streamDone) {
          streamDone = true;
          streamError = new Error("ストリーミングがタイムアウトしました（5分）");
          reader.cancel().catch(() => {});
        }
      }, MAX_STREAM_MS);

      let renderScheduled = false;
      const scheduleRender = () => {
        if (renderScheduled) return;
        renderScheduled = true;
        const run = () => {
          renderScheduled = false;
          if (fullText) {
            renderMarkdownSafely(aiContentDiv, fullText);
            dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
          }
        };
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(run);
        } else {
          setTimeout(run, 16);
        }
      };

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

          if (!line.startsWith("data:")) continue;
          const dataStr = line.replace(/^data:\s*/, "").trim();
          if (!dataStr) continue;

          if (dataStr === "[DONE]") {
            streamDone = true;
            break;
          }

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
              const text = extractTextFromRecord(data?.aiRecord || data);
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
              scheduleRender();
            }

            const finishReason = data?.choices?.[0]?.finish_reason;
            if (finishReason && finishReason !== "null") {
              streamDone = true;
              break;
            }
          } catch {
            console.debug("SSE non-JSON chunk:", dataStr);
          }
        }
      }

      clearTimeout(streamTimeoutId);
      if (streamError) throw streamError;
      if (fullText) renderMarkdownSafely(aiContentDiv, fullText);

      if (!fullText) {
        fullText = "(応答が空でした)";
      }

      renderMarkdownSafely(aiContentDiv, fullText);
      aiMsgDiv.classList.remove("streaming");
      pruneChatLog();
    } catch (e) {
      if (e.name === "AbortError") {
        fullText += "\n\n*(キャンセルされました)*";
        renderMarkdownSafely(aiContentDiv, fullText);
        setStatus("キャンセルしました", "warn");
      } else {
        const message = e?.message || "不明なエラー";
        console.error("Chat Stream Error:", e);
        aiContentDiv.textContent = `エラー: ${message}`;
        if (typeof toast !== "undefined") {
          toast.error(`チャットエラー: ${message}`);
        }
        setStatus("エラー", "error");
      }
    } finally {
      dom.chatLog.setAttribute("aria-busy", "false");
      state.chat.abortController = null;
      sendBtn.disabled = false;
      sendBtn.classList.remove("u-hidden");
      abortBtn.classList.remove("is-shown");
      setStatus("準備完了");
      state.chat.attachments.length = 0;
      updateAttachmentPreview();
    }
  }

  function abortChat() {
    if (state.chat.abortController) {
      state.chat.abortController.abort();
      state.chat.abortController = null;
    }
  }

  return {
    addMsg,
    updateAttachmentPreview,
    sendChat,
    abortChat,
    pruneChatLog,
  };
}

function extractTextFromRecord(record) {
  if (!record) return "";
  if (typeof record === "string") return record;
  return (
    record.content ||
    record?.choices?.[0]?.delta?.content ||
    record?.choices?.[0]?.message?.content ||
    record?.message?.content ||
    record?.delta?.content ||
    record?.text ||
    ""
  );
}
