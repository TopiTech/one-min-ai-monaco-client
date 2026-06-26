/**
 * Chat functionality module
 * Handles chat messaging, streaming, and attachments
 */

import { api, assetUrl } from './api.js';
import { renderMarkdownSafely } from './utils.js';
import { t } from './i18n.js';
import { extractTextFromOneMinResponse } from './one-min-response.js';
import { toast } from './toast.js';

const MAX_MESSAGES = 200;
const MAX_STREAM_MS = 5 * 60 * 1000;
const UPLOAD_CONCURRENCY = 3;
const MAX_STREAM_RETRIES = 2;
const RETRYABLE_STREAM_STATUSES = new Set([408, 429, 502, 503, 504]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createChatState() {
  return {
    attachments: [],
    abortController: null,
  };
}

export function createChatManager(dom, state) {
  const MAX_CHAT_LENGTH = 50000;

  function initCharCounter() {
    const textarea = dom.chatPrompt;
    const counter = document.getElementById('chatCharCounter');
    if (!textarea || !counter) return;

    const update = () => {
      const len = textarea.value.length;
      counter.textContent = `${len.toLocaleString()} / ${MAX_CHAT_LENGTH.toLocaleString()}`;
      counter.classList.toggle('warn', len > MAX_CHAT_LENGTH * 0.9);
      counter.classList.toggle('danger', len > MAX_CHAT_LENGTH * 0.95);
    };

    textarea.addEventListener('input', update);
    update(); // initial state
  }

  function pruneChatLog() {
    const log = dom.chatLog;
    if (!log) return;

    // F-6: Preserve scroll position when pruning from the top so users
    // who scrolled up to read history don't get yanked back to the
    // top on every prune.
    const isAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 80;
    let previousScrollHeight = 0;
    if (!isAtBottom) {
      previousScrollHeight = log.scrollHeight;
    }

    while (log.children.length > MAX_MESSAGES) {
      log.removeChild(log.firstChild);
    }

    if (!isAtBottom) {
      // Compensate for the height lost by removing children at the top:
      // scrollTop stays anchored to the same visible content.
      const heightDelta = previousScrollHeight - log.scrollHeight;
      log.scrollTop = Math.max(0, log.scrollTop - heightDelta);
    }
  }

  function addMsg(role, content, images = []) {
    const div = document.createElement('div');
    div.className = `msg ${role === 'user' ? 'user' : 'ai'}`;

    const roleSpan = document.createElement('span');
    roleSpan.className = 'role';
    roleSpan.textContent = role;
    div.appendChild(roleSpan);

    if (images && images.length > 0) {
      const imagesDiv = document.createElement('div');
      imagesDiv.className = 'msg-images';
      for (const img of images) {
        const imgEl = document.createElement('img');
        imgEl.className = 'msg-image';
        imgEl.alt = 'attached';
        imgEl.src = img.url || img.assetUrl || img;
        imgEl.onerror = function () {
          this.classList.add('is-error-hidden');
          const errorSpan = document.createElement('span');
          errorSpan.className = 'img-error-placeholder';
          errorSpan.textContent = t('chat_image_load_failed');
          this.after(errorSpan);
        };
        imagesDiv.appendChild(imgEl);
      }
      div.appendChild(imagesDiv);
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'msg-content';
    if (role === 'ai') {
      renderMarkdownSafely(contentDiv, content);
    } else {
      contentDiv.textContent = content;
    }
    div.appendChild(contentDiv);

    dom.chatLog.appendChild(div);

    // F-6: Only auto-scroll if the user was already at (or near) the bottom.
    // This prevents yanking users back down when they've scrolled up to
    // read history and a new message arrives.
    const isNearBottom = dom.chatLog.scrollTop + dom.chatLog.clientHeight >= dom.chatLog.scrollHeight - 120;
    if (isNearBottom) {
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    }

    pruneChatLog();
  }

  function updateAttachmentPreview() {
    const container = dom.attachmentPreviews;
    const attachmentsArea = dom.chatAttachments;
    const attachments = state.chat.attachments;

    if (!container || !attachmentsArea) return;

    if (attachments.length === 0) {
      attachmentsArea.classList.add('u-hidden');
      container.textContent = '';
      return;
    }

    attachmentsArea.classList.remove('u-hidden');
    container.textContent = '';

    attachments.forEach((att, index) => {
      const thumb = document.createElement('div');
      thumb.className = 'attachment-thumb';

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'remove-attachment';
      removeButton.dataset.index = index;
      removeButton.textContent = '\u00d7';

      if (att.type === 'image' && att.previewUrl) {
        const img = document.createElement('img');
        img.src = att.previewUrl;
        img.alt = 'preview';
        img.onerror = function () {
          this.classList.add('is-error-hidden');
          const errorSpan = document.createElement('span');
          errorSpan.className = 'img-error-placeholder';
          errorSpan.textContent = t('chat_image_error');
          this.after(errorSpan);
        };
        thumb.appendChild(img);
      } else {
        const ext = att.file.name.split('.').pop().toUpperCase();
        const icon = document.createElement('div');
        icon.className = 'attachment-file-icon';
        icon.textContent = ext;
        thumb.appendChild(icon);

        const nameSpan = document.createElement('span');
        nameSpan.className = 'attachment-file-name';
        nameSpan.textContent = att.file.name.length > 20 ? att.file.name.slice(0, 17) + '...' : att.file.name;
        nameSpan.title = att.file.name;
        thumb.appendChild(nameSpan);
      }

      thumb.appendChild(removeButton);
      if (att.uploading) {
        const spinner = document.createElement('div');
        spinner.className = 'upload-spinner';
        thumb.appendChild(spinner);
      }

      container.appendChild(thumb);
    });

    container.querySelectorAll('.remove-attachment').forEach((btn) => {
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
        type: att.type || 'image',
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
        dom.chatLog.setAttribute('aria-busy', 'true');

        try {
          const fd = new FormData();
          fd.append('asset', att.file);
          const data = await api('/api/assets/upload', { method: 'POST', body: fd });
          const key = data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || '';
          const url = data?.url || (key ? assetUrl(key) : '');
          att.assetKey = key;
          att.assetUrl = url;
          att.uploading = false;
          results[index] = {
            status: 'fulfilled',
            value: { type: att.type || 'image', assetKey: key, url },
          };
        } catch (err) {
          att.uploading = false;
          results[index] = { status: 'rejected', reason: err };
          toast.error(
            t('chat_upload_failed', { name: att.file.name, error: err.message || t('chat_unknown_error') }),
          );
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
      .map((att) => ({ type: att.type || 'image', assetKey: att.assetKey, url: att.assetUrl }));
  }

  async function sendChat(setStatus) {
    const prompt = dom.chatPrompt.value.trim();
    const attachments = state.chat.attachments;
    if (!prompt && attachments.length === 0) return;

    const sendBtn = dom.sendChatBtn;
    const abortBtn = dom.abortChatBtn;
    sendBtn.disabled = true;
    sendBtn.classList.add('u-hidden');
    abortBtn.classList.add('is-shown');

    state.chat.abortController = new AbortController();

    const imagePreviews = attachments.map((att) => ({ url: att.previewUrl }));
    addMsg('user', prompt || t('chat_image_only'), imagePreviews);
    dom.chatPrompt.value = '';

    const aiMsgDiv = document.createElement('div');
    aiMsgDiv.className = 'msg ai streaming';
    const aiRoleSpan = document.createElement('span');
    aiRoleSpan.className = 'role';
    aiRoleSpan.textContent = 'ai';
    aiMsgDiv.appendChild(aiRoleSpan);
    const aiContentDiv = document.createElement('div');
    aiContentDiv.className = 'msg-content';
    aiContentDiv.innerHTML = '<span class="streaming-indicator"></span>';
    aiMsgDiv.appendChild(aiContentDiv);
    dom.chatLog.appendChild(aiMsgDiv);
    // F-6: Only auto-scroll if the user was already near the bottom when they
    // sent the message. This prevents yanking users who had scrolled up to
    // read history back down to the bottom.
    const wasNearBottom = dom.chatLog.scrollTop + dom.chatLog.clientHeight >= dom.chatLog.scrollHeight - 120;
    if (wasNearBottom) {
      dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
    }

    setStatus(t('chat_receiving'), 'warn');
    let fullText = '';

    try {
      const uploadedAttachments = await uploadAttachments();

      const apiAttachments = {};
      const imageKeys = uploadedAttachments
        .filter((a) => a.type === 'image' && a.assetKey)
        .map((a) => a.assetKey);
      const fileKeys = uploadedAttachments
        .filter((a) => a.type === 'file' && a.assetKey)
        .map((a) => a.assetKey);
      if (imageKeys.length > 0) apiAttachments.images = imageKeys;
      if (fileKeys.length > 0) apiAttachments.files = fileKeys;

      const requestBody = JSON.stringify({
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
      });

      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
        let reader = null;
        let streamTimeoutId = null;

        try {
          if (attempt > 0) {
            const retryMessage = `${t('chat_stream_retry', { attempt: attempt + 1, total: MAX_STREAM_RETRIES + 1 })}`;
            aiContentDiv.textContent = retryMessage;
            setStatus(retryMessage, 'warn');
            await wait(Math.min(1000 * Math.pow(2, attempt - 1), 4000));
          }

          const response = await api('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
            signal: state.chat.abortController.signal,
            raw: true,
          });

          if (!response.ok) {
            let error;
            if (response.status === 422) {
              error = new Error(t('chat_invalid_request'));
            } else if (response.status >= 500) {
              error = new Error(t('chat_server_error'));
            } else {
              error = new Error(`HTTP ${response.status}`);
            }
            error.status = response.status;
            throw error;
          }

          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          let streamDone = false;
          let streamError = null;
          let currentEvent = 'content';

          streamTimeoutId = setTimeout(() => {
            if (!streamDone) {
              streamDone = true;
              streamError = new Error(t('chat_stream_timeout'));
              streamError.status = 408;
              reader?.cancel().catch(() => {});
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
            if (typeof requestAnimationFrame === 'function') {
              requestAnimationFrame(run);
            } else {
              setTimeout(run, 16);
            }
          };

          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
              if (line.startsWith('event: ')) {
                currentEvent = line.slice(7).trim();
                continue;
              }

              if (!line.startsWith('data:')) continue;
              const dataStr = line.replace(/^data:\s*/, '').trim();
              if (!dataStr) continue;

              if (dataStr === '[DONE]') {
                streamDone = true;
                break;
              }

              try {
                const data = JSON.parse(dataStr);

                if (currentEvent === 'error') {
                  streamError = new Error(data?.error || data?.message || 'Stream error');
                  streamDone = true;
                  break;
                }

                if (currentEvent === 'done') {
                  streamDone = true;
                  break;
                }

                if (currentEvent === 'result') {
                  const text = extractTextFromOneMinResponse(data?.aiRecord || data);
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
                if (finishReason && finishReason !== 'null') {
                  streamDone = true;
                  break;
                }
              } catch {
                console.debug('SSE non-JSON chunk:', dataStr);
              }
            }
          }

          if (streamError) throw streamError;
          if (fullText) renderMarkdownSafely(aiContentDiv, fullText);
          break;
        } catch (e) {
          const shouldRetry =
            e?.name !== 'AbortError' &&
            !fullText &&
            attempt < MAX_STREAM_RETRIES &&
            (!e?.status || RETRYABLE_STREAM_STATUSES.has(Number(e.status)));

          if (shouldRetry) {
            continue;
          }
          throw e;
        } finally {
          if (streamTimeoutId) {
            clearTimeout(streamTimeoutId);
          }
          if (reader) {
            try {
              reader.releaseLock();
            } catch {
              // ignore
            }
          }
        }
      }

      if (!fullText) {
        fullText = t('chat_empty_response');
      }

      renderMarkdownSafely(aiContentDiv, fullText);
      aiMsgDiv.classList.remove('streaming');
      pruneChatLog();
    } catch (e) {
      if (e.name === 'AbortError') {
        fullText += '\n\n*(' + t('chat_cancelled') + ')*';
        renderMarkdownSafely(aiContentDiv, fullText);
        setStatus(t('chat_cancelled'), 'warn');
      } else {
        const message = e?.message || t('chat_unknown_error');
        console.error('Chat Stream Error:', e);
        aiContentDiv.textContent = `${t('status_error')}: ${message}`;
        toast.error(t('chat_error', { error: message }));
        setStatus(t('status_error'), 'err');
        if (dom.chatLog) {
          dom.chatLog.setAttribute('aria-live', 'assertive');
          setTimeout(() => dom.chatLog.setAttribute('aria-live', 'polite'), 3000);
        }
      }
    } finally {
      dom.chatLog.setAttribute('aria-busy', 'false');
      state.chat.abortController = null;
      sendBtn.disabled = false;
      sendBtn.classList.remove('u-hidden');
      abortBtn.classList.remove('is-shown');
      setStatus(t('status_ready'));
      state.chat.attachments.forEach((att) => {
        if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
      });
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
    initCharCounter,
  };
}
