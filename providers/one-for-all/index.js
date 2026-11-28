import { serverConfig } from '../../config/server.js';
import { hasApiKey } from '../../services/key-store.js';
import { HttpError } from '../../utils/errors.js';
import { translateErrorMessage, parseResponsePayload } from '../../utils/http-client.js';
import logger from '../../utils/logger.js';
import { buildSyntheticSseBody } from '../../utils/sse.js';
import { callOneForAll } from './client.js';
import {
  buildOneForAllImageToImageBody,
  buildOneForAllTextToImageBody,
  buildOneForAllTitle,
  ensureOneForAllFileReference,
  normalizeOneForAllOutputs,
  ONE_FOR_ALL_SYNC_MAX_IMAGES,
  toOpenAiPixelSize,
  pickOneForAllSize,
  uploadImageToLibrary,
} from './images.js';
import { registerOneForAllModelLimits, resolveOneForAllMaxTokens } from './models.js';

export { buildOneForAllTitle, registerOneForAllModelLimits, resolveOneForAllMaxTokens };

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

/** Shallow merge that drops undefined values so defaults are not overwritten. */
function mergeDefined(base, overrides = {}) {
  const merged = {};
  for (const [key, value] of Object.entries({ ...base, ...overrides })) {
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  return merged;
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
  }
  if (!out.some((m) => m.role !== 'system') && prompt && typeof prompt === 'string' && prompt.trim()) {
    out.push({ role: 'user', content: prompt });
  }

  return out;
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
  return param === 'stream' || msg.includes('stream');
}

function buildOneForAllSubmitResponse(data, selectedModel, kind) {
  const codeRef = data?.code_ref || String(data?.id || '');
  const normalized = normalizeOneForAllJobStatus(data, codeRef, kind);
  if (normalized.status === 'failed') {
    throw new HttpError(502, normalized.error || `1forall.ai ${kind} job failed`, 'UPSTREAM_API_ERROR', data);
  }
  const jobStatus = normalized.status === 'completed' ? 'SUCCESS' : 'PROCESSING';
  return {
    status: jobStatus,
    jobId: codeRef,
    code_ref: codeRef,
    provider: '1forall',
    kind,
    urls: normalized.urls,
    aiRecord: {
      uuid: codeRef,
      status: jobStatus,
      model: selectedModel,
      temporaryUrl: normalized.url_file || null,
      aiRecordDetail: { resultObject: normalized.urls },
    },
    raw: data,
  };
}

const ONE_FOR_ALL_FAILED_STATUSES = new Set([
  'failed',
  'error',
  'failure',
  'cancelled',
  'canceled',
  'expired',
  'timeout',
  'timed_out',
  'aborted',
]);

export function normalizeOneForAllJobStatus(data, codeRef, kind = 'image') {
  const rawStatus = String(data?.status || '').toLowerCase();
  if (rawStatus === 'completed' || rawStatus === 'success') {
    const urls = normalizeOneForAllOutputs(data);
    if (urls.length === 0 && typeof data?.response === 'string' && data.response) {
      urls.push(data.response);
    }
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

  if (ONE_FOR_ALL_FAILED_STATUSES.has(rawStatus) || Boolean(data?.error)) {
    const errText = translateErrorMessage(
      String(data?.error || (rawStatus ? `1forall.ai job ${rawStatus}` : '1forall.ai job failed')),
    );
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

    const runNonStreamFallback = async (reasonMsg) => {
      logger.info(reasonMsg, { model: selectedModel });
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
    };

    let response;
    try {
      response = await callOneForAll('/v1/chat/completions', {
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
      });
    } catch (err) {
      // callOneForAll throws HttpError on non-2xx even when raw: true.
      // Intercept 400 model-does-not-support-streaming here to fall back cleanly.
      if (isNonStreamingModelError(err?.status, err?.payload)) {
        return await runNonStreamFallback(
          '1forall model does not support streaming; falling back to non-streaming call',
        );
      }
      throw err;
    }

    if (!response.ok) {
      const errPayload = await parseResponsePayload(response);
      if (isNonStreamingModelError(response.status, errPayload)) {
        return await runNonStreamFallback('1forall model rejected streaming response; retrying non-stream');
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

    return {
      response,
      format: 'openai-sse',
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

  /**
   * Generates an image either through the asynchronous native endpoint
   * (`text-to-image` + `check-status`) or the synchronous OpenAI-compatible
   * endpoint, depending on `async`.
   *
   * `entry` is the catalog entry for `model` (config/models.js); it carries the
   * model's `sizes` and `additional_fields`, so per-model parameters are
   * validated against what 1forall actually accepts.
   *
   * @param {{
   *   prompt: string,
   *   model?: string,
   *   entry?: object|null,
   *   params?: Record<string, any>,
   *   extra?: Record<string, any>,
   *   async?: boolean,
   *   signal?: AbortSignal,
   *   num_outputs?: number,
   *   aspect_ratio?: string,
   *   size?: string,
   *   output_format?: string,
   * }} options
   */
  async generateImage({
    prompt,
    model,
    entry = null,
    params = {},
    extra = {},
    async: useAsync = false,
    signal,
    // Legacy top-level equivalents, kept for callers written before `params`.
    num_outputs,
    aspect_ratio,
    size,
    output_format,
  }) {
    const selectedModel = model || serverConfig.defaultImageModel1ForAll;
    const effectiveParams = mergeDefined(
      { num_outputs, aspect_ratio, size, output_format },
      params,
    );
    if (useAsync) {
      const body = buildOneForAllTextToImageBody({
        entry,
        model: selectedModel,
        prompt,
        params: effectiveParams,
        extra,
      });
      const data = await callOneForAll('/v1/external/image/text-to-image/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        idempotent: false,
        signal,
      });

      return buildOneForAllSubmitResponse(data, selectedModel, 'image');
    }

    const requested = Number(effectiveParams.num_outputs ?? effectiveParams.n ?? 1);
    const n = Math.min(
      Math.max(Number.isFinite(requested) ? Math.round(requested) : 1, 1),
      ONE_FOR_ALL_SYNC_MAX_IMAGES,
    );
    // The sync endpoint only takes a pixel size; map the catalog ratio to one.
    const selectedSize = entry
      ? toOpenAiPixelSize(
          pickOneForAllSize(entry, {
            size: effectiveParams.size,
            aspectRatio: effectiveParams.aspect_ratio,
          }),
        )
      : toOpenAiPixelSize(effectiveParams.size || effectiveParams.aspect_ratio);

    const data = await callOneForAll('/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selectedModel,
        prompt: String(prompt).slice(0, 5000),
        n,
        size: selectedSize,
        response_format: 'url',
      }),
      idempotent: false,
      signal,
    });

    const urls = Array.isArray(data?.data)
      ? data.data
          .map((item) => item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null))
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

  /**
   * Edits an image through the native `image-to-image` endpoint. The source is
   * uploaded to the 1forall library first when it is not already a library URL,
   * because `file_reference` only accepts those.
   *
   * @param {{
   *   imageUrl: string,
   *   prompt: string,
   *   model?: string,
   *   entry?: object|null,
   *   params?: Record<string, any>,
   *   extra?: Record<string, any>,
   *   additionalFields?: Record<string, any>,
   *   signal?: AbortSignal,
   * }} options
   */
  async editImage({
    imageUrl,
    prompt,
    model,
    entry = null,
    params = {},
    extra = {},
    additionalFields,
    signal,
  }) {
    const selectedModel = model || serverConfig.defaultImageEditorModel1ForAll;
    const fileReference = await ensureOneForAllFileReference(imageUrl, {
      title: buildOneForAllTitle(prompt, 'Edited Image'),
      signal,
    });
    const body = buildOneForAllImageToImageBody({
      entry,
      model: selectedModel,
      prompt,
      fileReference,
      params,
      extra: mergeDefined(extra, additionalFields),
    });
    const data = await callOneForAll('/v1/external/image/image-to-image/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      idempotent: false,
      signal,
    });

    return buildOneForAllSubmitResponse(data, selectedModel, 'image');
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
   *   signal?: AbortSignal,
   * }} params
   */
  async generateVideo({
    prompt = '',
    model,
    imageUrl,
    aspect_ratio = '16:9',
    speed,
    additionalFields,
    signal,
  }) {
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
      signal,
    });

    return buildOneForAllSubmitResponse(data, selectedModel, 'video');
  },

  /**
   * @param {string} codeRef
   * @param {string} [kind='image']
   * @param {{ signal?: AbortSignal }} [options]
   */
  async getJob(codeRef, kind = 'image', { signal } = {}) {
    const segment = kind === 'video' ? 'video' : kind === 'llm' ? 'llm' : 'image';
    const data = await callOneForAll(`/v1/external/${segment}/check-status/${encodeURIComponent(codeRef)}/`, {
      method: 'GET',
      idempotent: true,
      signal,
    });
    return normalizeOneForAllJobStatus(data, codeRef, kind);
  },

  async uploadAsset({ blob, filename }) {
    const safeFilename = String(filename || 'upload.png');
    const url = await uploadImageToLibrary(blob, {
      title: buildOneForAllTitle(safeFilename, 'Uploaded Image'),
      filename: safeFilename,
    });
    return {
      key: url,
      url,
    };
  },
};
