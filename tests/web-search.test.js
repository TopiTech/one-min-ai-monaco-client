/**
 * Unit tests for web search payload helpers
 * Run with: node --experimental-vm-modules node_modules/jest/bin/jest.js
 */

import { buildCodePayload, buildWebSearchSettings, parseWebSearchParams } from "../utils/web-search.js";

describe("web-search payload helpers", () => {
  describe("parseWebSearchParams", () => {
    test("should parse web search flags and numeric limits", () => {
      expect(
        parseWebSearchParams({
          webSearch: "true",
          numOfSite: "3",
          maxWord: "500",
        }),
      ).toEqual({
        parsedWebSearch: true,
        parsedNumOfSite: 3,
        parsedMaxWord: 500,
      });
    });

    test("should reject invalid numOfSite", () => {
      expect(() => parseWebSearchParams({ numOfSite: 0 })).toThrow(
        "numOfSite must be a number between 1 and 10",
      );
    });

    test("should reject invalid maxWord", () => {
      expect(() => parseWebSearchParams({ maxWord: 50 })).toThrow(
        "maxWord must be a number between 100 and 10000",
      );
    });
  });

  describe("buildWebSearchSettings", () => {
    test("should include optional limits only when provided", () => {
      expect(
        buildWebSearchSettings({
          webSearch: true,
          parsedNumOfSite: 3,
        }),
      ).toEqual({
        webSearch: true,
        numOfSite: 3,
      });
    });

    test("should include maxWord when provided", () => {
      expect(
        buildWebSearchSettings({
          webSearch: false,
          parsedMaxWord: 500,
        }),
      ).toEqual({
        webSearch: false,
        maxWord: 500,
      });
    });
  });

  describe("buildCodePayload", () => {
    test("should build CODE_GENERATOR payload matching 1min.ai API schema (flat webSearch on promptObject, no conversationId)", () => {
      const payload = buildCodePayload({
        prompt: "Fix this bug",
        model: "qwen3-coder-plus",
        webSearch: true,
        parsedNumOfSite: 3,
        parsedMaxWord: 500,
      });

      expect(payload).toEqual({
        type: "CODE_GENERATOR",
        model: "qwen3-coder-plus",
        promptObject: {
          prompt: "Fix this bug",
          webSearch: true,
          numOfSite: 3,
          maxWord: 500,
        },
      });
      // CODE_GENERATOR does not use conversation concept
      expect(payload).not.toHaveProperty("conversationId");
    });

    test("should omit optional fields when not provided", () => {
      const payload = buildCodePayload({
        prompt: "hello",
        webSearch: false,
      });
      expect(payload).not.toHaveProperty("conversationId");
      expect(payload.promptObject).toEqual({
        prompt: "hello",
        webSearch: false,
      });
      expect(payload.promptObject).not.toHaveProperty("numOfSite");
      expect(payload.promptObject).not.toHaveProperty("maxWord");
      expect(payload.promptObject).not.toHaveProperty("settings");
    });

    test("should fall back to default code model when model is omitted", () => {
      const payload = buildCodePayload({ prompt: "x", webSearch: false });
      expect(typeof payload.model).toBe("string");
      expect(payload.model.length).toBeGreaterThan(0);
    });
  });
});
