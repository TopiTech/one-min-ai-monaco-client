import { jest } from "@jest/globals";
import request from "supertest";

// Mock the api-client module before importing anything that uses it
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
    const key = data?.asset?.key || "";
    return { key, url: key ? `https://asset.1min.ai/${key}` : "" };
  }),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { message: text }; }
  }),
}));

// Re-import mocked client and other helpers after mocking
const { callOneMin } = await import("../utils/api-client.js");
const { createTestApp, testPayloads, mockResponses } = await import("./test-helper.js");

describe("AI Routes Integration Tests", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
    process.env.ONE_MIN_AI_API_KEY = "test-api-key";
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

  describe("POST /api/chat", () => {
    test("should call callOneMin and return chat response data", async () => {
      callOneMin.mockResolvedValue(mockResponses.chat);

      const response = await request(app).post("/api/chat").send(testPayloads.chat);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.chat);
      expect(callOneMin).toHaveBeenCalledWith("/api/chat-with-ai", expect.any(Object));
    });

    test("should return 400 if prompt is missing or empty", async () => {
      const response = await request(app).post("/api/chat").send({ model: "gpt-4o-mini" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("prompt is required");
    });
  });

  describe("POST /api/images/generate", () => {
    test("should return generated image response", async () => {
      callOneMin.mockResolvedValue(mockResponses.image);

      const response = await request(app).post("/api/images/generate").send(testPayloads.image);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.image);
      expect(callOneMin).toHaveBeenCalledWith("/api/features", expect.any(Object));
    });

    test("should return 400 if image prompt is missing", async () => {
      const response = await request(app).post("/api/images/generate").send({ model: "gpt-image-2" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("prompt is required");
    });
  });

  describe("POST /api/code/generate", () => {
    test("should return generated code response", async () => {
      callOneMin.mockResolvedValue(mockResponses.code);

      const response = await request(app).post("/api/code/generate").send(testPayloads.codeGenerate);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.code);
      expect(callOneMin).toHaveBeenCalledWith(
        "/api/features",
        expect.objectContaining({
          body: expect.stringContaining('"type":"CODE_GENERATOR"'),
        }),
      );

      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.promptObject).toEqual(
        expect.objectContaining({
          prompt: expect.stringContaining("ユーザー指示:"),
          webSearch: false,
        }),
      );
      // Per 1min.ai CODE_GENERATOR docs, webSearch/numOfSite/maxWord live
      // directly on promptObject — there should be no `settings` wrapper.
      expect(sentBody.promptObject).not.toHaveProperty("settings");
    });

    test("should return 400 if instruction is missing", async () => {
      const response = await request(app).post("/api/code/generate").send({ code: "console.log()" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("instruction is required");
    });
  });

  describe("POST /api/assets/upload", () => {
    test("should not return raw upstream payload", async () => {
      callOneMin.mockResolvedValue({
        asset: { key: "uploads/test.txt" },
      });

      const response = await request(app)
        .post("/api/assets/upload")
        .attach("asset", Buffer.from("hello"), { filename: "test.txt", contentType: "text/plain" });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        key: "uploads/test.txt",
        url: "https://asset.1min.ai/uploads/test.txt",
      });
      expect(response.body).not.toHaveProperty("raw");
    });
  });

  describe("POST /api/code/autocomplete", () => {
    test("should return suggestion code", async () => {
      callOneMin.mockResolvedValue({
        result: 'console.log("world");',
      });

      const response = await request(app).post("/api/code/autocomplete").send(testPayloads.codeAutocomplete);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("suggestion");
      expect(response.body.suggestion).toBe('console.log("world");');
    });
  });

  describe("POST /api/images/text-editor", () => {
    test("should return edited image response", async () => {
      callOneMin.mockResolvedValue({
        aiRecord: {
          uuid: "edit-uuid-123",
          aiRecordDetail: {
            resultObject: ["images/edited-result.png"],
          },
        },
      });

      const response = await request(app).post("/api/images/text-editor").send({
        imageUrl: "images/source.png",
        prompt: "change background to sunset",
        model: "gpt-image-2",
      });

      expect(response.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledWith("/api/features", expect.any(Object));
    });

    test("should return 400 if imageUrl is missing", async () => {
      const response = await request(app)
        .post("/api/images/text-editor")
        .send({ prompt: "edit", model: "gpt-image-2" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("imageUrl");
    });

    test("should return 400 if WxH size is malformed for gpt-image", async () => {
      const response = await request(app).post("/api/images/text-editor").send({
        imageUrl: "images/source.png",
        prompt: "edit",
        model: "gpt-image-2",
        size: "invalid-size",
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("size must be in WxH format");
    });
  });

  describe("POST /api/agent/chat", () => {
    test("should accept prompt string and return agent response", async () => {
      callOneMin.mockResolvedValue({
        result: "I will fix this bug.",
      });

      const response = await request(app).post("/api/agent/chat").send({
        prompt: "Fix the bug in the code",
        model: "claude-sonnet-4-6",
        webSearch: false,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty("text");
      expect(response.body.text).toBe("I will fix this bug.");
      expect(response.body).toHaveProperty("raw");
      expect(callOneMin).toHaveBeenCalledWith("/api/chat-with-ai", expect.any(Object));
    });

    test("should accept messages array and flatten into prompt", async () => {
      callOneMin.mockResolvedValue({
        result: "Based on the conversation, here is the fix.",
      });

      const response = await request(app)
        .post("/api/agent/chat")
        .send({
          messages: [
            { role: "user", content: "Read the file utils/helper.js" },
            { role: "assistant", content: "I read the file. It exports an add function." },
            { role: "user", content: "Add a multiply function" },
          ],
          model: "claude-sonnet-4-6",
        });

      expect(response.status).toBe(200);
      expect(response.body.text).toBe("Based on the conversation, here is the fix.");

      // Verify that the flattened prompt contains role markers and uses Chat with AI API
      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.type).toBe("UNIFY_CHAT_WITH_AI");
      expect(sentBody.promptObject.prompt).toContain("[USER]");
      expect(sentBody.promptObject.prompt).toContain("[ASSISTANT]");
      expect(sentBody.promptObject.prompt).toContain("Read the file");
      expect(sentBody.promptObject.prompt).toContain("Add a multiply function");
    });

    test("should return 400 when both prompt and messages are missing", async () => {
      const response = await request(app).post("/api/agent/chat").send({ model: "claude-sonnet-4-6" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("prompt");
    });

    test("should return 400 when messages is an empty array", async () => {
      const response = await request(app)
        .post("/api/agent/chat")
        .send({ messages: [], model: "claude-sonnet-4-6" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("prompt");
    });
  });

  describe("GET /api/assets/proxy", () => {
    let originalFetch;
    beforeAll(() => {
      originalFetch = global.fetch;
    });
    afterAll(() => {
      global.fetch = originalFetch;
    });

    test("should proxy asset from 1min.ai and return it", async () => {
      const mockResponseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("fake image data"));
          controller.close();
        }
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        body: mockResponseBody,
      });

      const response = await request(app)
        .get("/api/assets/proxy")
        .query({ key: "images/test.png" });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      const receivedText = response.text || (response.body && response.body.toString()) || "";
      expect(receivedText).toBe("fake image data");
      expect(global.fetch).toHaveBeenCalledWith("https://asset.1min.ai/images/test.png");
    });

    test("should reject untrusted hosts", async () => {
      const response = await request(app)
        .get("/api/assets/proxy")
        .query({ url: "https://evil.com/malicious.png" });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Untrusted asset host");
    });

    test("should reject untrusted Amazon S3 hosts", async () => {
      const response = await request(app)
        .get("/api/assets/proxy")
        .query({ url: "https://evil-bucket.s3.amazonaws.com/malicious.png" });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Untrusted asset host");
    });

    test("should allow path-style Amazon S3 URLs for trusted bucket", async () => {
      const mockResponseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("fake s3 image data"));
          controller.close();
        }
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        body: mockResponseBody,
      });

      const response = await request(app)
        .get("/api/assets/proxy")
        .query({ url: "https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/test.png" });

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      const receivedText = response.text || (response.body && response.body.toString()) || "";
      expect(receivedText).toBe("fake s3 image data");
      expect(global.fetch).toHaveBeenCalledWith("https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/test.png");
    });

    test("should reject path-style Amazon S3 URLs for untrusted bucket", async () => {
      const response = await request(app)
        .get("/api/assets/proxy")
        .query({ url: "https://s3.us-east-1.amazonaws.com/evil-bucket/malicious.png" });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain("Untrusted asset host");
    });
  });
});
