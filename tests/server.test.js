/**
 * Integration tests for server factory
 * Run with: node --experimental-vm-modules node_modules/jest/bin/jest.js
 */

import { jest } from "@jest/globals";
import request from "supertest";

// Mock the api-client module
jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || "", url: "", raw: data })),
}));

// Import after mocking
const { callOneMin } = await import("../utils/api-client.js");
const { createApp } = await import("../server.js");

describe("Server Factory", () => {
  let app;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe("GET /api/health", () => {
    test("should return 200 with health status", async () => {
      process.env.ONE_MIN_AI_API_KEY = "test-key";

      const response = await request(app).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe("one-min-ai-monaco-client");
      expect(response.body.hasApiKey).toBe(true);
    });

    test("should indicate when API key is missing", async () => {
      delete process.env.ONE_MIN_AI_API_KEY;

      const response = await request(app).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body.hasApiKey).toBe(false);
    });
  });

  describe("local BFF auth", () => {
    test("should require local auth for fs routes by default", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp).get("/api/fs/config");

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Local BFF authentication required or invalid token");
    });

    test("should require local auth for AI routes", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp).post("/api/chat").send({ prompt: "test" });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Local BFF authentication required or invalid token");
    });

    test("should accept valid local auth token for AI routes", async () => {
      const { callOneMin } = await import("../utils/api-client.js");
      callOneMin.mockResolvedValue({ result: "ok" });

      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .post("/api/chat")
        .set("x-local-bff-token", "secret-token")
        .send({ prompt: "test" });

      expect(response.status).toBe(200);
    });

    test("should accept valid local auth token", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get("/api/fs/config")
        .set("x-local-bff-token", "secret-token");

      expect(response.status).toBe(200);
      expect(response.body.allowedRoots).toBeDefined();
    });

    test("should accept same-origin browser request marker", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get("/api/fs/config")
        .set("sec-fetch-site", "same-origin");

      expect(response.status).toBe(403);
    });

    test("should reject non-local Origin without token", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get("/api/fs/config")
        .set("origin", "https://evil.example");

      expect(response.status).toBe(403);
    });

    test("should accept trusted local Origin", async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: "secret-token",
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get("/api/fs/config")
        .set("origin", "http://localhost:3000");

      expect(response.status).toBe(403);
    });
  });

  describe("GET /api/models", () => {
    test("should return available models lists", async () => {
      const response = await request(app).get("/api/models");

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("chatModels");
      expect(response.body).toHaveProperty("codeModels");
      expect(response.body).toHaveProperty("imageModels");
    });
  });

  describe("GET /api/fs/read", () => {
    test("should allow reading non-secret project source files", async () => {
      const response = await request(app).get("/api/fs/read").query({ path: "server.js" });

      expect(response.status).toBe(200);
      expect(response.body.content).toContain("createApp");
    });

    test("should block reading protected secret files", async () => {
      const response = await request(app).get("/api/fs/read").query({ path: ".env" });

      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/chat", () => {
    test("should call callOneMin and return chat response data", async () => {
      callOneMin.mockResolvedValue({ result: "ok" });

      const response = await request(app)
        .post("/api/chat")
        .send({ prompt: "Hello AI", model: "gpt-4o-mini" });

      expect(response.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledWith(
        "/api/chat-with-ai",
        expect.objectContaining({
          body: expect.stringContaining('"settings"'),
        }),
      );
    });
  });

  describe("Configuration", () => {
    test("should have default values for server config", async () => {
      const { serverConfig } = await import("../config/server.js");

      expect(serverConfig.port).toBeDefined();
      expect(serverConfig.maxFileSize).toBeDefined();
      expect(serverConfig.apiTimeout).toBeDefined();
      expect(serverConfig.apiRetryAttempts).toBeDefined();
    });
  });
});
