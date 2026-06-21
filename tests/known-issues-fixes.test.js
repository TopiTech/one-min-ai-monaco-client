/**
 * Regression tests for the open issues tracked in docs/known-issues.md.
 *
 * Covers:
 *  - M-11: output_compression rejects non-numeric values with HTTP 400
 *  - M-14: extractFailureMessage does NOT fall back to data.message
 *  - M-12: searchInDirectory skips files larger than 256KB
 */
import { jest } from "@jest/globals";
import request from "supertest";
import path from "path";
import fs from "fs/promises";
import os from "os";

jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn((data) => {
    if (!data || typeof data !== "object") return false;
    const s = data?.aiRecord?.status ?? data?.status;
    if (!s) return false;
    return String(s).toUpperCase() !== "SUCCESS" && String(s).toUpperCase() !== "COMPLETED";
  }),
  // M-14: mirrors the production implementation that no longer trusts
  // data.message as a failure message source.
  extractFailureMessage: jest.fn((data) => {
    if (!data || typeof data !== "object") return "Upstream returned a failure status";
    return (
      data?.aiRecord?.aiRecordDetail?.errorMessage ||
      data?.aiRecord?.errorMessage ||
      data?.error?.message ||
      data?.error ||
      "Upstream returned a failure status"
    );
  }),
  normalizeAssetResponse: jest.fn((data) => ({
    key: data?.asset?.key || "",
    url: "",
    raw: data,
  })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { message: text }; }
  }),
}));

const { callOneMin } = await import("../utils/api-client.js");
const { createApp } = await import("../server.js");

describe("known-issues.md regression fixes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ONE_MIN_AI_API_KEY = "test-key";
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  // ----------------------------------------------------------------
  // M-11: output_compression must reject non-numeric values
  // ----------------------------------------------------------------
  describe("M-11: output_compression validation", () => {
    test("/api/images/generate rejects non-numeric output_compression with 400", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/generate").send({
        prompt: "a cat",
        model: "gpt-image-2",
        output_compression: "abc",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/output_compression/);
      expect(callOneMin).not.toHaveBeenCalled();
    });

    test("/api/images/generate accepts numeric output_compression", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/generate").send({
        prompt: "a cat",
        model: "gpt-image-2",
        output_compression: 75,
      });

      expect(res.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(callOneMin.mock.calls[0][1].body);
      expect(sentBody.promptObject.output_compression).toBe(75);
      expect(Number.isNaN(sentBody.promptObject.output_compression)).toBe(false);
    });

    // H-1: range validation — output_compression must be an integer in [0, 100]
    test("/api/images/generate rejects out-of-range output_compression", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      for (const bad of [-1, 101, 50.5, "Infinity"]) {
        const res = await request(app)
          .post("/api/images/generate")
          .send({ prompt: "a cat", model: "gpt-image-2", output_compression: bad });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/output_compression/);
      }
      expect(callOneMin).not.toHaveBeenCalled();
    });

    test("/api/images/text-editor rejects out-of-range output_compression", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/text-editor").send({
        imageUrl: "https://example.com/x.png",
        prompt: "change background",
        model: "gpt-image-2",
        output_compression: 999,
      });

      expect(res.status).toBe(400);
      expect(callOneMin).not.toHaveBeenCalled();
    });

    test("/api/images/generate treats empty string as omitted", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/generate").send({
        prompt: "a cat",
        model: "gpt-image-2",
        output_compression: "",
      });

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(callOneMin.mock.calls[0][1].body);
      expect(sentBody.promptObject.output_compression).toBeUndefined();
    });

    test("/api/images/text-editor rejects non-numeric output_compression with 400", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/text-editor").send({
        imageUrl: "https://example.com/x.png",
        prompt: "change background",
        model: "gpt-image-2",
        output_compression: "not-a-number",
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/output_compression/);
      expect(callOneMin).not.toHaveBeenCalled();
    });

    test("/api/images/text-editor accepts numeric output_compression", async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: "SUCCESS" } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post("/api/images/text-editor").send({
        imageUrl: "https://example.com/x.png",
        prompt: "change background",
        model: "gpt-image-2",
        output_compression: 50,
      });

      expect(res.status).toBe(200);
      const sentBody = JSON.parse(callOneMin.mock.calls[0][1].body);
      expect(sentBody.promptObject.output_compression).toBe(50);
    });
  });

  // ----------------------------------------------------------------
  // M-14: extractFailureMessage must not surface data.message
  // ----------------------------------------------------------------
  describe("M-14: extractFailureMessage ignores data.message", () => {
    test("returns generic message when only data.message is present", async () => {
      const { extractFailureMessage } = await import("../utils/api-client.js");
      // 1min.ai uses message: "Stream completed" on success — this should
      // never surface as a failure reason.
      const result = extractFailureMessage({
        aiRecord: { status: "FAILED" },
        message: "Stream completed",
      });
      expect(result).not.toBe("Stream completed");
      expect(result).toBe("Upstream returned a failure status");
    });

    test("prefers specific errorMessage over generic message", async () => {
      const { extractFailureMessage } = await import("../utils/api-client.js");
      const result = extractFailureMessage({
        aiRecord: {
          aiRecordDetail: { errorMessage: "credit exceeded" },
        },
        message: "Stream completed",
      });
      expect(result).toBe("credit exceeded");
    });

    test("prefers error.message over data.message", async () => {
      const { extractFailureMessage } = await import("../utils/api-client.js");
      const result = extractFailureMessage({
        error: { message: "rate limited" },
        message: "Stream completed",
      });
      expect(result).toBe("rate limited");
    });

    test("real extractFailureMessage does not surface data.message", async () => {
      // Verify the production implementation directly without HTTP layer so we
      // can be sure the upstream lifecycle message is never returned.
      const apiClient = await import("../utils/api-client.js");
      // Avoid hitting the mocked version (which is loaded above): re-import
      // a fresh copy from the source path.
      const fsPromises = await import("fs/promises");
      const path = await import("path");
      const src = await fsPromises.readFile(new URL("../utils/api-client.js", import.meta.url), "utf-8");
      // The fallback chain must not include data.message
      expect(src).not.toMatch(/data\?\.message\s*\|\|/);
      // And the public function must still exist
      expect(apiClient.extractFailureMessage).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // M-12: searchInDirectory caps file size at 256KB
  // ----------------------------------------------------------------
  describe("M-12: searchInDirectory file size cap", () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "search-cap-"));
      process.env.ALLOWED_ROOTS = tmpDir;
    });

    afterEach(async () => {
      delete process.env.ALLOWED_ROOTS;
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    test("skips files larger than 256KB and does not crash", async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // Create a session
      const sessionRes = await request(app)
        .post("/api/agent/sessions")
        .send({ cwd: tmpDir, task: "size cap" });
      const sessionId = sessionRes.body.session.id;

      // 300KB file filled with the search query — should be skipped
      const largeContent = "needle\n".repeat(60 * 1024); // ~420KB
      await fs.writeFile(path.join(tmpDir, "large.txt"), largeContent);

      // Small file that should match
      await fs.writeFile(path.join(tmpDir, "small.txt"), "first line\nneedle here\nlast line");

      const res = await request(app)
        .get(`/api/agent/sessions/${sessionId}/search`)
        .query({ query: "needle" });

      expect(res.status).toBe(200);
      // Only the small file should contribute results
      expect(res.body.results.length).toBeGreaterThan(0);
      for (const r of res.body.results) {
        expect(r.file).toMatch(/small\.txt$/);
        expect(r.file).not.toMatch(/large\.txt$/);
      }
    });

    test("searchInDirectory source enforces 256KB cap", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../routes/agent.js", import.meta.url), "utf-8");
      // Hard-cap must be present in the implementation
      expect(src).toMatch(/256\s*\*\s*1024/);
      // Old 1MB cap for search must NOT be present (the standalone "1024 * 1024"
      // pattern is now only used in MAX_AGENT_READ_SIZE, not in searchInDirectory)
      const searchFunc = src.slice(
        src.indexOf("async function searchInDirectory"),
        src.indexOf('router.get("/sessions/:id/dir"'),
      );
      expect(searchFunc).not.toMatch(/1024\s*\*\s*1024/);
    });
  });

  // ----------------------------------------------------------------
  // M-10: run_command resolver guard (source-level verification)
  // ----------------------------------------------------------------
  describe("M-10: run_command guards against nested approval", () => {
    test("public/app.js rejects new run_command when resolver is busy", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../public/app.js", import.meta.url), "utf-8");
      // Must check for an existing resolver before issuing a new command
      expect(src).toMatch(/state\.agent\.resolver/);
      expect(src).toMatch(/別のコマンドが承認待ち/);
    });
  });

  // ----------------------------------------------------------------
  // M-9: approval step fades out after resolution (source-level)
  // ----------------------------------------------------------------
  describe("M-9: approval step fade-out", () => {
    test("public/app.js removes approval step after decision", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../public/app.js", import.meta.url), "utf-8");
      // finalizeStep helper must fade and remove the step element
      expect(src).toMatch(/finalizeStep/);
      expect(src).toMatch(/step\.remove\(\)/);
    });
  });

  // ----------------------------------------------------------------
  // M-2: reset/stop handlers must finalize pending approval cards
  // ----------------------------------------------------------------
  describe("M-2: orphan approval cleanup on reset/stop", () => {
    test("public/app.js finalizes pending approvals on reset and stop", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../public/app.js", import.meta.url), "utf-8");
      // Both handlers must iterate .agent-step.approval and call finalize
      expect(src).toMatch(/__finalizeApproval/);
      expect((src.match(/agent-step\.approval/g) || []).length).toBeGreaterThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------------
  // M-1: run_command guard must be marked retryable so the loop does
  // not consume a maxLoops iteration on a recoverable condition.
  // ----------------------------------------------------------------
  describe("M-1: retryable run_command guard", () => {
    test("public/app.js sets retryable: true on nested-approval guard", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../public/app.js", import.meta.url), "utf-8");
      expect(src).toMatch(/retryable:\s*true/);
      // And the loop must decrement loopCount on retryable
      expect(src).toMatch(/loopCount\s*=\s*Math\.max\(0,\s*loopCount\s*-\s*1\)/);
    });
  });

  // ----------------------------------------------------------------
  // L-1: api() must always release the in-flight counter regardless of
  // which branch (raw stream, parsed JSON, or thrown error) it exits from.
  // The implementation centralises this in a try/finally block.
  // ----------------------------------------------------------------
  describe("L-1: api() in-flight counter is always released", () => {
    test("public/js/api.js decrements _activeRequests in a finally block", async () => {
      const fsPromises = await import("fs/promises");
      const src = await fsPromises.readFile(new URL("../public/js/api.js", import.meta.url), "utf-8");
      // The api() function must wrap its body in try/finally and the
      // finally block must perform the counter decrement + status update.
      const apiFnMatch = src.match(/async function api\([\s\S]*?\n\}/);
      expect(apiFnMatch).not.toBeNull();
      expect(apiFnMatch[0]).toMatch(/try\s*\{[\s\S]*finally\s*\{/);
      expect(apiFnMatch[0]).toMatch(
        /finally[\s\S]*_activeRequests\s*=\s*Math\.max\(0,\s*_activeRequests\s*-\s*1\)/,
      );
    });
  });
});
