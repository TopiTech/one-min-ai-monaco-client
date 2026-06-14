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
    const res = await fetch(path, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
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


function extractText(data) {
  const candidates = [
    data?.aiRecord?.aiRecordDetail?.resultObject,
    data?.aiRecord?.aiRecordDetail?.result,
    data?.aiRecord?.resultObject,
    data?.result,
    data?.message,
    data?.text,
    data?.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string") return c;
    if (Array.isArray(c))
      return c.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join("\n");
    if (c && typeof c === "object") return JSON.stringify(c, null, 2);
  }
  return JSON.stringify(data, null, 2);
}

function assetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//.test(path)) return path;
  return `https://asset.1min.ai/${path.replace(/^\//, "")}`;
}

function extractImages(data) {
  const r =
    data?.aiRecord?.aiRecordDetail?.resultObject || data?.resultObject || data?.images || [];
  const arr = Array.isArray(r) ? r : [r];
  return arr
    .filter(Boolean)
    .map((x) => (typeof x === "string" ? x : x.url || x.path || x.key || JSON.stringify(x)));
}
