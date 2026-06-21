/**
 * B-11: Tests for the strict env validation layer in config/server.js.
 *
 * Every invalid env value must fall back to the documented default rather
 * than silently produce NaN / out-of-range / invalid-URL values.
 */
import { jest } from "@jest/globals";

// Reload the module under test for each scenario so the snapshot of
// process.env at the time of import is what we exercise.
async function loadConfig() {
  // Using a query-string trick forces the module cache to be bypassed.
  return import(`../config/server.js?v=${Math.random()}`);
}

const ENV_KEYS = [
  "PORT",
  "MAX_FILE_SIZE",
  "MAX_JSON_BODY_SIZE",
  "ASSET_PROXY_TIMEOUT_MS",
  "ASSET_PROXY_MAX_SIZE",
  "API_TIMEOUT",
  "API_RETRY_ATTEMPTS",
  "API_RETRY_DELAY",
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_AUTOCOMPLETE_MAX",
  "RATE_LIMIT_CHAT_MAX",
  "COMMAND_TIMEOUT_MS",
  "AGENT_MAX_LOOPS",
  "SESSION_TTL_MS",
  "LOG_LEVEL",
  "ONE_MIN_AI_API_BASE_URL",
  "ENABLE_COMMAND_EXECUTION",
  "AGENT_AUTO_APPROVE",
  "ENABLE_DRIVES_SHELL_LOOKUP",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

beforeEach(() => {
  clearEnv();
  jest.resetModules();
});

afterAll(() => {
  clearEnv();
});

describe("config/server.js env validation", () => {
  test("PORT clamps to the [1, 65535] range", async () => {
    process.env.PORT = "0";
    const c = await loadConfig();
    expect(c.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = "999999";
    const c2 = await loadConfig();
    expect(c2.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = "abc";
    const c3 = await loadConfig();
    expect(c3.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = "8080";
    const c4 = await loadConfig();
    expect(c4.serverConfig.port).toBe(8080);
  });

  test("MAX_FILE_SIZE accepts both raw bytes and suffixed values", async () => {
    jest.resetModules();
    process.env.MAX_FILE_SIZE = "2mb";
    const c = await loadConfig();
    expect(c.serverConfig.maxFileSize).toBe(2 * 1024 * 1024);

    jest.resetModules();
    process.env.MAX_FILE_SIZE = "100";
    const c2 = await loadConfig();
    expect(c2.serverConfig.maxFileSize).toBe(100);

    jest.resetModules();
    process.env.MAX_FILE_SIZE = "garbage";
    const c3 = await loadConfig();
    expect(c3.serverConfig.maxFileSize).toBe(25 * 1024 * 1024);
  });

  test("MAX_FILE_SIZE caps at the absolute maximum (100MB)", async () => {
    jest.resetModules();
    process.env.MAX_FILE_SIZE = "5gb";
    const c = await loadConfig();
    expect(c.serverConfig.maxFileSize).toBe(25 * 1024 * 1024);
  });

  test("RATE_LIMIT_MAX falls back on non-numeric input", async () => {
    jest.resetModules();
    process.env.RATE_LIMIT_MAX = "lots";
    const c = await loadConfig();
    expect(c.serverConfig.rateLimitMax).toBe(180);
  });

  test("API_RETRY_ATTEMPTS clamps to [0, 10]", async () => {
    jest.resetModules();
    process.env.API_RETRY_ATTEMPTS = "999";
    const c = await loadConfig();
    expect(c.serverConfig.apiRetryAttempts).toBe(3);

    jest.resetModules();
    process.env.API_RETRY_ATTEMPTS = "-1";
    const c2 = await loadConfig();
    expect(c2.serverConfig.apiRetryAttempts).toBe(3);
  });

  test("AGENT_MAX_LOOPS clamps to [1, 100]", async () => {
    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = "0";
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxLoops).toBe(20);

    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = "500";
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxLoops).toBe(20);

    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = "5";
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxLoops).toBe(5);
  });

  test("LOG_LEVEL rejects unknown levels", async () => {
    jest.resetModules();
    process.env.LOG_LEVEL = "verbose";
    const c = await loadConfig();
    expect(c.serverConfig.logLevel).toBe("info");

    jest.resetModules();
    process.env.LOG_LEVEL = "debug";
    const c2 = await loadConfig();
    expect(c2.serverConfig.logLevel).toBe("debug");
  });

  test("ONE_MIN_AI_API_BASE_URL rejects non-http(s) schemes", async () => {
    jest.resetModules();
    process.env.ONE_MIN_AI_API_BASE_URL = "file:///etc/passwd";
    const c = await loadConfig();
    expect(c.serverConfig.apiBaseUrl).toBe("https://api.1min.ai");

    jest.resetModules();
    process.env.ONE_MIN_AI_API_BASE_URL = "https://staging.example.com/";
    const c2 = await loadConfig();
    expect(c2.serverConfig.apiBaseUrl).toBe("https://staging.example.com"); // trailing slash stripped
  });

  test("Boolean flags are parsed conservatively", async () => {
    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = "true";
    const c = await loadConfig();
    expect(c.serverConfig.enableCommandExecution).toBe(true);

    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = "TRUE";
    const c2 = await loadConfig();
    expect(c2.serverConfig.enableCommandExecution).toBe(true);

    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = "1";
    const c3 = await loadConfig();
    expect(c3.serverConfig.enableCommandExecution).toBe(false);
  });

  test("asset proxy guardrails parse and clamp env values", async () => {
    jest.resetModules();
    process.env.ASSET_PROXY_TIMEOUT_MS = "2000";
    process.env.ASSET_PROXY_MAX_SIZE = "2mb";
    const c = await loadConfig();
    expect(c.serverConfig.assetProxyTimeoutMs).toBe(2000);
    expect(c.serverConfig.assetProxyMaxSize).toBe(2 * 1024 * 1024);

    jest.resetModules();
    process.env.ASSET_PROXY_TIMEOUT_MS = "0";
    process.env.ASSET_PROXY_MAX_SIZE = "5gb";
    const c2 = await loadConfig();
    expect(c2.serverConfig.assetProxyTimeoutMs).toBe(30000);
    expect(c2.serverConfig.assetProxyMaxSize).toBe(50 * 1024 * 1024);
  });
});
