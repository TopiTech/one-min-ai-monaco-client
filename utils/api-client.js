import "dotenv/config";
import { serverConfig } from "../config/server.js";
import logger from "./logger.js";

const API_BASE = "https://api.1min.ai";

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
    return response;
  } catch (error) {
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
    clearTimeout(timeoutId);
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

/**
 * Calls the 1min.ai API with retry logic for 429 errors and timeout support.
 */
export async function callOneMin(
  pathname,
  { method = "POST", body, headers = {}, raw = false, signal } = {},
) {
  const apiKey = requireApiKey();
  const maxRetries = serverConfig.apiRetryAttempts;
  const retryDelay = serverConfig.apiRetryDelay;

  const makeRequest = async () => {
    return fetchWithTimeout(`${API_BASE}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "API-KEY": apiKey,
        ...headers,
      },
      body,
      signal,
    });
  };

  let lastError = new Error(`All ${maxRetries + 1} retry attempts failed for ${pathname}`);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Add jitter to prevent thundering herd (up to 20% randomness)
        const jitter = 1 + (Math.random() * 0.2 - 0.1);
        const waitTime = Math.round(retryDelay * Math.pow(2, attempt - 1) * jitter);
        logger.warn(
          `Retry attempt ${attempt}/${maxRetries} for ${pathname} after ${waitTime}ms (jitter applied)`,
        );
        await delay(waitTime);
      }

      const response = await makeRequest();

      if (response.status === 422) {
        // Do not retry 422
        const payload = await response.json().catch(() => ({}));
        const err = new Error(`1min.ai request failed: 422`);
        err.status = 422;
        err.payload = payload;
        throw err;
      }

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfter = response.headers.get("Retry-After");
        const jitter = 1 + (Math.random() * 0.2 - 0.1);
        let waitTime = Math.round(retryDelay * Math.pow(2, attempt) * jitter);
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed) && parsed > 0) {
            waitTime = Math.min(parsed * 1000 + Math.random() * 1000, 60_000);
          }
        }
        logger.warn(`Rate limited (429) on ${pathname}. Retrying in ${waitTime}ms...`);
        await delay(waitTime);
        continue;
      }

      const contentType = response.headers.get("content-type") || "";
      if (raw) return response;

      let payload;
      if (contentType.includes("application/json")) {
        payload = await response.json();
      } else {
        payload = { text: await response.text() };
      }

      if (!response.ok) {
        const err = new Error(`1min.ai request failed: ${response.status}`);
        err.status = response.status;
        err.payload = payload;
        throw err;
      }

      logger.debug(`API call successful: ${pathname}`, { status: response.status });
      return payload;
    } catch (error) {
      lastError = error;

      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error;
      }

      if (attempt < maxRetries) {
        logger.warn(`Request failed for ${pathname}, will retry: ${error.message}`);
      }
    }
  }

  logger.error(`All retry attempts failed for ${pathname}`, { error: lastError.message });
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
    if (typeof c === "string") return c;
    if (Array.isArray(c))
      return c.map((x) => (typeof x === "string" ? x : JSON.stringify(x, null, 2))).join("\n");
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
 */
export function normalizeAssetResponse(data) {
  const asset = data?.asset || {};
  const key = asset.key || data?.fileContent?.path || asset.location || data?.path || "";
  return {
    key,
    url: key && !/^https?:\/\//.test(key) ? `https://asset.1min.ai/${key.replace(/^\//, "")}` : key,
    raw: data,
  };
}
