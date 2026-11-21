import { serverConfig } from '../../config/server.js';
import { hasApiKey } from '../../services/key-store.js';
import { HttpError } from '../../utils/errors.js';
import { translateErrorMessage, parseResponsePayload } from '../../utils/http-client.js';
import logger from '../../utils/logger.js';
import { buildSyntheticSseBody } from '../../utils/sse.js';
import { callOneForAll } from './client.js';

export const ONE_FOR_ALL_CAPABILITIES = Object.freeze({
  webSearch: false,
  memories: false,
  serverConversations: false,
  chatAttachments: false,
  imageGeneration: true,
  imageEdit: true,
  videoGeneration: true,
  imageToVideo: true,
  asyncJobs: true,
  maxImagesPerRequest: 4,
});

/** @type {Map<string, { minMaxTokens?: number, defaultMaxTokens?: number }>} */
const modelTokenLimits = new Map();

export function registerOneForAllModelLimits(models) {
  if (!Array.isArray(models)) return;
  for (const m of models) {
    if (!m?.id) continue;
    const min = Number(m?.meta?.minMaxTokens ?? m?.min_max_tokens);
    const def = Number(m?.meta?.defaultMaxTokens ?? m?.default_max_tokens);
    if (Number.isFinite(min) || Number.isFinite(def)) {
      modelTokenLimits.set(m.id, {
        minMaxTokens: Number.isFinite(min) ? min : undefined,
        defaultMaxTokens: Number.isFinite(def) ? def : undefined,
      });
    }
  }
}

/**
 * Generates a short title (<= 100 chars) required by 1forall native image/video endpoints.
 */
export function buildOneForAllTitle(prompt, fallback = 'AI Generation') {
  if (typeof prompt !== 'string') return fallback;
  const firstLine = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  // eslint-disable-next-line no-control-regex
  const clean = firstLine.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return clean ? clean.slice(0, 80) : fallback;
}

/**
 * Resolves `max_tokens` for 1forall text calls, honoring task defaults (cost control)
 * and ensuring the value never drops below the model's `min_max_tokens`.
 */
export function resolveOneForAllMaxTokens({ task = 'chat', requestedMaxTokens, model }) {
  let base;
  if (Number.isFinite(Number(requestedMaxTokens)) && Number(requestedMaxTokens) > 0) {
    base = Math.floor(Number(requestedMaxTokens));
  } else if (task === 'autocomplete') {
    base = serverConfig.oneForAllMaxTokensAutocomplete;
  } else if (task === 'inline') {
    base = serverConfig.oneForAllMaxTokensInline;
  } else {
    base = serverConfig.oneForAllMaxTokensChat;
  }

  const limits = model ? modelTokenLimits.get(model) : undefined;
  const minTokens = limits?.minMaxTokens ?? 1;
  return Math.max(base, minTokens);
}

function normalizeOpenAiMessages({ prompt, messages, systemPrompt }) {
  const allowedRoles = new Set(['system', 'user', 'assistant']);
  /** @type {Array<{role: string, content: string}>} */
  const out = [];

  if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt });
  }

  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      const rawRole = String(m?.role || 'user').toLowerCase();
      const role = allowedRoles.has(rawRole) ? rawRole : 'user';
      const content = typeof m?.content === 'string' ? m.content : String(m?.content ?? '');
      if (content.trim()) {
        out.push({ role, content });
      }
    }
  } else if (prompt && typeof prompt === 'string') {
    out.push({ role: 'user', content: prompt });
  }

  return out;
}

function aspectRatioToSize(aspectRatio) {
  const map = {
    '1:1': '1024x1024',
    '16:9': '1792x1024',
    '9:16': '1024x1792',
    '4:3': '1280x1024',
    '3:4': '1024x1280',
  };
  return map[aspectRatio] || '1024x1024';
}

function extractOpenAiErrorDetail(payload, fallbackStatus) {
  const msg =
    payload?.error?.message ||
    (typeof payload?.error === 'string' ? payload.error : null) ||
    payload?.detail ||
    payload?.message ||
    `1forall.ai API error: ${fallbackStatus}`;
  return translateErrorMessage(String(msg));
}

function isNonStreamingModelError(status, payload) {
  if (status !== 400) return false;
  const param = String(payload?.error?.param || '').toLowerCase();
  const msg = String(payload?.error?.message || payload?.detail || '').toLowerCase();
  return param === 'model' || msg.includes('stream');
}

export function normalizeOneForAllJobStatus(data, codeRef, kind = 'image') {
  const rawStatus = String(data?.status || '').toLowerCase();
  if (rawStatus === 'failed' || rawStatus === 'error' || rawStatus === 'failure') {
    const errText = translateErrorMessage(String(data?.error || '1forall.ai job failed'));
    return {
      status: 'failed',
      jobId: codeRef,
      provider: '1forall',
      kind,
      urls: [],
      error: errText,
      raw: data,
    };
  }

  if (rawStatus === 'completed' || rawStatus === 'success') {
    const url = data?.url_file || data?.response || '';
    const urls = url ? [url] : [];
    return {
      status: 'completed',
      jobId: codeRef,
      provider: '1forall',
      kind,
      urls,
      url_file: data?.url_file || null,
      response: data?.response || null,
      aiRecord: {
        uuid: codeRef,
        status: 'SUCCESS',
        temporaryUrl: data?.url_file || null,
        aiRecordDetail: {
          resultObject: urls,
        },
      },
      raw: data,
    };
  }

  return {
    status: 'pending',
    jobId: codeRef,
    provider: '1forall',
    kind,
    urls: [],
    aiRecord: {
      uuid: codeRef,
      status: 'PROCESSING',
      aiRecordDetail: { resultObject: [] },
    },
    raw: data,
  };
}

export const oneForAllProvider = {
  id: '1forall',
  label: '1forall.ai',
  capabilities: ONE_FOR_ALL_CAPABILITIES,

  isConfigured() {
    return hasApiKey('1forall');
  },

  /**
   * @param {{
   *   prompt?: string,
   *   messages?: any[],
   *   model?: string,
   *   systemPrompt?: string,
   *   maxTokens?: number,
   *   task?: string,
   *   signal?: AbortSignal,
   *   timeout?: number,
   * }} params
   */
  async chat({ prompt, messages, model, systemPrompt, maxTokens, task = 'chat', signal, timeout }) {
    const selectedModel = model || serverConfig.defaultChatModel1ForAll;
    const normalizedMessages = normalizeOpenAiMessages({ prompt, messages, systemPrompt });
    const effectiveMaxTokens = resolveOneForAllMaxTokens({
      task,
      requestedMaxTokens: maxTokens,
      model: selectedModel,
    });

    const data = await callOneForAll('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: normalizedMessages,
        max_tokens: effectiveMaxTokens,
        stream: false,
      }),
      idempotent: false,
      signal,
      timeout,
    });

    const text = data?.choices?.[0]?.message?.content ?? '';
    return {
      text,
      result: text,
      choices: data?.choices,
      usage: data?.usage,
      aiRecord: {
        status: 'SUCCESS',
        model: selectedModel,
        aiRecordDetail: {
          resultObject: [text],
        },
      },
      raw: data,
    };
  },

  /**
   * Starts a streaming chat completion against /v1/chat/completions.
   * If 1forall rejects streaming for the selected model with HTTP 400 (param: "model"),
   * automatically retries once with `stream: false` and emits a synthetic SSE response.
   */
  /**
   * @param {{
   *   prompt?: string,
   *   messages?: any[],
   *   model?: string,
   *   systemPrompt?: string,
   *   maxTokens?: number,
   *   signal?: AbortSignal,
   * }} params
   */
  async openChatStream({ prompt, messages, model, systemPrompt, maxTokens, signal }) {
    const selectedModel = model || serverConfig.defaultChatModel1ForAll;
    const normalizedMessages = normalizeOpenAiMessages({ prompt, messages, systemPrompt });
    const effectiveMaxTokens = resolveOneForAllMaxTokens({
      task: 'chat',
      requestedMaxTokens: maxTokens,
      model: selectedModel,
    });

    const response = await callOneForAll('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        messages: normalizedMessages,
        max_tokens: effectiveMaxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      raw: true,
      idempotent: false,
      signal,
      timeout: serverConfig.apiStreamTimeoutMs,
    }).catch(async (err) => {
      // callOneForAll throws HttpError on non-2xx when !raw? Actually when raw:true,
      // http-client throws HttpError on !response.ok too, with sanitized payload!
      // Intercept 400 model-does-not-support-streaming here to fall back cleanly.
      if (isNonStreamingModelError(err?.status, err?.payload)) {
        logger.info('1forall model does not support streaming; falling back to non-streaming call', {
          model: selectedModel,
        });
        const syncResult = await oneForAllProvider.chat({
          prompt,
          messages,
          model: selectedModel,
          systemPrompt,
          maxTokens: effectiveMaxTokens,
          task: 'chat',
          signal,
        });
        const sseBody = buildSyntheticSseBody(syncResult.text, {
          model: selectedModel,
          usage: syncResult.usage,
        });
        return new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        });
      }
      throw err;
    });

    if (!response.ok) {
      const errPayload = await parseResponsePayload(response);
      if (isNonStreamingModelError(response.status, errPayload)) {
        logger.info('1forall model rejected streaming response; retrying non-stream', {
          model: selectedModel,
        });
        const syncResult = await oneForAllProvider.chat({
          prompt,
          messages,
          model: selectedModel,
          systemPrompt,
          maxTokens: effectiveMaxTokens,
          task: 'chat',
          signal,
        });
        const sseBody = buildSyntheticSseBody(syncResult.text, {
          model: selectedModel,
          usage: syncResult.usage,
        });
        return {
          response: new Response(sseBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          }),
          format: '1min-sse',
        };
      }
      throw new HttpError(
        response.status,
        extractOpenAiErrorDetail(errPayload, response.status),
        'UPSTREAM_API_ERROR',
        errPayload,
      );
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('application/json')) {
      const json = await response.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      const sseBody = buildSyntheticSseBody(text, { model: selectedModel, usage: json?.usage });
      return {
        response: new Response(sseBody, {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
        format: '1min-sse',
      };
    }

    // Distinguish whether this came from our synthetic fallback (already 1min-sse) or OpenAI SSE.
    const isSyntheticFallback =
      response.headers?.get?.('content-type')?.includes('charset=utf-8') && !response.url;
    return {
      response,
      format: isSyntheticFallback ? '1min-sse' : 'openai-sse',
    };
  },

  /**
   * @param {{
   *   prompt?: string,
   *   messages?: any[],
   *   model?: string,
   *   webSearch?: boolean,
   *   parsedNumOfSite?: number,
   *   parsedMaxWord?: number,
   *   maxTokens?: number,
   *   useOpenAiCompat?: boolean,
   *   task?: string,
   *   context?: string,
   *   signal?: AbortSignal,
   *   timeout?: number,
   * }} params
   */
  async codeComplete({ prompt, messages, model, task = 'inline', maxTokens, signal, timeout }) {
    const selectedModel = model || serverConfig.defaultCodeModel1ForAll;
    const res = await this.chat({
      prompt,
      messages,
      model: selectedModel,
      task,
      maxTokens,
      signal,
      timeout,
    });
    return {
      result: res.text,
      text: res.text,
      usage: res.usage,
      raw: res.raw,
    };
  },

  async generateImage({
    prompt,
    model,
    num_outputs = 1,
    aspect_ratio = '1:1',
    size,
    output_format = 'png',
    async: useAsync = false,
  }) {
    const selectedModel = model || serverConfig.defaultImageModel1ForAll;
    if (useAsync) {
      const data = await callOneForAll('/v1/external/image/text-to-image/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: buildOneForAllTitle(prompt, 'Generated Image'),
          text: String(prompt).slice(0, 5000),
          model: selectedModel,
          size: aspect_ratio || '1:1',
          additional_fields: { output_format },
        }),
        idempotent: false,
      });

      const codeRef = data?.code_ref || String(data?.id || '');
      const normalized = normalizeOneForAllJobStatus(data, codeRef, 'image');
      return {
        status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
        jobId: codeRef,
        code_ref: codeRef,
        provider: '1forall',
        kind: 'image',
        urls: normalized.urls,
        aiRecord: {
          uuid: codeRef,
          status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
          model: selectedModel,
          temporaryUrl: normalized.url_file || null,
          aiRecordDetail: { resultObject: normalized.urls },
        },
        raw: data,
      };
    }

    const n = Math.min(Math.max(Math.round(Number(num_outputs) || 1), 1), 4);
    const data = await callOneForAll('/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        prompt: String(prompt).slice(0, 5000),
        n,
        size: size || aspectRatioToSize(aspect_ratio),
        response_format: 'url',
      }),
      idempotent: false,
    });

    const urls = Array.isArray(data?.data)
      ? data.data
          .map((d) => d?.url || (d?.b64_json ? `data:image/png;base64,${d.b64_json}` : null))
          .filter(Boolean)
      : [];

    return {
      status: 'SUCCESS',
      provider: '1forall',
      urls,
      aiRecord: {
        status: 'SUCCESS',
        model: selectedModel,
        aiRecordDetail: { resultObject: urls },
      },
      data: data?.data,
      raw: data,
    };
  },

  async editImage({ imageUrl, prompt, model, additionalFields = {} }) {
    const selectedModel = model || serverConfig.defaultImageEditorModel1ForAll;
    const data = await callOneForAll('/v1/external/image/image-to-image/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: buildOneForAllTitle(prompt, 'Edited Image'),
        text: String(prompt).slice(0, 5000),
        model: selectedModel,
        file_reference: imageUrl,
        additional_fields: additionalFields,
      }),
      idempotent: false,
    });

    const codeRef = data?.code_ref || String(data?.id || '');
    const normalized = normalizeOneForAllJobStatus(data, codeRef, 'image');
    return {
      status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
      jobId: codeRef,
      code_ref: codeRef,
      provider: '1forall',
      kind: 'image',
      urls: normalized.urls,
      aiRecord: {
        uuid: codeRef,
        status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
        model: selectedModel,
        temporaryUrl: normalized.url_file || null,
        aiRecordDetail: { resultObject: normalized.urls },
      },
      raw: data,
    };
  },

  /**
   * @param {{
   *   model?: string,
   *   prompt?: string,
   *   imageUrl?: string,
   *   aspect_ratio?: string,
   *   duration?: number,
   *   resolution?: string,
   *   audio?: boolean,
   *   negativePrompt?: string,
   *   mode?: string,
   *   version?: string,
   *   speed?: number,
   *   additionalFields?: Record<string, any>,
   * }} params
   */
  async generateVideo({ prompt = '', model, imageUrl, aspect_ratio = '16:9', speed, additionalFields }) {
    const selectedModel = model || serverConfig.defaultVideoModel1ForAll;
    const body = {
      title: buildOneForAllTitle(prompt, 'Generated Video'),
      model: selectedModel,
      ...(prompt ? { text: String(prompt).slice(0, 5000) } : {}),
      ...(aspect_ratio ? { ratio: aspect_ratio } : {}),
      ...(imageUrl ? { source_image_path: imageUrl } : {}),
      ...(speed !== undefined ? { speed: Number(speed) } : {}),
      ...(additionalFields && Object.keys(additionalFields).length > 0
        ? { additional_fields: additionalFields }
        : {}),
    };

    const data = await callOneForAll('/v1/external/video/convert-to-video/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      idempotent: false,
    });

    const codeRef = data?.code_ref || String(data?.id || '');
    const normalized = normalizeOneForAllJobStatus(data, codeRef, 'video');
    return {
      status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
      jobId: codeRef,
      code_ref: codeRef,
      provider: '1forall',
      kind: 'video',
      urls: normalized.urls,
      aiRecord: {
        uuid: codeRef,
        status: normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING',
        model: selectedModel,
        temporaryUrl: normalized.url_file || null,
        aiRecordDetail: { resultObject: normalized.urls },
      },
      raw: data,
    };
  },

  async getJob(codeRef, kind = 'image') {
    const segment = kind === 'video' ? 'video' : kind === 'llm' ? 'llm' : 'image';
    const data = await callOneForAll(`/v1/external/${segment}/check-status/${encodeURIComponent(codeRef)}/`, {
      method: 'GET',
      idempotent: true,
    });
    return normalizeOneForAllJobStatus(data, codeRef, kind);
  },

  async uploadAsset({ blob, filename }) {
    const fieldName = process.env.ONE_FOR_ALL_UPLOAD_FIELD || 'file';
    const safeFilename = String(filename || 'upload.png');
    const extMatch = safeFilename.match(/\.(jpe?g|png)$/i);
    const mimeIsJpeg =
      String(blob?.type || '')
        .toLowerCase()
        .includes('jpeg') ||
      String(blob?.type || '')
        .toLowerCase()
        .includes('jpg');
    const format = extMatch
      ? extMatch[1].toLowerCase().startsWith('jp')
        ? 'jpeg'
        : 'png'
      : mimeIsJpeg
        ? 'jpeg'
        : 'png';

    const formData = new FormData();
    formData.append('title', buildOneForAllTitle(safeFilename, 'Uploaded Image'));
    formData.append('format', format);
    formData.append(fieldName, blob, safeFilename);

    const data = await callOneForAll('/v1/external/image/upload/', {
      method: 'POST',
      body: formData,
      idempotent: false,
    });
    const url = data?.uploaded_image_url || data?.url_file || data?.source_image_path || '';
    return {
      key: url,
      url,
    };
  },
};
