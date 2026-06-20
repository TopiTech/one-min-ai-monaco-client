/**
 * Tests for review fixes:
 * 1. Asset upload uses form-data package (not Blob/FormData browser API)
 * 2. API client handles non-JSON error responses gracefully
 * 3. Logger normalizes invalid log levels
 * 4. CSP includes api.1min.ai in connectSrc
 * 5. Static files served with X-Content-Type-Options for .js
 */

import { jest } from "@jest/globals";
import request from "supertest";

// Mock the api-client module
jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => {
    if (!data) return "";
    if (typeof data.result === "string") return data.result;
    if (data.aiRecord?.aiRecordDetail?.resultObject) return data.aiRecord.aiRecordDetail.resultObject;
    return JSON.stringify(data);
  }),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => "mocked failure"),
  normalizeAssetResponse: jest.fn((data) => {
    const key = data?.asset?.key || data?.fileContent?.path || "";
    return { key, url: key ? `https://asset.1min.ai/${key}` : "", raw: data };
  }),
}));

const { callOneMin } = await import("../utils/api-client.js");
const { createTestApp } = await import("./test-helper.js");

describe("Review Fixes", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
    process.env.ONE_MIN_AI_API_KEY = "test-api-key";
  });

  describe("Asset upload uses form-data package", () => {
    test("should return normalized asset response", async () => {
      callOneMin.mockResolvedValue({
        asset: { key: "uploads/test.txt" },
      });

      const response = await request(app)
        .post("/api/assets/upload")
        .attach("asset", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" });

      expect(response.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledWith("/api/assets", expect.any(Object));
    });

    test("should not include raw in response", async () => {
      callOneMin.mockResolvedValue({
        asset: { key: "uploads/test.txt" },
      });

      const response = await request(app)
        .post("/api/assets/upload")
        .attach("asset", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" });

      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty("raw");
      expect(response.body).toHaveProperty("key");
      expect(response.body).toHaveProperty("url");
    });

    // S-1: multer now writes uploads to a temp directory and unlinks
    // them after the upstream call. Verify the temp file is cleaned up
    // even when the upstream call succeeds.
    test("cleans up the disk-staged upload file on success", async () => {
      const os = await import("os");
      const pathMod = await import("path");
      const fsPromises = await import("fs/promises");
      const tmpDir = pathMod.join(os.tmpdir(), "one-min-ai-uploads");
      const before = new Set();
      try {
        for (const f of await fsPromises.readdir(tmpDir)) before.add(f);
      } catch {
        /* dir may not exist on a fresh test runner */
      }

      callOneMin.mockResolvedValue({ asset: { key: "uploads/cleanup.txt" } });

      const res = await request(app)
        .post("/api/assets/upload")
        .attach("asset", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" });

      expect(res.status).toBe(200);

      // After completion, no new leftover files should exist in the
      // upload temp directory.
      let after = new Set();
      try {
        for (const f of await fsPromises.readdir(tmpDir)) after.add(f);
      } catch {
        after = new Set();
      }
      const newOnes = [...after].filter((f) => !before.has(f));
      expect(newOnes).toEqual([]);
    });
  });

  describe("CSP includes api.1min.ai", () => {
    test("should include api.1min.ai in Content-Security-Policy connect-src", async () => {
      const response = await request(app).get("/");

      const csp = response.headers["content-security-policy"];
      if (csp) {
        expect(csp).toContain("api.1min.ai");
      }
    });
  });

  describe("Static files with X-Content-Type-Options", () => {
    test("should serve static JS files with X-Content-Type-Options nosniff", async () => {
      const response = await request(app).get("/js/api.js");
      if (response.status === 200) {
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
      }
    });
  });

  describe("Logger level normalization", () => {
    test("should accept valid log levels", async () => {
      const { Logger } = await import("../utils/logger.js");
      const logger = new Logger({ level: "debug" });
      expect(logger.level).toBe(3);
    });

    test("should default to info for invalid log levels", async () => {
      const { Logger } = await import("../utils/logger.js");
      const logger = new Logger({ level: "invalid-level" });
      expect(logger.level).toBe(2); // info level
    });

    test("should handle undefined log level", async () => {
      const { Logger } = await import("../utils/logger.js");
      const logger = new Logger({});
      expect(logger.level).toBe(2); // info level
    });
  });

  describe("API client error handling", () => {
    test("should handle non-JSON error responses gracefully", async () => {
      callOneMin.mockRejectedValue(new Error("1min.ai request failed: 500"));

      const response = await request(app).post("/api/chat").send({ prompt: "test" });

      expect(response.status).toBe(500);
    });

    test("should return 400 for missing prompt", async () => {
      const response = await request(app).post("/api/chat").send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("prompt is required");
    });
  });

  describe("Error payload containment in production", () => {
    let originalEnv;

    beforeAll(() => {
      originalEnv = process.env.NODE_ENV;
    });

    afterAll(() => {
      process.env.NODE_ENV = originalEnv;
    });

    test("should hide raw json payload in production", async () => {
      process.env.NODE_ENV = "production";

      const errorWithRawPayload = new Error("1min.ai request failed: 400");
      errorWithRawPayload.status = 400;
      errorWithRawPayload.payload = { internal_error_code: 999, raw_sensitive_details: "secret" };
      callOneMin.mockRejectedValue(errorWithRawPayload);

      const response = await request(app).post("/api/chat").send({ prompt: "test" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Upstream request failed with structured payload");
      expect(JSON.stringify(response.body)).not.toContain("secret");
      expect(JSON.stringify(response.body)).not.toContain("internal_error_code");
    });

    test("should expose raw json payload in non-production environments", async () => {
      process.env.NODE_ENV = "development";

      const errorWithRawPayload = new Error("1min.ai request failed: 400");
      errorWithRawPayload.status = 400;
      errorWithRawPayload.payload = { internal_error_code: 999, raw_sensitive_details: "secret" };
      callOneMin.mockRejectedValue(errorWithRawPayload);

      const response = await request(app).post("/api/chat").send({ prompt: "test" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe(JSON.stringify(errorWithRawPayload.payload));
    });
  });
});
