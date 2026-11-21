/**
 * Chat functionality module
 * Handles chat messaging, streaming, and attachments
 */

import { api, assetUrl } from './api.js';
import { renderMarkdownSafely } from './utils.js';
import { t } from './i18n.js';
import { findTextCandidate } from './one-min-response.js';
import { toast } from './toast.js';
import { getActiveProvider } from './settings.js';

const MAX_MESSAGES = 200;
const MAX_STREAM_MS = 5 * 60 * 1000;
const UPLOAD_CONCURRENCY = 3;
const MAX_STREAM_RETRIES = 2;
const RETRYABLE_STREAM_STATUSES = new Set([408, 429, 502, 503, 504]);
const STREAM_RENDER_INTERVAL_MS = 125;

function wait(ms, signal) {
  if (signal?.aborted) {
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return Promise.reject(err);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Aborted');
      err.name = 'AbortError';
      reject(err);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

async function readErrorMessage(response) {
  const fallback = `HTTP ${response.status}`;
  const text = await response.text().catch(() => '');
  if (!text) return fallback;
  try {
    const data = JSON.parse(text);
    return data?.error || data?.message || data?.details || fallback;
  } catch {
    return text.slice(0, 500) || fallback;
  }
}

export function createChatState() {
  return {
    attachments: [],
    abortController: null,
    history: [],
  };
}

export function createChatManager(dom, state) {
  const MAX_CHAT_LENGTH = 50000;

  function updateSendButton() {
    const prompt = dom.chatPrompt ? dom.chatPrompt.value.trim() : '';
    const hasAttachments = state.chat && state.chat.attachments && state.chat.attachments.length > 0;
    if (dom.sendChatBtn) {
      dom.sendChatBtn.disabled = !prompt && !hasAttachments;
    }
  }

  function initCharCounter() {
    const textarea = dom.chatPrompt;
    const counter = document.getElementById('chatCharCounter');
    if (!textarea) return;

    const adjustHeight = () => {
      textarea.style.height = 'auto';
      const minHeight = 90;
      const maxHeight = 240;
      const scrollHeight = textarea.scrollHeight;
      const newHeight = Math.min(Math.max(scrollHeight, minHeight), maxHeight);
      textarea.style.height = `${newHeight}px`;
      textarea.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
    };

    const update = () => {
      const len = textarea.value.length;
      if (counter) {
        counter.textContent = `${len.toLocaleString()} / ${MAX_CHAT_LENGTH.toLocaleString()}`;
        counter.classList.toggle('warn', len > MAX_CHAT_LENGTH * 0.9);
        counter.classList.toggle('danger', len > MAX_CHAT_LENGTH * 0.95);
      }
      adjustHeight();
      updateSendButton();
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
      const oldest = log.firstChild;
      if (oldest?._blobUrls && typeof URL?.revokeObjectURL === 'function') {
        for (const u of oldest._blobUrls) {
          URL.revokeObjectURL(u);
        }
      }
      log.removeChild(oldest);
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
      const blobUrls = [];
      for (const img of images) {
        const imgEl = document.createElement('img');
        imgEl.className = 'msg-image';
        imgEl.alt = 'attached';
        const srcUrl = img.url || img.assetUrl || img;
        if (typeof srcUrl === 'string' && srcUrl.startsWith('blob:')) {
          blobUrls.push(srcUrl);
        }
        imgEl.src = srcUrl;
        imgEl.onerror = function () {
          this.classList.add('is-error-hidden');
          const errorSpan = document.createElement('span');
          errorSpan.className = 'img-error-placeholder';
          errorSpan.textContent = t('chat_image_load_failed');
          this.after(errorSpan);
        };
        imagesDiv.appendChild(imgEl);
      }
      if (blobUrls.length > 0) {
        div._blobUrls = blobUrls;
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
      updateSendButton();
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
      removeButton.setAttribute('aria-label', t('remove_attachment') || 'Remove attachment');
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
        const idx = parseInt(btn.dataset.index, 10);
        const attachments = state.chat.attachments;
        if (attachments[idx].previewUrl) URL.revokeObjectURL(attachments[idx].previewUrl);
        attachments.splice(idx, 1);
        updateAttachmentPreview();
      };
    });

    updateSendButton();
  }

  async function uploadAttachments(signal) {
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

    const queue = pending.map((att, i) => ({ att, originalIndex: i }));
    const results = new Array(pending.length);

    const worker = async () => {
      while (queue.length > 0) {
        if (signal?.aborted) break;
        const item = queue.shift();
        if (!item) break;
        const { att, originalIndex } = item;
        dom.chatLog.setAttribute('aria-busy', 'true');

        try {
          const fd = new FormData();
          fd.append('asset', att.file);
          const provider = getActiveProvider();
          const data = await api(`/api/assets/upload?provider=${encodeURIComponent(provider)}`, {
            method: 'POST',
            body: fd,
            signal,
          });
          const key = data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || '';
          const url = data?.url || (key ? assetUrl(key) : '');
          att.assetKey = key;
          att.assetUrl = url;
          att.uploading = false;
          results[originalIndex] = {
            status: 'fulfilled',
            value: { type: att.type || 'image', assetKey: key, url },
          };
        } catch (err) {
          att.uploading = false;
          results[originalIndex] = { status: 'rejected', reason: err };
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

    const failed = results.filter((r) => r && r.status === 'rejected');
    if (failed.length > 0) {
      throw new Error(t('chat_upload_failed_some') || 'Some attachments failed to upload.');
    }

    return attachments
      .filter((att) => att.assetKey)
      .map((att) => ({ type: att.type || 'image', assetKey: att.assetKey, url: att.assetUrl }));
  }

  async function sendChat(setStatus) {
    if (state.chat.abortController) return;
    const prompt = dom.chatPrompt.value.trim();
    const attachments = state.chat.attachments;
    if (!prompt && attachments.length === 0) return;

    const sendBtn = dom.sendChatBtn;
    const abortBtn = dom.abortChatBtn;
    sendBtn.disabled = true;
    sendBtn.classList.add('u-hidden');
    abortBtn.classList.add('is-shown');

    const abortController = new AbortController();
    state.chat.abortController = abortController;

    const imagePreviews = attachments.filter((att) => att.previewUrl).map((att) => ({ url: att.previewUrl }));
    addMsg('user', prompt || t('chat_image_only'), imagePreviews);
    dom.chatPrompt.value = '';
    dom.chatPrompt.style.height = '';
    if (typeof dom.chatPrompt.dispatchEvent === 'function') {
      dom.chatPrompt.dispatchEvent(new Event('input'));
    }

    const aiMsgDiv = document.createElement('div');
    aiMsgDiv.className = 'msg ai streaming';
    const aiRoleSpan = document.createElement('span');
    aiRoleSpan.className = 'role';
    aiRoleSpan.textContent = 'ai';
    aiMsgDiv.appendChild(aiRoleSpan);
    const aiContentDiv = document.createElement('div');
    aiContentDiv.className = 'msg-content';
    const streamingIndicator = document.createElement('span');
    streamingIndicator.className = 'streaming-indicator';
    aiContentDiv.appendChild(streamingIndicator);
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
    let followStreamScroll = wasNearBottom;
    let exitedWithError = false;

    const provider = getActiveProvider();
    try {
      let requestPayload;
      if (provider === '1forall') {
        if (attachments.length > 0) {
          throw new Error(t('provider_feature_unsupported', { provider: '1forall.ai' }));
        }
        const history = Array.isArray(state.chat.history) ? state.chat.history : [];
        requestPayload = {
          provider: '1forall',
          prompt,
          messages: [...history, { role: 'user', content: prompt }],
          model: dom.chatModel.value,
        };
      } else {
        const uploadedAttachments = await uploadAttachments(abortController.signal);

        const apiAttachments = {};
        const imageKeys = uploadedAttachments
          .filter((a) => a.type === 'image' && a.assetKey)
          .map((a) => a.assetKey);
        const fileKeys = uploadedAttachments
          .filter((a) => a.type === 'file' && a.assetKey)
          .map((a) => a.assetKey);
        if (imageKeys.length > 0) apiAttachments.images = imageKeys;
        if (fileKeys.length > 0) apiAttachments.files = fileKeys;

        requestPayload = {
          provider: '1min',
          prompt,
          model: dom.chatModel.value,
          conversationId: dom.conversationId.value || undefined,
          webSearch: dom.webSearch.checked,
          numOfSite: dom.chatNumOfSite?.value ? parseInt(dom.chatNumOfSite.value, 10) : undefined,
          maxWord: dom.chatMaxWord?.value ? parseInt(dom.chatMaxWord.value, 10) : undefined,
          withMemories: dom.withMemories?.checked || false,
          isMixed: dom.isMixed?.checked || false,
          brandVoiceId: dom.brandVoiceId?.value?.trim() || undefined,
          attachments: Object.keys(apiAttachments).length > 0 ? apiAttachments : undefined,
        };
      }

      const requestBody = JSON.stringify(requestPayload);

      for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
        let reader = null;
        let streamTimeoutId = null;
        let cancelPendingRender = () => {};
        let readerFinished = false;

        try {
          if (attempt > 0) {
            const retryMessage = `${t('chat_stream_retry', { attempt: attempt + 1, total: MAX_STREAM_RETRIES + 1 })}`;
            aiContentDiv.textContent = retryMessage;
            setStatus(retryMessage, 'warn');
            await wait(Math.min(1000 * Math.pow(2, attempt - 1), 4000), abortController.signal);
          }

          const response = await api('/api/chat/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: requestBody,
            signal: abortController.signal,
            raw: true,
          });

          if (!response.ok) {
            const serverMessage = await readErrorMessage(response);
            let error;
            if (response.status === 422) {
              error = new Error(`${t('chat_invalid_request')}: ${serverMessage}`);
            } else if (response.status >= 500) {
              error = new Error(`${t('chat_server_error')}: ${serverMessage}`);
            } else {
              error = new Error(serverMessage);
            }
            error.status = response.status;
            throw error;
          }

          if (!response.body) {
            throw new Error(t('chat_stream_empty_body', 'Stream response body is empty'));
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
          let renderDisposed = false;
          let renderRafId = null;
          let renderTimerId = null;
          let lastRenderAt = 0;

          cancelPendingRender = () => {
            renderDisposed = true;
            renderScheduled = false;
            if (renderRafId !== null && typeof cancelAnimationFrame === 'function') {
              cancelAnimationFrame(renderRafId);
              renderRafId = null;
            }
            if (renderTimerId !== null) {
              clearTimeout(renderTimerId);
              renderTimerId = null;
            }
          };

          const scheduleRender = () => {
            if (renderScheduled || renderDisposed) return;
            renderScheduled = true;
            const run = () => {
              renderRafId = null;
              renderTimerId = null;
              renderScheduled = false;
              if (renderDisposed) return;
              if (fullText) {
                aiContentDiv.textContent = fullText;
                lastRenderAt = Date.now();
                if (followStreamScroll) {
                  dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
                }
              }
            };
            const delay = Math.max(0, STREAM_RENDER_INTERVAL_MS - (Date.now() - lastRenderAt));
            if (typeof requestAnimationFrame === 'function' && delay === 0) {
              renderRafId = requestAnimationFrame(run);
            } else {
              renderTimerId = setTimeout(run, delay || STREAM_RENDER_INTERVAL_MS);
            }
          };

          const processSseLine = (line) => {
            if (!line.trim()) {
              currentEvent = 'content';
              return;
            }

            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim() || 'content';
              return;
            }

            if (!line.startsWith('data:')) return;
            const dataStr = line.replace(/^data:\s*/, '').trim();
            if (!dataStr) return;

            if (dataStr === '[DONE]') {
              streamDone = true;
              return;
            }

            try {
              const data = JSON.parse(dataStr);

              if (currentEvent === 'error') {
                streamError = new Error(data?.error || data?.message || 'Stream error');
                streamDone = true;
                return;
              }

              if (currentEvent === 'done') {
                return;
              }

              if (currentEvent === 'result') {
                // The `result` event can arrive before, during, or after
                // incremental `content` chunks. If we've already accumulated
                // text from content events, only adopt the result if it
                // would extend what we have — otherwise leave fullText
                // untouched to avoid duplicate rendering.
                const text = findTextCandidate(data?.aiRecord || data);
                if (text && text.length > fullText.length) {
                  fullText = text;
                  aiContentDiv.textContent = fullText;
                }
                return;
              }

              // SSE-2: `final-result` is the server-normalized definitive
              // result from 1min.ai. The server buffers the upstream
              // `event: result` and sends it as `event: final-result`
              // after all content deltas. Adopt it unconditionally.
              if (currentEvent === 'final-result') {
                const text = findTextCandidate(data?.aiRecord || data);
                if (text) {
                  fullText = text;
                  aiContentDiv.textContent = fullText;
                }
                streamDone = true;
                return;
              }

              const content =
                data?.content ||
                data?.choices?.[0]?.delta?.content ||
                data?.choices?.[0]?.message?.content ||
                data?.message?.content ||
                data?.delta?.content ||
                data?.text ||
                findTextCandidate(data?.aiRecord || data);
              if (content) {
                followStreamScroll =
                  followStreamScroll &&
                  dom.chatLog.scrollTop + dom.chatLog.clientHeight >= dom.chatLog.scrollHeight - 120;
                fullText += content;
                scheduleRender();
              }

              const finishReason = data?.choices?.[0]?.finish_reason;
              if (finishReason && finishReason !== 'null') {
                streamDone = true;
              }
            } catch {
              // Ignore non-JSON SSE chunks
            }
          };

          while (!streamDone) {
            const { done, value } = await reader.read();
            if (done) {
              readerFinished = true;
              const tail = decoder.decode();
              if (tail) buffer += tail;
              if (buffer.trim()) {
                for (const line of buffer.split(/\r?\n/)) {
                  processSseLine(line);
                  if (streamDone) break;
                }
              }
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              processSseLine(line);
              if (streamDone) break;
            }
          }

          cancelPendingRender();
          if (streamError) throw streamError;
          if (fullText) renderMarkdownSafely(aiContentDiv, fullText);
          break;
        } catch (e) {
          cancelPendingRender();
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
          cancelPendingRender();
          if (streamTimeoutId) {
            clearTimeout(streamTimeoutId);
          }
          if (reader) {
            if (!readerFinished) {
              try {
                await reader.cancel();
              } catch {
                // ignore
              }
            }
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
      } else if (Array.isArray(state.chat.history)) {
        state.chat.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: fullText });
        if (state.chat.history.length > 40) {
          state.chat.history.splice(0, state.chat.history.length - 40);
        }
      }

      renderMarkdownSafely(aiContentDiv, fullText);
      aiMsgDiv.classList.remove('streaming');
      pruneChatLog();
    } catch (e) {
      aiMsgDiv.classList.remove('streaming');
      exitedWithError = true;
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
      aiMsgDiv.classList.remove('streaming');
      dom.chatLog.setAttribute('aria-busy', 'false');
      if (state.chat.abortController === abortController) {
        state.chat.abortController = null;
      }
      sendBtn.disabled = false;
      sendBtn.classList.remove('u-hidden');
      abortBtn.classList.remove('is-shown');
      if (!exitedWithError) {
        setStatus(t('status_ready'));
      }

      const remaining = [];
      state.chat.attachments.forEach((att) => {
        if (att.assetKey && fullText && fullText !== t('chat_empty_response')) {
          // Sent attachments keep their rendered blob preview until pruned from #chatLog.
        } else {
          remaining.push(att);
        }
      });
      state.chat.attachments.length = 0;
      state.chat.attachments.push(...remaining);
      updateAttachmentPreview();
      updateSendButton();
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
