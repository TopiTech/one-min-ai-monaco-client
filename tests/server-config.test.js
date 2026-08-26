/**
 * B-11: Tests for the strict env validation layer in config/server.js.
 *
 * Every invalid env value must fall back to the documented default rather
 * than silently produce NaN / out-of-range / invalid-URL values.
 */
import { jest } from '@jest/globals';

// Reload the module under test for each scenario so the snapshot of
// process.env at the time of import is what we exercise.
async function loadConfig() {
  // Using a query-string trick forces the module cache to be bypassed.
  return import(`../config/server.js?v=${Math.random()}`);
}

const ENV_KEYS = [
  'PORT',
  'MAX_FILE_SIZE',
  'MAX_JSON_BODY_SIZE',
  'ASSET_PROXY_TIMEOUT_MS',
  'ASSET_PROXY_MAX_SIZE',
  'API_TIMEOUT',
  'API_RETRY_ATTEMPTS',
  'API_RETRY_DELAY',
  'RATE_LIMIT_WINDOW_MS',
  'RATE_LIMIT_MAX',
  'RATE_LIMIT_AUTOCOMPLETE_MAX',
  'RATE_LIMIT_CHAT_MAX',
  'COMMAND_TIMEOUT_MS',
  'MAX_COMMAND_OUTPUT_SIZE',
  'AGENT_MAX_LOOPS',
  'AGENT_MAX_SESSIONS',
  'AGENT_MAX_PENDING_COMMANDS',
  'AGENT_MAX_HISTORY_ENTRIES',
  'AGENT_MAX_HISTORY_RESULT_SIZE',
  'AGENT_ZOMBIE_GRACE_MS',
  'AGENT_MAX_READ_SIZE',
  'AGENT_TMP_FILE_MAX_AGE_MS',
  'FS_MAX_LIST_ENTRIES',
  'FS_MAX_DELETE_ENTRIES',
  'SESSION_TTL_MS',
  'LOG_LEVEL',
  'ONE_MIN_AI_API_BASE_URL',
  'ONE_MIN_AI_ASSET_BASE_URL',
  'ONE_MIN_AI_S3_BUCKET',
  'ENABLE_COMMAND_EXECUTION',
  'AGENT_AUTO_APPROVE',
  'ENABLE_DRIVES_SHELL_LOOKUP',
  'ALLOW_UNSAFE_AGENT_AUTO_APPROVE',
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

describe('config/server.js env validation', () => {
  test('PORT clamps to the [1, 65535] range', async () => {
    process.env.PORT = '0';
    const c = await loadConfig();
    expect(c.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = '999999';
    const c2 = await loadConfig();
    expect(c2.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = 'abc';
    const c3 = await loadConfig();
    expect(c3.serverConfig.port).toBe(3000);

    jest.resetModules();
    process.env.PORT = '8080';
    const c4 = await loadConfig();
    expect(c4.serverConfig.port).toBe(8080);
  });

  test('MAX_FILE_SIZE accepts both raw bytes and suffixed values', async () => {
    jest.resetModules();
    process.env.MAX_FILE_SIZE = '2mb';
    const c = await loadConfig();
    expect(c.serverConfig.maxFileSize).toBe(2 * 1024 * 1024);

    jest.resetModules();
    process.env.MAX_FILE_SIZE = '100';
    const c2 = await loadConfig();
    expect(c2.serverConfig.maxFileSize).toBe(100);

    jest.resetModules();
    process.env.MAX_FILE_SIZE = 'garbage';
    const c3 = await loadConfig();
    expect(c3.serverConfig.maxFileSize).toBe(25 * 1024 * 1024);
  });

  test('MAX_FILE_SIZE caps at the absolute maximum (100MB)', async () => {
    jest.resetModules();
    process.env.MAX_FILE_SIZE = '5gb';
    const c = await loadConfig();
    expect(c.serverConfig.maxFileSize).toBe(25 * 1024 * 1024);
  });

  test('MAX_COMMAND_OUTPUT_SIZE parses byte sizes and defaults to 10MB', async () => {
    jest.resetModules();
    process.env.MAX_COMMAND_OUTPUT_SIZE = '5mb';
    const c = await loadConfig();
    expect(c.serverConfig.maxCommandOutputSize).toBe(5 * 1024 * 1024);

    jest.resetModules();
    delete process.env.MAX_COMMAND_OUTPUT_SIZE;
    const c2 = await loadConfig();
    expect(c2.serverConfig.maxCommandOutputSize).toBe(10 * 1024 * 1024);
  });

  test('RATE_LIMIT_MAX falls back on non-numeric input', async () => {
    jest.resetModules();
    process.env.RATE_LIMIT_MAX = 'lots';
    const c = await loadConfig();
    expect(c.serverConfig.rateLimitMax).toBe(180);
  });

  test('API_RETRY_ATTEMPTS clamps to [0, 10]', async () => {
    jest.resetModules();
    process.env.API_RETRY_ATTEMPTS = '999';
    const c = await loadConfig();
    expect(c.serverConfig.apiRetryAttempts).toBe(3);

    jest.resetModules();
    process.env.API_RETRY_ATTEMPTS = '-1';
    const c2 = await loadConfig();
    expect(c2.serverConfig.apiRetryAttempts).toBe(3);
  });

  test('AGENT_MAX_LOOPS clamps to [1, 100]', async () => {
    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = '0';
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxLoops).toBe(20);

    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = '500';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxLoops).toBe(20);

    jest.resetModules();
    process.env.AGENT_MAX_LOOPS = '5';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxLoops).toBe(5);
  });

  test('LOG_LEVEL rejects unknown levels', async () => {
    jest.resetModules();
    process.env.LOG_LEVEL = 'verbose';
    const c = await loadConfig();
    expect(c.serverConfig.logLevel).toBe('info');

    jest.resetModules();
    process.env.LOG_LEVEL = 'debug';
    const c2 = await loadConfig();
    expect(c2.serverConfig.logLevel).toBe('debug');
  });

  test('ONE_MIN_AI_API_BASE_URL rejects non-http(s) schemes', async () => {
    jest.resetModules();
    process.env.ONE_MIN_AI_API_BASE_URL = 'file:///etc/passwd';
    const c = await loadConfig();
    expect(c.serverConfig.apiBaseUrl).toBe('https://api.1min.ai');

    jest.resetModules();
    process.env.ONE_MIN_AI_API_BASE_URL = 'https://staging.example.com/';
    const c2 = await loadConfig();
    expect(c2.serverConfig.apiBaseUrl).toBe('https://staging.example.com'); // trailing slash stripped
  });

  test('Boolean flags are parsed conservatively', async () => {
    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = 'true';
    const c = await loadConfig();
    expect(c.serverConfig.enableCommandExecution).toBe(true);

    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = 'TRUE';
    const c2 = await loadConfig();
    expect(c2.serverConfig.enableCommandExecution).toBe(true);

    jest.resetModules();
    process.env.ENABLE_COMMAND_EXECUTION = '1';
    const c3 = await loadConfig();
    expect(c3.serverConfig.enableCommandExecution).toBe(false);
  });

  test('asset proxy guardrails parse and clamp env values', async () => {
    jest.resetModules();
    process.env.ASSET_PROXY_TIMEOUT_MS = '2000';
    process.env.ASSET_PROXY_MAX_SIZE = '2mb';
    const c = await loadConfig();
    expect(c.serverConfig.assetProxyTimeoutMs).toBe(2000);
    expect(c.serverConfig.assetProxyMaxSize).toBe(2 * 1024 * 1024);

    jest.resetModules();
    process.env.ASSET_PROXY_TIMEOUT_MS = '0';
    process.env.ASSET_PROXY_MAX_SIZE = '5gb';
    const c2 = await loadConfig();
    expect(c2.serverConfig.assetProxyTimeoutMs).toBe(30000);
    expect(c2.serverConfig.assetProxyMaxSize).toBe(50 * 1024 * 1024);
  });

  test('ALLOW_UNSAFE_AGENT_AUTO_APPROVE remains conservative like other boolean flags', async () => {
    jest.resetModules();
    process.env.ALLOW_UNSAFE_AGENT_AUTO_APPROVE = 'true';
    process.env.ENABLE_COMMAND_EXECUTION = 'true';
    process.env.AGENT_AUTO_APPROVE = 'true';
    const c = await loadConfig();
    expect(c.serverConfig.enableCommandExecution).toBe(true);
    expect(c.serverConfig.agentAutoApprove).toBe(true);

    jest.resetModules();
    process.env.ALLOW_UNSAFE_AGENT_AUTO_APPROVE = '1';
    process.env.ENABLE_COMMAND_EXECUTION = 'true';
    process.env.AGENT_AUTO_APPROVE = 'true';
    const c2 = await loadConfig();
    expect(c2.serverConfig.enableCommandExecution).toBe(true);
    expect(c2.serverConfig.agentAutoApprove).toBe(true);
  });

  test('ONE_MIN_AI_ASSET_BASE_URL and ONE_MIN_AI_S3_BUCKET validation', async () => {
    jest.resetModules();
    process.env.ONE_MIN_AI_ASSET_BASE_URL = 'https://custom-asset.1min.ai';
    process.env.ONE_MIN_AI_S3_BUCKET = 'custom-bucket';
    const c = await loadConfig();
    expect(c.serverConfig.assetBaseUrl).toBe('https://custom-asset.1min.ai');
    expect(c.serverConfig.s3Bucket).toBe('custom-bucket');

    jest.resetModules();
    process.env.ONE_MIN_AI_ASSET_BASE_URL = 'invalid-scheme://example.com';
    process.env.ONE_MIN_AI_S3_BUCKET = 'a'.repeat(200); // too long
    const c2 = await loadConfig();
    expect(c2.serverConfig.assetBaseUrl).toBe('https://asset.1min.ai');
    expect(c2.serverConfig.s3Bucket).toBe('asset.1min.ai');
  });

  test('AGENT_MAX_SESSIONS clamps to [1, 1000] and defaults to 50', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxSessions).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_SESSIONS = '0';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxSessions).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_SESSIONS = '99999';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxSessions).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_SESSIONS = '25';
    const c4 = await loadConfig();
    expect(c4.serverConfig.agentMaxSessions).toBe(25);

    jest.resetModules();
    process.env.AGENT_MAX_SESSIONS = 'not-a-number';
    const c5 = await loadConfig();
    expect(c5.serverConfig.agentMaxSessions).toBe(50);
  });

  test('AGENT_MAX_PENDING_COMMANDS clamps to [1, 10000] and defaults to 100', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxPendingCommands).toBe(100);

    jest.resetModules();
    process.env.AGENT_MAX_PENDING_COMMANDS = '500';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxPendingCommands).toBe(500);

    jest.resetModules();
    process.env.AGENT_MAX_PENDING_COMMANDS = '99999';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxPendingCommands).toBe(100);
  });

  test('AGENT_MAX_HISTORY_ENTRIES clamps to [1, 500] and defaults to 50', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxHistoryEntries).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_ENTRIES = '0';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxHistoryEntries).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_ENTRIES = '10000';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxHistoryEntries).toBe(50);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_ENTRIES = '25';
    const c4 = await loadConfig();
    expect(c4.serverConfig.agentMaxHistoryEntries).toBe(25);
  });

  test('AGENT_MAX_HISTORY_RESULT_SIZE clamps to [100, 1000000] and defaults to 2000', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxHistoryResultSize).toBe(2000);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_RESULT_SIZE = '10';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxHistoryResultSize).toBe(2000);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_RESULT_SIZE = '99999999';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentMaxHistoryResultSize).toBe(2000);

    jest.resetModules();
    process.env.AGENT_MAX_HISTORY_RESULT_SIZE = '5000';
    const c4 = await loadConfig();
    expect(c4.serverConfig.agentMaxHistoryResultSize).toBe(5000);
  });

  test('AGENT_ZOMBIE_GRACE_MS clamps to [0, 86400000] and defaults to 60000', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentZombieGraceMs).toBe(60000);

    jest.resetModules();
    process.env.AGENT_ZOMBIE_GRACE_MS = '120000';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentZombieGraceMs).toBe(120000);

    jest.resetModules();
    process.env.AGENT_ZOMBIE_GRACE_MS = '-1';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentZombieGraceMs).toBe(60000);

    jest.resetModules();
    process.env.AGENT_ZOMBIE_GRACE_MS = '99999999';
    const c4 = await loadConfig();
    expect(c4.serverConfig.agentZombieGraceMs).toBe(60000);
  });

  test('AGENT_MAX_READ_SIZE accepts suffixed values, falls back on out-of-range', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentMaxReadSize).toBe(10 * 1024 * 1024);

    jest.resetModules();
    process.env.AGENT_MAX_READ_SIZE = '5mb';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentMaxReadSize).toBe(5 * 1024 * 1024);

    jest.resetModules();
    process.env.AGENT_MAX_READ_SIZE = '100';
    const c3 = await loadConfig();
    // A small but valid byte count is accepted by parseSize (min 1 byte).
    expect(c3.serverConfig.agentMaxReadSize).toBe(100);

    jest.resetModules();
    process.env.AGENT_MAX_READ_SIZE = '5gb';
    const c4 = await loadConfig();
    // Above the configured maximum (100MB) — falls back to default.
    expect(c4.serverConfig.agentMaxReadSize).toBe(10 * 1024 * 1024);

    jest.resetModules();
    process.env.AGENT_MAX_READ_SIZE = 'garbage';
    const c5 = await loadConfig();
    expect(c5.serverConfig.agentMaxReadSize).toBe(10 * 1024 * 1024);
  });

  test('AGENT_TMP_FILE_MAX_AGE_MS clamps to [60000, 86400000] and defaults to 30 minutes', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.agentTmpFileMaxAgeMs).toBe(30 * 60 * 1000);

    jest.resetModules();
    process.env.AGENT_TMP_FILE_MAX_AGE_MS = '10000';
    const c2 = await loadConfig();
    expect(c2.serverConfig.agentTmpFileMaxAgeMs).toBe(30 * 60 * 1000);

    jest.resetModules();
    process.env.AGENT_TMP_FILE_MAX_AGE_MS = '7200000';
    const c3 = await loadConfig();
    expect(c3.serverConfig.agentTmpFileMaxAgeMs).toBe(7200000);
  });

  test('FS_MAX_LIST_ENTRIES clamps to [100, 100000] and defaults to 5000', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.fsMaxListEntries).toBe(5000);

    jest.resetModules();
    process.env.FS_MAX_LIST_ENTRIES = '10';
    const c2 = await loadConfig();
    expect(c2.serverConfig.fsMaxListEntries).toBe(5000);

    jest.resetModules();
    process.env.FS_MAX_LIST_ENTRIES = '20000';
    const c3 = await loadConfig();
    expect(c3.serverConfig.fsMaxListEntries).toBe(20000);
  });

  test('FS_MAX_DELETE_ENTRIES clamps to [10, 100000] and defaults to 1000', async () => {
    jest.resetModules();
    const c = await loadConfig();
    expect(c.serverConfig.fsMaxDeleteEntries).toBe(1000);

    jest.resetModules();
    process.env.FS_MAX_DELETE_ENTRIES = '0';
    const c2 = await loadConfig();
    expect(c2.serverConfig.fsMaxDeleteEntries).toBe(1000);

    jest.resetModules();
    process.env.FS_MAX_DELETE_ENTRIES = '5000';
    const c3 = await loadConfig();
    expect(c3.serverConfig.fsMaxDeleteEntries).toBe(5000);
  });
});
