import { t } from './i18n.js';

const statusEl = document.getElementById('status');
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function setStatus(text, cls = '') {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
  }
}

let _activeRequests = 0;

async function api(path, options = {}) {
  _activeRequests++;
  setStatus(t('status_communicating'), 'warn');

  const {
    timeout = DEFAULT_REQUEST_TIMEOUT_MS,
    signal: callerSignal,
    raw = false,
    headers: optionHeaders,
    ...fetchOptions
  } = options;
  const requestSignal = createRequestSignal({ timeout, callerSignal });

  let outcome = 'ok';
  let keepCallerAbortForRawResponse = false;
  try {
    const headers = { ...optionHeaders };
    const csrfToken = getCookie('__bff_csrf');
    if (csrfToken) {
      headers['x-local-bff-token'] = csrfToken;
    }

    const res = await fetch(path, { ...fetchOptions, headers, signal: requestSignal.signal });

    if (raw) {
      // Streaming response: caller owns the body. Don't parse here.
      // Keep caller abort wired after returning so cancelling chat/agent
      // streams can still abort the in-progress response body read.
      keepCallerAbortForRawResponse = true;
      return res;
    }

    const data = await parseJsonOrTextResponse(res);
    if (!res.ok) {
      outcome = 'err';
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }

    return data;
  } catch (e) {
    outcome = 'err';
    throw normalizeRequestError(e, requestSignal);
  } finally {
    requestSignal.dispose({ keepCallerListener: keepCallerAbortForRawResponse });
    // L-6: Always decrement the in-flight counter and reflect terminal
    // status, regardless of which return path we took. Centralising this
    // avoids the prior bug where the streaming branch forgot to clear it.
    _activeRequests = Math.max(0, _activeRequests - 1);
    if (_activeRequests === 0) {
      setStatus(outcome === 'err' ? t('status_error') : t('status_done'), outcome === 'err' ? 'err' : 'ok');
    }
  }
}

function createRequestSignal({ timeout, callerSignal }) {
  const controller = new AbortController();
  const timeoutMs = Number(timeout);
  let didTimeout = false;
  let timeoutId = null;

  const abortFromCaller = () => {
    if (controller.signal.aborted) return;
    try {
      controller.abort(callerSignal?.reason);
    } catch {
      controller.abort();
    }
  };

  const canListenToCaller = callerSignal && typeof callerSignal.addEventListener === 'function';
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else if (canListenToCaller) {
    callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      if (!controller.signal.aborted) {
        controller.abort(createTimeoutError(timeoutMs));
      }
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    didTimeout: () => didTimeout,
    timeoutMs,
    dispose({ keepCallerListener = false } = {}) {
      if (timeoutId) clearTimeout(timeoutId);
      if (canListenToCaller && !keepCallerListener) {
        callerSignal.removeEventListener('abort', abortFromCaller);
      }
    },
  };
}

function normalizeRequestError(error, requestSignal) {
  if (requestSignal.didTimeout()) {
    return createTimeoutError(requestSignal.timeoutMs);
  }
  return error;
}

function createTimeoutError(timeoutMs) {
  const err = new Error(`Request timed out after ${timeoutMs}ms`);
  err.name = 'TimeoutError';
  err.status = 408;
  err.code = 'REQUEST_TIMEOUT';
  return err;
}

async function parseJsonOrTextResponse(res) {
  const text = await res.text();
  if (!text) return {};

  const contentType = res.headers.get('content-type') || '';
  const isJsonType = contentType.includes('application/json');
  const trimmed = text.trim();

  if (!isJsonType && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return { message: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function assetUrl(path) {
  if (!path) return '';
  // クエリパラメータに BFF トークンを載せないようにし、Cookie 認証のみにする
  if (/^https?:\/\//.test(path)) {
    return `/api/assets/proxy?url=${encodeURIComponent(path)}`;
  }
  return `/api/assets/proxy?key=${encodeURIComponent(path)}`;
}

export { api, assetUrl, extractImages };

function extractImages(data) {
  // 1min.ai: resultObject is a string[] of URLs (most providers), but some
  // Google/Flow providers wrap them in { images: [...] } or { output: [...] }.
  // Newer responses (post-2025) also surface generated URLs directly under
  // aiRecord.output, so check that path too.
  const candidates = [
    data?.aiRecord?.aiRecordDetail?.resultObject,
    data?.aiRecord?.output,
    data?.aiRecord?.resultObject,
    data?.resultObject,
    data?.result,
  ];
  let raw = null;
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string' || Array.isArray(c)) {
      raw = c;
      break;
    }
    if (c && typeof c === 'object') {
      if (Array.isArray(c.images)) {
        raw = c.images;
        break;
      }
      if (Array.isArray(c.output)) {
        raw = c.output;
        break;
      }
      if (Array.isArray(c.urls)) {
        raw = c.urls;
        break;
      }
    }
  }
  if (raw == null && Array.isArray(data?.images)) raw = data.images;

  const arr = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  return arr
    .map((x) => {
      if (typeof x === 'string') return x;
      if (x && typeof x === 'object') {
        return x.url || x.path || x.key || x.location || null;
      }
      return null;
    })
    .filter(Boolean);
}

function getCookie(name) {
  const nameEq = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=';
  const matches = document.cookie.match(new RegExp('(?:^|;\\s*)' + nameEq + '([^;]*)', 'g'));
  if (!matches || matches.length !== 1) return null;
  const match = matches[0].match(new RegExp('(?:^|;\\s*)' + nameEq + '([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
