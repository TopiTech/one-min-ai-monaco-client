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
      const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
      err.status = res.status;
      if (data?.code !== undefined) err.code = data.code;
      err.payload = data;
      throw err;
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
  const isJsonType = contentType.toLowerCase().includes('application/json') || /\+json\b/i.test(contentType);
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
  if (
    /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(path) ||
    path.startsWith('/api/assets/proxy?')
  ) {
    return path;
  }
  // クエリパラメータに BFF トークンを載せないようにし、Cookie 認証のみにする
  if (/^https?:\/\//.test(path)) {
    return `/api/assets/proxy?url=${encodeURIComponent(path)}`;
  }
  return `/api/assets/proxy?key=${encodeURIComponent(path)}`;
}

export { api, assetUrl, extractImages };

function extractUrlFromImageItem(item) {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    return trimmed || null;
  }
  if (item && typeof item === 'object') {
    return item.url || item.temporaryUrl || item.url_file || item.path || item.key || item.location || null;
  }
  return null;
}

function extractUrlsFromCandidate(candidate) {
  if (candidate == null) return [];
  if (typeof candidate === 'string') {
    const single = extractUrlFromImageItem(candidate);
    return single ? [single] : [];
  }
  if (Array.isArray(candidate)) {
    return candidate.map(extractUrlFromImageItem).filter(Boolean);
  }
  if (typeof candidate === 'object') {
    for (const key of ['images', 'output', 'urls']) {
      if (Array.isArray(candidate[key])) {
        const nested = candidate[key].map(extractUrlFromImageItem).filter(Boolean);
        if (nested.length > 0) return nested;
      }
    }
    const direct = extractUrlFromImageItem(candidate);
    return direct ? [direct] : [];
  }
  return [];
}

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
    data?.images,
    data?.urls,
  ];
  for (const candidate of candidates) {
    const urls = extractUrlsFromCandidate(candidate);
    if (urls.length > 0) return urls;
  }
  return [];
}

function getCookie(name) {
  // SECURITY: Reject cookies that are missing OR duplicated in the
  // document.cookie string. A duplicated CSRF cookie is a sign of cookie
  // injection by a sibling subdomain or an extension, and we must NOT
  // forward an attacker-controlled value as the x-local-bff-token.
  // (The match regex is built from a fixed name string, so no user input
  // ever feeds into the regex itself — see taste note on RegExp construction.)
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = document.cookie.split(new RegExp('(?:^|;\\s*)' + escapedName + '=', 'g'));
  // document.cookie always has a leading empty string before the first ';'-prefixed
  // entry, so we expect `occurrences.length` to be `matchCount + 1`.
  if (occurrences.length !== 2) return null;
  const rawValue = occurrences[1].split(';')[0];
  if (!rawValue) return null;
  try {
    return decodeURIComponent(rawValue);
  } catch {
    return rawValue;
  }
}
