const statusEl = document.getElementById("status");

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
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const headers = options.headers || {};

    const res = await fetch(path, { ...options, headers, signal: controller.signal });
    clearTimeout(timeoutId);

    const data = await parseJsonOrTextResponse(res);
    if (!res.ok) {
      throw new Error(data?.error || data?.message || res.statusText || `HTTP ${res.status}`);
    }
    if (_activeRequests > 0) _activeRequests--;
    if (_activeRequests === 0) setStatus("完了", "ok");
    return data;
  } catch (e) {
    clearTimeout(timeoutId);
    if (_activeRequests > 0) _activeRequests--;
    if (_activeRequests === 0) setStatus("エラー", "err");
    throw e;
  }
}

async function parseJsonOrTextResponse(res) {
  const text = await res.text();
  if (!text) return {};

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json") && !text.trim().startsWith("{") && !text.trim().startsWith("[")) {
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

function extractImages(data) {
  const resultObject =
    data?.aiRecord?.aiRecordDetail?.resultObject || data?.resultObject || data?.result;
  const rawImages = resultObject?.images || data?.images || [];
  const arr = Array.isArray(rawImages) ? rawImages : [rawImages].filter(Boolean);
  return arr
    .map((x) => {
      if (typeof x === "string") return x;
      return x?.url || x?.path || x?.key || JSON.stringify(x);
    })
    .filter(Boolean);
}
