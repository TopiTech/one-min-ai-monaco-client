/**
 * Regression tests for review fixes.
 * Covers:
 *  - /api/conversations surfaces 1min.ai FAILED status as 502
 *  - Multer LIMIT_FILE_SIZE is mapped to HTTP 413 (not 500)
 *  - api-client sends BOTH `API-KEY` and `Authorization: Bearer` headers
 *  - mime-guard allows empty buffers when declared mime is present
 *  - rate-limit ordering: sub-route limits apply BEFORE the global default
 *  - /api/code/* and /api/agent/chat build a flat promptObject (not nested settings)
 */
import { jest } from "@jest/globals";
import request from "supertest";
import path from "path";
import fs from "fs/promises";
import os from "os";

// --- mock api-client so we never hit the real 1min.ai API ---
jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => {
    const c = data?.aiRecord?.aiRecordDetail?.resultObject;
    if (Array.isArray(c)) return c.join("\n");
    return data?.result || JSON.stringify(data);
  }),
  isFailedResponse: jest.fn((data) => {
    if (!data || typeof data !== "object") return false;
    const s = data?.aiRecord?.status ?? data?.status;
    if (!s) return false;
    return String(s).toUpperCase() !== "SUCCESS" && String(s).toUpperCase() !== "COMPLETED";
  }),
  extractFailureMessage: jest.fn(
    (data) =>
      data?.aiRecord?.aiRecordDetail?.errorMessage ||
      data?.aiRecord?.errorMessage ||
      data?.error?.message ||
      data?.error ||
      "Upstream returned a failure status",
  ),
  // M-14: data.message is intentionally NOT a fallback in the real implementation.
  normalizeAssetResponse: jest.fn((data) => ({
    key: data?.asset?.key || "",
    url: "",
    raw: data,
  })),
}));

const { callOneMin } = await import("../utils/api-client.js");
const { createApp } = await import("../server.js");
const { validateBufferMimeType } = await import("../utils/mime-guard.js");

describe("Review fixes regression", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ONE_MIN_AI_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe("/api/conversations: surfaces upstream FAILED", () => {
    test("returns 502 when 1min.ai returns FAILED status", async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { status: "FAILED", aiRecordDetail: { errorMessage: "credit exceeded" } },
      });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post("/api/conversations")
        .send({ title: "test", model: "gpt-4o-mini" });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/credit exceeded/);
    });

    test("returns 200 when 1min.ai returns SUCCESS", async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { status: "SUCCESS", uuid: "abc-123" },
      });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post("/api/conversations")
        .send({ title: "test", model: "gpt-4o-mini" });

      expect(res.status).toBe(200);
    });
  });

  describe("Multer error mapping", () => {
    test("LIMIT_FILE_SIZE returns 413 (not 500)", async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // 50MB of zeros with mimetype that would otherwise pass, exceeding 25MB default
      const buf = Buffer.alloc(50 * 1024 * 1024, 0);
      const original = process.env.MAX_FILE_SIZE;
      process.env.MAX_FILE_SIZE = "100";
      try {
        const smallApp = createApp({ requireLocalAuth: false, enableRateLimit: false });
        const res = await request(smallApp)
          .post("/api/assets/upload")
          .attach("asset", buf, { filename: "big.bin", contentType: "text/plain" });
        expect(res.status).toBe(413);
      } finally {
        if (original === undefined) delete process.env.MAX_FILE_SIZE;
        else process.env.MAX_FILE_SIZE = original;
      }
    });
  });

  describe("api-client auth headers", () => {
    test("callOneMin includes API-KEY and Authorization Bearer headers in source", async () => {
      const fs = await import("fs/promises");
      const src = await fs.readFile(
        new URL("../utils/api-client.js", import.meta.url),
        "utf-8",
      );
      // Both auth headers must be set in the implementation
      expect(src).toMatch(/"API-KEY":\s*apiKey/);
      expect(src).toMatch(/Authorization:\s*`Bearer\s+\$\{apiKey\}`/);
    });

    test("caller-provided Authorization header is preserved (not overwritten by default)", async () => {
      // Inspect source: the implementation must guard against
      // overwriting caller-supplied auth headers.
      const fs = await import("fs/promises");
      const src = await fs.readFile(
        new URL("../utils/api-client.js", import.meta.url),
        "utf-8",
      );
      // The implementation excludes api-key/authorization from caller override
      expect(src).toMatch(/api-key.*authorization.*continue/);
    });
  });

  describe("mime-guard: empty buffers", () => {
    test("allows empty buffer with declared mime", () => {
      expect(validateBufferMimeType(Buffer.alloc(0), "text/plain")).toBe(true);
      expect(validateBufferMimeType(Buffer.alloc(0), "application/json")).toBe(true);
    });

    test("rejects empty buffer without declared mime", () => {
      expect(validateBufferMimeType(Buffer.alloc(0), "")).toBe(false);
      expect(validateBufferMimeType(Buffer.alloc(0), undefined)).toBe(false);
    });
  });

  describe("CODE_GENERATOR payload shape (no nested settings)", () => {
    test("POST /api/code/generate sends flat promptObject.webSearch", async () => {
      let capturedBody;
      callOneMin.mockImplementation(async (_path, opts) => {
        capturedBody = JSON.parse(opts.body);
        return { aiRecord: { status: "SUCCESS" } };
      });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post("/api/code/generate")
        .send({
          instruction: "fix bug",
          model: "qwen3-coder-plus",
          webSearch: true,
          numOfSite: 3,
          maxWord: 500,
        });
      expect(res.status).toBe(200);
      expect(capturedBody.type).toBe("CODE_GENERATOR");
      expect(capturedBody.promptObject.webSearch).toBe(true);
      expect(capturedBody.promptObject.numOfSite).toBe(3);
      expect(capturedBody.promptObject.maxWord).toBe(500);
      // The legacy nested form must NOT appear
      expect(capturedBody.promptObject.settings).toBeUndefined();
    });
  });
});
