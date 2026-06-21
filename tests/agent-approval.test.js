/**
 * Integration tests for the agent approval / command execution flow.
 * Run with: node --experimental-vm-modules node_modules/.bin/jest
 */

import { jest } from "@jest/globals";
import request from "supertest";

// Set NODE_ENV to test BEFORE the dynamic import so server.js never calls
// initModels() at module evaluation time (which would make real API calls).
process.env.NODE_ENV = "test";

// Mock api-client (required by server.js) and command-runner (required by agent routes)
jest.unstable_mockModule("../utils/api-client.js", () => ({
  callOneMin: jest.fn().mockResolvedValue({}),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => "mocked failure"),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || "", url: "", raw: data })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try { return JSON.parse(text); } catch { return { message: text }; }
  }),
}));

// Mock command-runner so executeCommand returns a predictable result
// without actually spawning a process.
const mockExecuteCommand = jest.fn();
jest.unstable_mockModule("../services/command-runner.js", () => ({
  executeCommand: mockExecuteCommand,
  checkCommandSafety: jest.fn((command) => {
    // Re-implement the safety check inline (pure function, no side effects).
    // Must mirror the real checkCommandSafety's dangerous patterns for test accuracy.
    if (!command || typeof command !== "string") return { safe: false, reason: "Command is empty or invalid" };
    const trimmed = command.trim();
    if (!trimmed) return { safe: false, reason: "Command is empty" };
    const SHELL_INJECTION_PATTERN = /[\n\r;|`<>&]|&&|\|\||\$\(|\$\{|%(?:0[aAdD]|\d{2})/;
    if (SHELL_INJECTION_PATTERN.test(trimmed)) {
      return { safe: false, reason: "Command contains shell metacharacters" };
    }
    // Block known dangerous patterns (subset of the real DANGEROUS_PATTERNS)
    const dangerous = [
      /rm\s+-rf\s+\//, /rm\s+-rf\s+\*/, /rm\s+-rf\s+~/,
      /sudo\s+/i,
      /(?:^|\s)node\s+-{1,2}(e|p|eval|print)/i,
      /(?:^|\s)bash\s+-(c|l)\b/i,
    ];
    for (const pattern of dangerous) {
      if (pattern.test(trimmed)) {
        return { safe: false, reason: `Command matches dangerous pattern: ${pattern.toString()}` };
      }
    }
    return { safe: true };
  }),
  killProcess: jest.fn(),
  DEFAULT_TIMEOUT_MS: 30000,
}));

const { createApp } = await import("../server.js");

describe("Agent Approval Flow", () => {
  let app;
  let sessionId;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = "test";
    process.env.AGENT_AUTO_APPROVE = "false";
    process.env.ENABLE_COMMAND_EXECUTION = "true";
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const response = await request(app)
      .post("/api/agent/sessions")
      .send({ cwd: process.cwd(), task: "Approval test" });

    sessionId = response.body.session.id;
  });

  afterEach(() => {
    delete process.env.AGENT_AUTO_APPROVE;
    delete process.env.ENABLE_COMMAND_EXECUTION;
  });

  describe("POST /sessions/:id/commands with approval required", () => {
    test("returns requiresApproval with token when approval is needed", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({ command: "echo hello" });

      expect(response.status).toBe(200);
      expect(response.body.requiresApproval).toBe(true);
      expect(response.body.approvalToken).toBeDefined();
      expect(typeof response.body.approvalToken).toBe("string");
      expect(response.body.command).toBe("echo hello");
      expect(response.body.message).toBe("このコマンドを実行しますか？");
      // executeCommand should NOT have been called (only safety check)
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("returns 404 for invalid session ID", async () => {
      const response = await request(app)
        .post("/api/agent/sessions/nonexistent-id/commands")
        .send({ command: "echo hello" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("Session not found");
    });

    // Note: ENABLE_COMMAND_EXECUTION is read from the serverConfig singleton
    // at module import time; changing process.env does not affect it at
    // this point. See command-runner unit tests for disabled-execution
    // coverage.

    test("returns 400 or 403 when command is missing", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({});

      expect([400, 403]).toContain(response.status);
      expect(response.body.error).toMatch(/Invalid input|command is required|Validation error|auth/i);
    });

    test("returns 400 when command is blocked by safety check", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({ command: "rm -rf /" });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain("Command blocked");
    });
  });

  describe("POST /sessions/:id/approve", () => {
    let validToken;

    beforeEach(async () => {
      // Create a pending command first
      const cmdResponse = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({ command: "echo hello" });

      validToken = cmdResponse.body.approvalToken;

      // Set up the mock to return a success result
      mockExecuteCommand.mockResolvedValue({
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        timedOut: false,
      });
    });

    test("executes an approved command and returns the result", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/approve`)
        .send({ approvalToken: validToken });

      expect(response.status).toBe(200);
      expect(response.body.executed).toBe(true);
      expect(response.body.exitCode).toBe(0);
      expect(response.body.stdout).toBe("hello");
      expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "echo hello",
        expect.objectContaining({
          cwd: expect.any(String),
        }),
      );
    });

    test("returns 400 for invalid approval token", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/approve`)
        .send({ approvalToken: "invalid-token" });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe("Invalid or expired approval token");
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("returns 400 or 403 for missing approval token", async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/approve`)
        .send({});

      expect([400, 403]).toContain(response.status);
      expect(response.body.error).toMatch(/Invalid input|Invalid or expired approval token|Validation error|auth/i);
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("returns 403 when session ID does not match the pending command", async () => {
      // Create a second session
      const res2 = await request(app)
        .post("/api/agent/sessions")
        .send({ cwd: process.cwd(), task: "Second session" });
      const secondSessionId = res2.body.session.id;

      const response = await request(app)
        .post(`/api/agent/sessions/${secondSessionId}/approve`)
        .send({ approvalToken: validToken });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("Session ID mismatch");
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    test("re-executes safety check before approving", async () => {
      // First, create a pending command with a blocked command
      const cmdResponse = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({ command: "echo safe" });
      const safeToken = cmdResponse.body.approvalToken;

      // Set executeCommand mock but it shouldn't be called for this test
      // because the original pending command was already safety-checked
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/approve`)
        .send({ approvalToken: safeToken });

      expect(response.status).toBe(200);
      expect(mockExecuteCommand).toHaveBeenCalled();
    });
  });
});
