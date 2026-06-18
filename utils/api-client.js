import "dotenv/config";
import { serverConfig } from "../config/server.js";
import logger from "./logger.js";

const API_BASE = serverConfig.apiBaseUrl;

function requireApiKey() {
  const apiKey = process.env.ONE_MIN_AI_API_KEY;
  if (!apiKey || apiKey.includes("your_1min_ai_api_key_here")) {
    const err = new Error(
      "ONE_MIN_AI_API_KEY is not configured. Copy .env.example to .env and set your key.",
    );
    err.status = 500;
    throw err;
  }
  return apiKey;
}

/**
 * Fetch with timeout support using AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = serverConfig.apiTimeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let onAbort;
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      onAbort = () => controller.abort();
      options.signal.addEventListener("abort", onAbort);
    }
  }

  try {
    const { signal, ...fetchOpts } = options;
    const response = await fetch(url, {
      ...fetchOpts,
      signal: controller.signal,
    });

    // B-2: For non-streaming responses, we can clear the timeout after headers.
    // However, for streaming, the caller must be able to keep the signal alive.
    // The current callOneMin structure returns the promise after headers or full JSON.
    // If it's a raw response (streaming), the timeoutId must be cleared by the caller
    // or we need a way to track body completion.
    // For now, we clear it if we are about to return, but we provide the signal to the caller.
    if (!options.isStreaming) {
      clearTimeout(timeoutId);
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId); // Ensure cleanup on error
    if (error.name === "AbortError") {
      if (options.signal && options.signal.aborted) {
        const err = new Error("Request aborted by client");
        err.name = "AbortError";
        err.status = 499;
        throw err;
      }
      const err = new Error(`Request timeout after ${timeoutMs}ms`);
      err.status = 408;
      throw err;
    }
    throw error;
  } finally {
    if (!options.isStreaming) {
      clearTimeout(timeoutId);
    }
    if (options.signal && onAbort) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Delay helper for retry logic
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseResponsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

/**
 * Calls the 1min.ai API with retry logic for 429 errors and timeout support.
 */
export async function callOneMin(
  pathname,
  {
    method = "POST",
    body,
    headers = {},
    raw = false,
    signal,
    // M-1: When true, retry is disabled entirely because the upstream side
    // effect would be duplicated (e.g. POST /api/conversations, POST /api/assets).
    // Callers that mutate state on the upstream should pass `idempotent: false`.
    idempotent = method.toUpperCase() === "GET",
  } = {},
) {
  const apiKey = requireApiKey();
  const { apiRetryAttempts: maxRetries, apiRetryDelay: retryDelay } = serverConfig;
  // Disable retries for non-idempotent calls so we never duplicate the side
  // effect (conversations, asset uploads) on transient network errors.
  const effectiveRetries = idempotent ? maxRetries : 0;

  // 1min.ai documents both `API-KEY` (used in endpoint examples) and
  // `Authorization: Bearer` (shown on the intro page). Send both so the
  // client works regardless of which header the API chooses to enforce.
  // Callers can still override via the `headers` argument.
  const baseHeaders = {
    "API-KEY": apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
  // Don't let caller-provided headers clobber our auth headers unless explicit
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "api-key" || k.toLowerCase() === "authorization") continue;
    baseHeaders[k] = headers[k];
  }

  const makeRequest = () =>
    fetchWithTimeout(`${API_BASE}${pathname}`, {
      method,
      headers: baseHeaders,
      body,
      signal,
      isStreaming: raw,
    });

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
        const retryAfter = response.headers.get("Retry-After");
        const waitTime = retryAfter
          ? Math.min(parseInt(retryAfter, 10) * 1000 + 1000, 60000)
          : Math.round(retryDelay * Math.pow(2, attempt) * (1 + (Math.random() * 0.2 - 0.1)));
        logger.warn(`Rate limited (429) on ${pathname}. Retrying in ${waitTime}ms...`);
        await delay(waitTime);
        continue;
      }

      if (!response.ok) {
        const payload = await parseResponsePayload(response);
        const err = new Error(`1min.ai request failed: ${response.status}`);
        err.status = response.status;
        err.payload = payload;
        throw err;
      }

      if (raw) return response;
      const contentType = response.headers.get("content-type") || "";
      return contentType.includes("application/json")
        ? response.json()
        : { text: await response.text() };
    } catch (error) {
      lastError = error;
      if (!lastError.status && lastError.name !== "AbortError") {
        lastError.status = 502;
        lastError.code = "UPSTREAM_NETWORK_ERROR";
      }
      if (error.status && error.status >= 400 && error.status < 500 && error.status !== 429)
        throw error;
      if (attempt < effectiveRetries)
        logger.warn(`Request failed for ${pathname}, will retry: ${error.message}`);
    }
  }

  throw lastError;
}

function firstTextCandidate(data) {
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
    if (typeof c === "string") return c || undefined;
    if (Array.isArray(c)) {
      const joined = c
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2)))
        .join("\n");
      return joined || undefined;
    }
    if (c && typeof c === "object") return JSON.stringify(c, null, 2);
  }
  return undefined;
}

/**
 * Extracts text content from a 1min.ai API response.
 */
export function extractText(data) {
  return firstTextCandidate(data) ?? JSON.stringify(data, null, 2);
}

/**
 * Returns true if the 1min.ai response indicates a logical failure
 * (e.g. status: "FAILED"). The upstream may still return 200 OK with
 * a payload describing the failure.
 */
export function isFailedResponse(data) {
  if (!data || typeof data !== "object") return false;
  const status = data?.aiRecord?.status ?? data?.status ?? data?.aiRecordDetail?.status;
  if (!status) return false;
  return String(status).toUpperCase() !== "SUCCESS" && String(status).toUpperCase() !== "COMPLETED";
}

export function extractFailureMessage(data) {
  if (!data || typeof data !== "object") return "Upstream returned a failure status";
  // M-14: Do NOT fall back to data.message — 1min.ai uses that field for
  // generic lifecycle messages like "Stream completed" even on success,
  // which would otherwise be surfaced as a misleading failure reason.
  return (
    data?.aiRecord?.aiRecordDetail?.errorMessage ||
    data?.aiRecord?.errorMessage ||
    data?.error?.message ||
    data?.error ||
    "Upstream returned a failure status"
  );
}

/**
 * Normalizes common 1min.ai response shapes for frontend consumers.
 */
export function normalizeOneMinResponse(data) {
  const resultObject =
    data?.aiRecord?.aiRecordDetail?.resultObject ??
    data?.aiRecord?.resultObject ??
    data?.resultObject;

  return {
    text: firstTextCandidate(data),
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
  const key = asset.key || data?.fileContent?.path || data?.path || "";
  const location = asset.location || "";
  const url =
    location ||
    (key && !/^https?:\/\//.test(key) ? `https://asset.1min.ai/${key.replace(/^\//, "")}` : key);
  return { key, url, raw: data };
}
