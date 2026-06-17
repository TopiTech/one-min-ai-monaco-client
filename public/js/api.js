const statusEl = document.getElementById("status");

function getBffToken() {
  // Prefer explicit same-origin cookie; fall back to data attribute set in body.
  const cookies = document.cookie.split(";").map((c) => c.trim());
  for (const c of cookies) {
    const [k, ...rest] = c.split("=");
    if (k === "__bff_session") return decodeURIComponent(rest.join("="));
  }
  return document.body?.dataset?.bffToken || "";
}

function setStatus(text, cls = "") {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
  }
}

let _activeRequests = 0;

async function api(path, options = {}) {
  _activeRequests++;
  setStatus("通信中...", "warn");

  const { timeout = 60_000, signal, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let outcome = "ok";
  try {
    const headers = options.headers || {};
    const token = getBffToken();
    if (token) headers["x-local-bff-token"] = token;

    const res = await fetch(path, { ...fetchOptions, headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (fetchOptions.raw) {
      // Streaming response: caller owns the body. Don't parse here.
      return res;
    }

    const data = await parseJsonOrTextResponse(res);
    if (!res.ok) {
      outcome = "err";
      throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
    }

    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    outcome = "err";
    throw e;
  } finally {
    // L-6: Always decrement the in-flight counter and reflect terminal
    // status, regardless of which return path we took. Centralising this
    // avoids the prior bug where the streaming branch forgot to clear it.
    _activeRequests = Math.max(0, _activeRequests - 1);
    if (_activeRequests === 0) {
      setStatus(outcome === "err" ? "エラー" : "完了", outcome === "err" ? "err" : "ok");
    }
  }
}

async function parseJsonOrTextResponse(res) {
  const text = await res.text();
  if (!text) return {};

  const contentType = res.headers.get("content-type") || "";
  if (
    !contentType.includes("application/json") &&
    !text.trim().startsWith("{") &&
    !text.trim().startsWith("[")
  ) {
    return { message: text };
  }

  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function assetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//.test(path)) return path;
  return `https://asset.1min.ai/${path.replace(/^\//, "")}`;
}

export { api, assetUrl, extractImages };

function extractImages(data) {
  // 1min.ai: resultObject is a string[] of URLs (most providers), but some
  // Google/Flow providers wrap them in { images: [...] } or { output: [...] }.
  const candidates = [
    data?.aiRecord?.aiRecordDetail?.resultObject,
    data?.aiRecord?.resultObject,
    data?.resultObject,
    data?.result,
  ];
  let raw = null;
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === "string" || Array.isArray(c)) {
      raw = c;
      break;
    }
    if (c && typeof c === "object") {
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
      if (typeof x === "string") return x;
      if (x && typeof x === "object") {
        return x.url || x.path || x.key || x.location || null;
      }
      return null;
    })
    .filter(Boolean);
}
