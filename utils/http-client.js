import { serverConfig } from '../config/server.js';
import logger from './logger.js';
import { sanitizeLogText, sanitizePayload } from './sanitize.js';
import { HttpError } from './errors.js';

export const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EAI_AGAIN',
]);

/**
 * Polyfill for environments without AbortSignal.any (Node 18.0-18.16).
 * Forwards whichever of the two source signals aborts first.
 * @param {AbortSignal | undefined} a
 * @param {AbortSignal | undefined} b
 * @returns {AbortSignal}
 */
export function createCombinedSignal(a, b) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) {
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
 * Fetch with timeout and caller cancellation support.
 * @param {string} url
 * @param {RequestInit & { isStreaming?: boolean }} [options]
 * @param {number} [timeoutMs]
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = serverConfig.apiTimeout) {
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
    const isTimeout = timeoutSignal.aborted || error?.name === 'TimeoutError' || error?.code === 23;
    if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR' || isTimeout) {
      if (callerSignal && callerSignal.aborted) {
        const err = new HttpError(499, 'Request aborted by client');
        err.name = 'AbortError';
        throw err;
      }
      throw new HttpError(408, `Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  }
}

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

function createClientAbortError() {
  const err = new HttpError(499, 'Request aborted by client');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  if (signal?.aborted) {
    return Promise.reject(createClientAbortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createClientAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
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

const PENDING_STATUSES = new Set(['PROCESSING', 'PENDING', 'QUEUED', 'IN_PROGRESS']);

export function isPendingStatusResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const status = data?.aiRecord?.status ?? data?.status ?? data?.aiRecordDetail?.status;
  if (!status) return false;
  return PENDING_STATUSES.has(String(status).toUpperCase());
}

export async function parseResponsePayloadWithInfo(response) {
  if (!response || typeof response.text !== 'function') {
    return { payload: {}, jsonParseError: null, rawText: '' };
  }
  let text;
  try {
    text = await response.text();
  } catch (err) {
    return { payload: {}, jsonParseError: err, rawText: '' };
  }
  if (!text) return { payload: {}, jsonParseError: null, rawText: '' };
  try {
    return { payload: JSON.parse(text), jsonParseError: null, rawText: text };
  } catch (err) {
    return { payload: { message: text }, jsonParseError: err, rawText: text };
  }
}

export async function parseResponsePayload(response) {
  const { payload } = await parseResponsePayloadWithInfo(response);
  return payload;
}

function retryAfterDelay(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000 + 1000, 60000);
  }

  const retryAt = Date.parse(trimmed);
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(retryAt - Date.now() + 1000, 1000), 60000);
  }
  return null;
}

/**
 * Creates a provider-isolated HTTP client with retry, timeout, and error normalization.
 * @param {object} config
 * @param {string} config.providerLabel - Label used in error messages (e.g. '1min.ai', '1forall.ai')
 * @param {() => string} config.getBaseUrl
 * @param {() => Record<string, string>} config.getAuthHeaders
 * @param {Set<string>} [config.quietParseErrorPaths]
 */
export function createHttpClient({
  providerLabel,
  getBaseUrl,
  getAuthHeaders,
  quietParseErrorPaths = new Set(['/api/models']),
}) {
  /**
   * @param {string} pathname
   * @param {{
   *   method?: string,
   *   body?: any,
   *   headers?: Record<string, string>,
   *   raw?: boolean,
   *   signal?: AbortSignal,
   *   idempotent?: boolean,
   *   timeout?: number,
   *   suppressJsonParseErrorLog?: boolean,
   * }} [options]
   */
  return async function callUpstream(
    pathname,
    {
      method = 'POST',
      body,
      headers = {},
      raw = false,
      signal,
      idempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()),
      timeout,
      suppressJsonParseErrorLog = quietParseErrorPaths.has(pathname),
    } = {},
  ) {
    const authHeaders = getAuthHeaders();
    const { apiRetryAttempts: maxRetries, apiRetryDelay: retryDelay } = serverConfig;
    const effectiveRetries = idempotent ? maxRetries : 0;

    const baseHeaders = { ...authHeaders };
    for (const k of Object.keys(headers)) {
      baseHeaders[k] = headers[k];
    }

    const baseUrl = getBaseUrl().replace(/\/$/, '');
    const makeRequest = () =>
      fetchWithTimeout(
        `${baseUrl}${pathname}`,
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
    let scheduledRetryDelay = null;

    const exponentialRetryDelay = (attempt) =>
      Math.round(retryDelay * Math.pow(2, attempt) * (1 + (Math.random() * 0.2 - 0.1)));

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      try {
        if (attempt > 0) {
          const waitTime = scheduledRetryDelay ?? exponentialRetryDelay(attempt - 1);
          scheduledRetryDelay = null;
          logger.warn(`Retry ${attempt}/${effectiveRetries} for ${pathname} after ${waitTime}ms`);
          await delay(waitTime, signal);
        }

        const response = await makeRequest();

        if ((response.status === 429 || response.status >= 500) && attempt < effectiveRetries) {
          const retryAfter = response.headers?.get?.('Retry-After');
          const waitTime = retryAfterDelay(retryAfter) ?? exponentialRetryDelay(attempt);
          try {
            await response.body?.cancel?.();
          } catch {
            /* ignore */
          }
          scheduledRetryDelay = waitTime;
          logger.warn(
            `Upstream transient error (${response.status}) on ${pathname}. Retrying attempt ${attempt + 1}/${effectiveRetries} in ${waitTime}ms...`,
          );
          continue;
        }

        if (!response.ok) {
          const { payload, jsonParseError, rawText } = await parseResponsePayloadWithInfo(response);
          if (
            jsonParseError &&
            rawText &&
            !suppressJsonParseErrorLog &&
            !quietParseErrorPaths.has(pathname)
          ) {
            logger.error(
              `Failed to parse JSON error response from upstream API (${pathname}). Raw response: ${sanitizeLogText(rawText)}`,
              {
                error: jsonParseError.message,
                status: response.status,
              },
            );
          }
          throw new HttpError(
            response.status,
            `${providerLabel} request failed: ${response.status}`,
            'UPSTREAM_API_ERROR',
            sanitizePayload(payload),
          );
        }

        if (raw) return response;
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            return await response.json();
          } catch {
            throw new HttpError(
              502,
              `${providerLabel} returned invalid JSON response`,
              'UPSTREAM_INVALID_JSON',
            );
          }
        }
        return { text: await response.text() };
      } catch (error) {
        lastError = error;
        const err = /** @type {any} */ (lastError);
        if (err && typeof err === 'object' && !err.status && err.name !== 'AbortError') {
          safeDefineProperty(err, 'status', 502);
          safeDefineProperty(err, 'code', 'UPSTREAM_NETWORK_ERROR');
        }
        if (error?.code === 'UPSTREAM_INVALID_JSON') throw error;
        const isRetryableNetworkError = error?.code && RETRYABLE_NETWORK_CODES.has(error.code);
        const isNonRetryableHttpError =
          error?.status && error.status >= 400 && error.status < 500 && error.status !== 429;
        if (isNonRetryableHttpError && !isRetryableNetworkError) throw error;
        if (attempt < effectiveRetries) {
          scheduledRetryDelay = exponentialRetryDelay(attempt);
          const errorMessage = sanitizeLogText(error?.message || String(error));
          logger.warn(
            `Request failed for ${pathname}, will retry after ${scheduledRetryDelay}ms: ${errorMessage}`,
          );
        }
      }
    }

    throw lastError;
  };
}
