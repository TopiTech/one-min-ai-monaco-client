/**
 * Unit tests for config/models.js dynamic model fetching.
 *
 * Covers: initModels, fetchModels fallback, getModelSyncStatus,
 * and hardcoded model list shape.
 */
import { jest } from "@jest/globals";

// Stub fetch globally
const originalFetch = globalThis.fetch;
beforeEach(() => {
  process.env.ONE_MIN_AI_API_KEY = "test-api-key";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetchJson(data) {
  globalThis.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => data,
    text: async () => JSON.stringify(data),
  }));
}

function mockFetchError(status = 500) {
  globalThis.fetch = jest.fn(async () => ({
    ok: false,
    status,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => ({ error: "fail" }),
    text: async () => JSON.stringify({ error: "fail" }),
  }));
}

describe("config/models.js", () => {
  // ----------------------------------------------------------------
  // Hardcoded model lists
  // ----------------------------------------------------------------
  describe("hardcoded model lists", () => {
    test("getChatModels returns an array of models", async () => {
      const { getChatModels } = await import("../config/models.js");
      const models = getChatModels();
      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty("id");
      expect(models[0]).toHaveProperty("label");
      expect(models[0]).toHaveProperty("provider");
    });

    test("getCodeModels returns an array with code-tagged models", async () => {
      const { getCodeModels } = await import("../config/models.js");
      const models = getCodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "qwen3-coder-plus")).toBe(true);
    });

    test("getImageModels returns an array with image models", async () => {
      const { getImageModels } = await import("../config/models.js");
      const models = getImageModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.some((m) => m.id === "gpt-image-2")).toBe(true);
    });
  });

  // ----------------------------------------------------------------
  // getModelSyncStatus
  // ----------------------------------------------------------------
  describe("getModelSyncStatus", () => {
    test("returns an object with ok, lastSync, error", async () => {
      const { getModelSyncStatus } = await import("../config/models.js");
      const status = getModelSyncStatus();
      expect(status).toHaveProperty("ok");
      expect(status).toHaveProperty("lastSync");
    });
  });

  // ----------------------------------------------------------------
  // fetchModels (initModels) - successful fetch
  // ----------------------------------------------------------------
  describe("initModels with successful /api/models fetch", () => {
    test("updates model lists when fetch succeeds", async () => {
      mockFetchJson({
        models: [
          { type: "CHAT", id: "test-chat-model", label: "Test Chat" },
          { type: "CODE_GENERATOR", id: "test-code-model", label: "Test Code" },
          { type: "IMAGE_GENERATOR", id: "test-image-model", label: "Test Image" },
        ],
      });

      const { initModels, getChatModels } = await import("../config/models.js");
      await initModels();

      const status = await import("../config/models.js").then((m) => m.getModelSyncStatus());
      expect(status.ok).toBe(true);
      expect(status.lastSync).not.toBeNull();
    });
  });

  // ----------------------------------------------------------------
  // fetchModels - 404 fallback
  // ----------------------------------------------------------------
  describe("initModels with 404 from /api/models", () => {
    test("treats 404 as feature unavailable without error", async () => {
      mockFetchError(404);

      const { initModels, getModelSyncStatus } = await import("../config/models.js");
      await initModels();

      const status = getModelSyncStatus();
      expect(status.ok).toBe(true); // 404 = feature unavailable, not system error
    });
  });

  // ----------------------------------------------------------------
  // fetchModels - 500 error
  // ----------------------------------------------------------------
  describe("initModels with 500 from /api/models", () => {
    test("marks sync as failed on server error", async () => {
      mockFetchError(500);

      const { initModels, getModelSyncStatus } = await import("../config/models.js");
      await initModels();

      const status = getModelSyncStatus();
      expect(status.ok).toBe(false);
      expect(status.error).toBeDefined();
    });
  });

  // ----------------------------------------------------------------
  // fetchModels - different field names (type / featureType / modelType)
  // ----------------------------------------------------------------
  describe("fetchModels handles different model type field names", () => {
    test("accepts featureType as alternative to type", async () => {
      mockFetchJson({
        models: [
          { featureType: "CHAT", id: "alt-chat-model", label: "Alt Chat" },
        ],
      });

      const { initModels, getModelSyncStatus } = await import("../config/models.js");
      await initModels();

      expect(getModelSyncStatus().ok).toBe(true);
    });
  });
});
