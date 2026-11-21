import { serverConfig } from '../config/server.js';
import logger from './logger.js';
import { extractTextFromOneMinResponse } from './one-min-response.js';
import { sanitizeLogText } from './sanitize.js';
import { HttpError } from './errors.js';
import { getApiKey } from '../services/key-store.js';
import { createHttpClient, parseResponsePayloadWithInfo, parseResponsePayload } from './http-client.js';

export { parseResponsePayloadWithInfo, parseResponsePayload };

function requireApiKey() {
  const apiKey = getApiKey('1min');
  if (!apiKey) {
    throw new HttpError(
      500,
      'ONE_MIN_AI_API_KEY is not configured. Copy .env.example to .env and set your key.',
    );
  }
  return apiKey;
}

const oneMinHttpClient = createHttpClient({
  providerLabel: '1min.ai',
  getBaseUrl: () => serverConfig.apiBaseUrl,
  getAuthHeaders: () => {
    const apiKey = requireApiKey();
    // 1min.ai's documentation lists `API-KEY` for /api/* and `Authorization: Bearer`
    // at the top-level /openai/v1/* endpoints. Sending both keeps compatibility
    // unless caller overrides either header explicitly.
    return {
      'API-KEY': apiKey,
      Authorization: `Bearer ${apiKey}`,
    };
  },
  quietParseErrorPaths: new Set(['/api/models']),
});

/**
 * Normalizes a raw Response returned from callOneMin(..., { raw: true })
 * into the usual object shape consumed by the route handlers.
 */
export async function normalizeOneMinRawResponse(response, options = {}) {
  if (!response || typeof response.text !== 'function') {
    return response;
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const { payload, jsonParseError, rawText } = await parseResponsePayloadWithInfo(response);

  if (!jsonParseError && contentType.includes('application/json')) {
    return payload;
  }

  const text = rawText || payload?.message || payload?.text || '';
  if (!text) return payload;

  const sse = parseSseResponseText(text, options);
  if (sse) return sse;

  if (
    jsonParseError &&
    rawText &&
    (!response.ok || contentType.includes('application/json') || contentType.includes('html'))
  ) {
    const context = options.context || 'Code Generator';
    logger.error(
      `[${context}] Failed to parse JSON response from upstream API. Raw response: ${sanitizeLogText(rawText)}`,
      {
        error: jsonParseError.message,
        status: response.status,
        contentType,
      },
    );
  }

  return {
    ...payload,
    result: text,
    text,
  };
}

function parseSseResponseText(text, options = {}) {
  if (typeof text !== 'string' || !/^\s*(event:|data:)/m.test(text)) return null;

  const chunks = [];
  const resultPayloads = [];
  let currentEvent = 'content';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      currentEvent = 'content';
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim() || 'content';
      continue;
    }
    if (!line.startsWith('data:')) continue;

    const dataStr = line.replace(/^data:\s*/, '').trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    let data;
    try {
      data = JSON.parse(dataStr);
    } catch (err) {
      if (dataStr.startsWith('{') || dataStr.startsWith('[')) {
        const context = options.context || 'Code Generator';
        logger.error(`[${context}] Failed to parse SSE JSON chunk. Raw chunk: ${sanitizeLogText(dataStr)}`, {
          error: err.message,
        });
      }
      chunks.push(dataStr);
      continue;
    }

    if (currentEvent === 'error') {
      const streamError = data?.error ?? data?.message ?? 'Stream error';
      return { ...data, status: 'FAILED', error: streamError };
    }

    if (currentEvent === 'result' || currentEvent === 'final-result') {
      resultPayloads.push(data);
      continue;
    }

    const content =
      data?.content ||
      data?.choices?.[0]?.delta?.content ||
      data?.choices?.[0]?.message?.content ||
      data?.message?.content ||
      data?.delta?.content ||
      data?.text;
    if (content) chunks.push(content);
  }

  const resultPayload = resultPayloads.at(-1);
  if (resultPayload) {
    const extracted = extractTextFromOneMinResponse(resultPayload?.aiRecord || resultPayload);
    return {
      ...resultPayload,
      ...(extracted ? { result: extracted, text: extracted } : {}),
    };
  }

  if (chunks.length > 0) {
    const result = chunks.join('');
    return { result, text: result };
  }

  return null;
}

/**
 * Calls the 1min.ai API with retry logic for 429/5xx errors and timeout support.
 * @param {string} pathname
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {any} [options.body]
 * @param {Record<string, string>} [options.headers]
 * @param {boolean} [options.raw]
 * @param {AbortSignal} [options.signal]
 * @param {boolean} [options.idempotent]
 * @param {number} [options.timeout]
 * @param {boolean} [options.suppressJsonParseErrorLog]
 */
export async function callOneMin(pathname, options = {}) {
  return oneMinHttpClient(pathname, options);
}

/**
 * Extracts text content from a 1min.ai API response.
 */
export function extractText(data) {
  return extractTextFromOneMinResponse(data);
}

const PENDING_STATUSES = new Set(['PROCESSING', 'PENDING', 'QUEUED', 'IN_PROGRESS']);
const SUCCESS_STATUSES = new Set(['SUCCESS', 'COMPLETED']);

/**
 * Returns true if the response represents an in-flight asynchronous job.
 * @param {any} data
 * @returns {boolean}
 */
export function isPendingResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const status = data?.aiRecord?.status ?? data?.status ?? data?.aiRecordDetail?.status;
  if (!status) return false;
  return PENDING_STATUSES.has(String(status).toUpperCase());
}

/**
 * Returns true if the 1min.ai response indicates a logical failure
 * (e.g. status: "FAILED" or "FAILURE"). Async pending statuses ("PROCESSING")
 * are NOT treated as failures.
 */
export function isFailedResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const status = data?.aiRecord?.status ?? data?.status ?? data?.aiRecordDetail?.status;
  if (!status) {
    return Boolean(data?.error);
  }
  const upper = String(status).toUpperCase();
  return !SUCCESS_STATUSES.has(upper) && !PENDING_STATUSES.has(upper);
}

export function translateErrorMessage(msg) {
  if (typeof msg !== 'string') return msg;
  const lowerMsg = msg.toLowerCase();
  if (
    lowerMsg.includes('invalid_api_key') ||
    lowerMsg.includes('invalid api key') ||
    lowerMsg.includes('authentication_error') ||
    lowerMsg.includes('not a valid api key') ||
    lowerMsg.includes('revoked')
  ) {
    return 'APIキーが無効です。設定を確認してください。';
  }
  if (
    lowerMsg.includes('insufficient_quota') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('not enough credits') ||
    lowerMsg.includes('billing')
  ) {
    return 'クレジット残高またはAPIの利用可能枠が不足しています。';
  }
  if (lowerMsg.includes('content_policy_violation') || lowerMsg.includes('content filter')) {
    return 'コンテンツポリシーの制限によりリクエストが拒否されました。';
  }
  if (
    lowerMsg.includes('model not found') ||
    lowerMsg.includes('invalid_model') ||
    lowerMsg.includes('model not available')
  ) {
    return '指定されたモデルが存在しないか利用できません。';
  }
  return msg;
}

export function extractFailureMessage(data) {
  if (!data || typeof data !== 'object') return 'Upstream returned a failure status';
  const resultObject = data?.aiRecord?.aiRecordDetail?.resultObject ?? data?.aiRecordDetail?.resultObject;
  const resultObjectErrorMsg =
    resultObject && typeof resultObject === 'object' && !Array.isArray(resultObject)
      ? resultObject.message || resultObject.error
      : undefined;

  // M-14: Do NOT fall back to data.message — 1min.ai uses that field for
  // generic lifecycle messages like "Stream completed" even on success.
  const rawMsg =
    data?.aiRecord?.aiRecordDetail?.errorMessage ||
    data?.aiRecord?.errorMessage ||
    resultObjectErrorMsg ||
    data?.error?.message ||
    (typeof data?.error === 'string' ? data.error : undefined) ||
    data?.detail ||
    'Upstream returned a failure status';

  return translateErrorMessage(String(rawMsg));
}

/**
 * Normalizes common 1min.ai response shapes for frontend consumers.
 */
export function normalizeOneMinResponse(data) {
  const resultObject =
    data?.aiRecord?.aiRecordDetail?.resultObject ?? data?.aiRecord?.resultObject ?? data?.resultObject;

  return {
    text: extractTextFromOneMinResponse(data),
    resultObject,
    conversationId:
      data?.aiRecord?.conversationId ??
      data?.aiRecord?.aiRecordDetail?.conversationId ??
      data?.conversationId,
    uuid: data?.uuid ?? data?.aiRecord?.uuid,
    raw: data,
  };
}

/**
 * Normalizes asset API responses into a stable key/url shape.
 */
export function normalizeAssetResponse(data) {
  const asset = data?.asset || {};
  const key = asset.key || data?.fileContent?.path || data?.path || '';
  const location = asset.location || '';
  const url =
    location ||
    (key && !/^https?:\/\//.test(key) ? `${serverConfig.assetBaseUrl}/${key.replace(/^\//, '')}` : key);
  return { key, url, raw: data };
}
