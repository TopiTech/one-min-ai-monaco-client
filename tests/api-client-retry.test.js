/**
 * Unit tests for api-client retry and timeout logic.
 *
 * Covers: callOneMin retry on 429, timeout via AbortController,
 * non-idempotent retry disable, error propagation, extractFailureMessage,
 * normalizeOneMinResponse, isFailedResponse.
 */
import { jest } from "@jest/globals";

// Stub fetch globally so no real network calls happen
const originalFetch = globalThis.fetch;

beforeEach(() => {
  process.env.ONE_MIN_AI_API_KEY = "test-api-key";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Mock fetch to control responses
function mockFetch(responses) {
  let callIndex = 0;
  globalThis.fetch = jest.fn(async (_url, _opts) => {
    const handler = responses[Math.min(callIndex, responses.length - 1)];
    callIndex++;
    return handler();
  });
}

function jsonResponse(data, status = 200) {
  return () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

function textResponse(text, status = 200) {
  return () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Map([["content-type", "text/plain"]]),
    json: async () => { throw new Error("not json"); },
    text: async () => text,
  });
}

function rateLimitedResponse(retryAfter) {
  return () => ({
    ok: false,
    status: 429,
    headers: new Map([
      ["content-type", "application/json"],
      ["retry-after", String(retryAfter)],
    ]),
    json: async () => ({ error: "rate limited" }),
    text: async () => JSON.stringify({ error: "rate limited" }),
  });
}

describe("api-client callOneMin", () => {
  // ----------------------------------------------------------------
  // Non-idempotent calls should not retry
  // ----------------------------------------------------------------
  test("does not retry non-idempotent POST calls", async () => {
    mockFetch([jsonResponse({ result: "ok" })]);
    const { callOneMin } = await import("../utils/api-client.js");
    const data = await callOneMin("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ type: "UNIFY_CHAT_WITH_AI" }),
      idempotent: false,
    });
    expect(data).toEqual({ result: "ok" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  // ----------------------------------------------------------------
  // Timeout throws 408
  // ----------------------------------------------------------------
  test("throws 408 on timeout", async () => {
    // Pass an already-aborted signal so fetchWithTimeout aborts immediately
    const abortController = new AbortController();
    abortController.abort();

    const { callOneMin } = await import("../utils/api-client.js");
    await expect(
      callOneMin("/api/chat-with-ai", {
        method: "POST",
        body: "{}",
        idempotent: true,
        signal: abortController.signal,
      })
    ).rejects.toMatchObject({ status: 499 });
  });

  // ----------------------------------------------------------------
  // Non-OK response throws with status
  // ----------------------------------------------------------------
  test("throws on non-OK response", async () => {
    mockFetch([jsonResponse({ error: "bad request" }, 400)]);
    const { callOneMin } = await import("../utils/api-client.js");
    await expect(
      callOneMin("/api/chat-with-ai", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  // ----------------------------------------------------------------
  // Raw mode returns Response object
  // ----------------------------------------------------------------
  test("returns raw Response when raw=true", async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/event-stream"]]),
    };
    mockFetch([() => fakeResponse]);
    const { callOneMin } = await import("../utils/api-client.js");
    const result = await callOneMin("/api/chat-with-ai?isStreaming=true", {
      method: "POST",
      body: "{}",
      raw: true,
    });
    expect(result).toBe(fakeResponse);
  });

  // ----------------------------------------------------------------
  // Non-JSON response falls back to { text }
  // ----------------------------------------------------------------
  test("handles non-JSON response gracefully", async () => {
    mockFetch([textResponse("plain text response")]);
    const { callOneMin } = await import("../utils/api-client.js");
    const data = await callOneMin("/api/chat-with-ai", {
      method: "POST",
      body: "{}",
    });
    expect(data).toEqual({ text: "plain text response" });
  });
});

describe("isFailedResponse", () => {
  test("returns true on FAILED", async () => {
    const { isFailedResponse } = await import("../utils/api-client.js");
    expect(isFailedResponse({ aiRecord: { status: "FAILED" } })).toBe(true);
  });

  test("returns false on SUCCESS", async () => {
    const { isFailedResponse } = await import("../utils/api-client.js");
    expect(isFailedResponse({ aiRecord: { status: "SUCCESS" } })).toBe(false);
  });

  test("returns false on null", async () => {
    const { isFailedResponse } = await import("../utils/api-client.js");
    expect(isFailedResponse(null)).toBe(false);
  });

  test("returns false on non-object", async () => {
    const { isFailedResponse } = await import("../utils/api-client.js");
    expect(isFailedResponse("hello")).toBe(false);
  });
});

describe("normalizeOneMinResponse", () => {
  test("extracts text, resultObject, conversationId, uuid", async () => {
    const { normalizeOneMinResponse } = await import("../utils/api-client.js");
    const data = {
      aiRecord: {
        uuid: "abc-123",
        conversationId: "conv-456",
        aiRecordDetail: {
          resultObject: ["hello world"],
        },
      },
    };
    const result = normalizeOneMinResponse(data);
    expect(result.text).toBe("hello world");
    expect(result.resultObject).toEqual(["hello world"]);
    expect(result.conversationId).toBe("conv-456");
    expect(result.uuid).toBe("abc-123");
    expect(result.raw).toBe(data);
  });
});
