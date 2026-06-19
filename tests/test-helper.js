import { createApp } from "../server.js";

/**
 * Creates and configures a clean Express application instance for route testing.
 * Uses the production app factory with test-specific auth/rate-limit options.
 */
export function createTestApp() {
  return createApp({
    requireLocalAuth: false,
    enableRateLimit: false,
  });
}

/**
 * Common mock payloads for testing router inputs.
 */
export const testPayloads = {
  chat: {
    prompt: "Hello AI",
    model: "gpt-4o-mini",
    webSearch: false,
  },
  image: {
    prompt: "a beautiful futuristic workspace",
    model: "gpt-image-2",
    num_outputs: 1,
    aspect_ratio: "1:1",
  },
  imageEditor: {
    imageUrl: "assets/some-key.png",
    prompt: "change background to sunset",
    model: "gpt-image-2",
    size: "1024x1024",
  },
  codeGenerate: {
    instruction: "Create a sum function",
    fileName: "math.js",
    language: "javascript",
    code: "",
  },
  codeAutocomplete: {
    code: "function add(a, b) {\n  return a + b;\n}\n\n// call add",
    line: 5,
    column: 1,
    fileName: "math.js",
    language: "javascript",
  },
};

/**
 * Standard simulated API response builders for 1min.ai.
 */
export const mockResponses = {
  chat: {
    result: "Hello! I am an AI assistant.",
    aiRecord: {
      uuid: "chat-uuid-123",
      aiRecordDetail: {
        resultObject: "Hello! I am an AI assistant.",
      },
    },
  },
  image: {
    result: {
      images: ["https://api.1min.ai/assets/generated-1.png"],
    },
    aiRecord: {
      uuid: "image-uuid-123",
      resultObject: {
        images: ["https://api.1min.ai/assets/generated-1.png"],
      },
    },
  },
  code: {
    result: "```javascript\nfunction sum(a, b) {\n  return a + b;\n}\n```",
    aiRecord: {
      uuid: "code-uuid-123",
      aiRecordDetail: {
        resultObject: "```javascript\nfunction sum(a, b) {\n  return a + b;\n}\n```",
      },
    },
  },
};
