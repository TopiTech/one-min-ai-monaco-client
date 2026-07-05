import { serverConfig } from '../config/server.js';
import logger from './logger.js';
import { extractTextFromOneMinResponse } from './one-min-response.js';
import { sanitizePayload } from './sanitize.js';

const API_BASE = serverConfig.apiBaseUrl;

function requireApiKey() {
  const apiKey = process.env.ONE_MIN_AI_API_KEY;
  if (!apiKey || apiKey.includes('your_1min_ai_api_key_here')) {
    const err = new Error(
      'ONE_MIN_AI_API_KEY is not configured. Copy .env.example to .env and set your key.',
    );
    err.status = 500;
    throw err;
  }
  return apiKey;
}

/**
 * Fetch with timeout support.
 *
 * Uses AbortSignal.any (Node 20.3+ / 18.17+) when available, falling back
 * to a manual AbortController that forwards whichever source aborts
 * (caller cancellation vs timeout). After either path we inspect which
 * signal fired to surface the correct error (499 client abort vs 408
 * timeout).
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = serverConfig.apiTimeout) {
  const { signal: callerSignal, ...fetchOpts } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any(callerSignal ? [callerSignal, timeoutSignal] : [timeoutSignal])
      : createCombinedSignal(callerSignal, timeoutSignal);

  try {
    const response = await fetch(url, { ...fetchOpts, signal: combinedSignal });
    return response;
  } catch (error) {
    if (error.name === 'AbortError' || error.code === 'ABORT_ERR') {
      if (callerSignal && callerSignal.aborted) {
        const err = new Error('Request aborted by client');
        err.name = 'AbortError';
        err.status = 499;
        throw err;
      }
      const err = new Error(`Request timeout after ${timeoutMs}ms`);
      err.status = 408;
      throw err;
    }
    throw error;
  }
}

/**
 * Polyfill for environments without AbortSignal.any (Node 18.0–18.16).
 * Forwards whichever of the two source signals aborts first.
 */
function createCombinedSignal(a, b) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) {
      // Use the original signal's reason when available (Node 18.17+).
      const reason = (a && a.aborted && a.reason) || (b && b.aborted && b.reason) || undefined;
      controller.abort(reason);
    }
  };
  if (a) {
    if (a.aborted) onAbort();
    else a.addEventListener('abort', onAbort, { once: true });
  }
  if (b) {
    if (b.aborted) onAbort();
    else b.addEventListener('abort', onAbort, { once: true });
  }
  return controller.signal;
}

/**
 * Safely assigns a property to an error object, handling frozen/sealed
 * errors gracefully. Falls back to Object.defineProperty if direct
 * assignment fails, and silently ignores if the error is sealed/frozen.
 */
function safeDefineProperty(obj, key, value) {
  try {
    obj[key] = value;
  } catch {
    try {
      Object.defineProperty(obj, key, { value, writable: true, configurable: true });
    } catch {
      // ignore if sealed/frozen
    }
  }
}

/**
 * Delay helper for retry logic
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function parseResponsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Normalizes a raw Response returned from callOneMin(..., { raw: true })
 * into the usual object shape consumed by the route handlers.
 *
 * - JSON responses are parsed as-is.
 * - Non-JSON responses are exposed via `result` and `text` so existing
 *   extractText()/isFailedResponse() consumers can continue working.
 */
export async function normalizeOneMinRawResponse(response) {
  if (!response || typeof response.text !== 'function') {
    return response;
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const payload = await parseResponsePayload(response);

  if (contentType.includes('application/json')) {
    return payload;
  }

  const text = payload?.message ?? payload?.text ?? '';
  if (!text) return payload;

  const sse = parseSseResponseText(text);
  if (sse) return sse;

  return {
    ...payload,
    result: text,
    text,
  };
}

function parseSseResponseText(text) {
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
    } catch {
      chunks.push(dataStr);
      continue;
    }

    if (currentEvent === 'error') {
      const streamError = data?.error ?? data?.message ?? 'Stream error';
      return { ...data, status: 'FAILED', error: streamError };
    }

    // SSE-2: The server normalizes upstream `result` to `final-result`.
    // Treat it identically to `result` — buffer for final extraction.
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
 * Calls the 1min.ai API with retry logic for 429 errors and timeout support.
 */
export async function callOneMin(
  pathname,
  {
    method = 'POST',
    body,
    headers = {},
    raw = false,
    signal,
    // M-1: When true, retry is disabled entirely because the upstream side
    // effect would be duplicated (e.g. POST /api/conversations, POST /api/assets).
    // Callers that mutate state on the upstream should pass `idempotent: false`.
    idempotent = method.toUpperCase() === 'GET',
    timeout,
  } = {},
) {
  const apiKey = requireApiKey();
  const { apiRetryAttempts: maxRetries, apiRetryDelay: retryDelay } = serverConfig;
  // Disable retries for non-idempotent calls so we never duplicate the side
  // effect (conversations, asset uploads) on transient network errors.
  const effectiveRetries = idempotent ? maxRetries : 0;

  // 1min.ai's documentation lists the `API-KEY` header for some endpoints
  // and `Authorization: Bearer <key>` at the top-level API intro. To remain
  // resilient against documentation drift, we send BOTH headers when the
  // caller does not explicitly provide either. The duplicated value is
  // identical, so any proxy that inspects both will see the same auth.
  const baseHeaders = {
    'API-KEY': apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
  // Caller-provided headers take precedence over our defaults so that
  // tests and other internal callers can override the auth surface
  // (e.g. for staging environments or mock servers).
  for (const k of Object.keys(headers)) {
    baseHeaders[k] = headers[k];
  }

  const makeRequest = () =>
    fetchWithTimeout(
      `${API_BASE}${pathname}`,
      {
        method,
        headers: baseHeaders,
        body,
        signal,
        isStreaming: raw,
      },
      timeout,
    );

  let lastError = new Error(`All ${effectiveRetries + 1} retry attempts failed for ${pathname}`);

  for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
    try {
      if (attempt > 0) {
        const jitter = 1 + (Math.random() * 0.2 - 0.1);
        const waitTime = Math.round(retryDelay * Math.pow(2, attempt - 1) * jitter);
        logger.warn(`Retry ${attempt}/${effectiveRetries} for ${pathname} after ${waitTime}ms`);
        await delay(waitTime);
      }

      const response = await makeRequest();

      if (response.status === 429 && attempt < effectiveRetries) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000 + 1000, 60000)
          : Math.round(retryDelay * Math.pow(2, attempt) * (1 + (Math.random() * 0.2 - 0.1)));
        // Consume the response body to release the connection back to the pool.
        // Without this, the HTTP connection stays open and may leak.
        try {
          response.body?.cancel?.();
        } catch {
          /* ignore */
        }
        logger.warn(`Rate limited (429) on ${pathname}. Retrying in ${waitTime}ms...`);
        await delay(waitTime);
        continue;
      }

      if (!response.ok) {
        const payload = await parseResponsePayload(response);
        const err = new Error(`1min.ai request failed: ${response.status}`);
        err.status = response.status;
        err.payload = sanitizePayload(payload);
        throw err;
      }

      if (raw) return response;
      const contentType = response.headers.get('content-type') || '';
      return contentType.includes('application/json') ? response.json() : { text: await response.text() };
    } catch (error) {
      lastError = error;
      if (
        lastError &&
        typeof lastError === 'object' &&
        !lastError.status &&
        lastError.name !== 'AbortError'
      ) {
        safeDefineProperty(lastError, 'status', 502);
        safeDefineProperty(lastError, 'code', 'UPSTREAM_NETWORK_ERROR');
      }
      // Classify errors by error.code for better retry decisions:
      // - Retryable network errors: ECONNRESET, ECONNREFUSED, ENOTFOUND, ETIMEDOUT, EPIPE
      // - Non-retryable client errors: 4xx (except 429)
      const retryableNetworkCodes = new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'EPIPE',
        'ENETUNREACH',
        'EAI_AGAIN',
      ]);
      const isRetryableNetworkError = error?.code && retryableNetworkCodes.has(error.code);
      const isNonRetryableHttpError =
        error?.status && error.status >= 400 && error.status < 500 && error.status !== 429;
      if (isNonRetryableHttpError && !isRetryableNetworkError) throw error;
      if (attempt < effectiveRetries)
        logger.warn(`Request failed for ${pathname}, will retry: ${error.message}`);
    }
  }

  throw lastError;
}

/**
 * Extracts text content from a 1min.ai API response.
 */
export function extractText(data) {
  return extractTextFromOneMinResponse(data);
}

/**
 * Returns true if the 1min.ai response indicates a logical failure
 * (e.g. status: "FAILED"). The upstream may still return 200 OK with
 * a payload describing the failure.
 */
export function isFailedResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const status = data?.aiRecord?.status ?? data?.status ?? data?.aiRecordDetail?.status;
  if (!status) return false;
  return String(status).toUpperCase() !== 'SUCCESS' && String(status).toUpperCase() !== 'COMPLETED';
}

function translateErrorMessage(msg) {
  if (typeof msg !== 'string') return msg;
  const lowerMsg = msg.toLowerCase();
  if (lowerMsg.includes('invalid_api_key') || lowerMsg.includes('invalid api key')) {
    return 'APIキーが無効です。設定を確認してください。';
  }
  if (
    lowerMsg.includes('insufficient_quota') ||
    lowerMsg.includes('quota exceeded') ||
    lowerMsg.includes('billing')
  ) {
    return 'クレジット残高またはAPIの利用可能枠が不足しています。';
  }
  if (lowerMsg.includes('model not found') || lowerMsg.includes('invalid_model')) {
    return '指定されたモデルが存在しません。';
  }
  return msg;
}

export function extractFailureMessage(data) {
  if (!data || typeof data !== 'object') return 'Upstream returned a failure status';
  // M-14: Do NOT fall back to data.message — 1min.ai uses that field for
  // generic lifecycle messages like "Stream completed" even on success,
  // which would otherwise be surfaced as a misleading failure reason.
  const rawMsg =
    data?.aiRecord?.aiRecordDetail?.errorMessage ||
    data?.aiRecord?.errorMessage ||
    data?.error?.message ||
    data?.error ||
    'Upstream returned a failure status';

  return translateErrorMessage(rawMsg);
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
 *
 * - `key`: the 1min.ai asset key (e.g. "images/2024_...") used in
 *   subsequent API calls such as attachments.images.
 * - `url`: the full HTTPS URL to access the uploaded file. We prefer
 *   `asset.location` (the S3 URL returned by 1min.ai) because the
 *   synthetic `https://asset.1min.ai/...` domain is not guaranteed to
 *   resolve.
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
