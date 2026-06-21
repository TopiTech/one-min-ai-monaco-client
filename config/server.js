/**
 * Server configuration with environment variable defaults.
 * All configurable values are centralized here.
 */

const FALLBACK = {
  port: 3000,
  maxFileSize: 25 * 1024 * 1024,
  maxJsonBodySize: "2mb",
  assetProxyTimeoutMs: 30_000,
  assetProxyMaxSize: 50 * 1024 * 1024,
  apiTimeout: 60_000,
  apiRetryAttempts: 3,
  apiRetryDelay: 2_000,
  rateLimitWindowMs: 60 * 1000,
  rateLimitMax: 180,
  rateLimitAutocompleteMax: 600,
  rateLimitChatMax: 180,
  commandTimeoutMs: 30_000,
  agentMaxLoops: 20,
  sessionTtlMs: 30 * 60 * 1000,
};

const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_RATE_LIMIT = 1;
const MAX_RATE_LIMIT = 100_000;
const MIN_RETRY = 0;
const MAX_RETRY = 10;
const MIN_LOOPS = 1;
const MAX_LOOPS = 100;
const MIN_COMMAND_TIMEOUT = 1_000;
const MAX_COMMAND_TIMEOUT = 10 * 60 * 1000; // 10 min
const MIN_SESSION_TTL = 60_000;
const MAX_SESSION_TTL = 24 * 60 * 60 * 1000; // 24h
const MIN_API_TIMEOUT = 1_000;
const MAX_API_TIMEOUT = 10 * 60 * 1000;
const MIN_ASSET_PROXY_TIMEOUT = 1_000;
const MAX_ASSET_PROXY_TIMEOUT = 5 * 60 * 1000;
const MIN_FILE_SIZE = 1;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

const VALID_LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);

/**
 * B-11: Strict integer parser. Returns the fallback when the value is
 * missing, non-numeric, out of [min, max], or not a finite integer.
 */
function intInRange(raw, min, max, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    return fallback;
  }
  return n;
}

function parseBoolean(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

function parseString(raw, fallback, validator = null) {
  if (raw === undefined || raw === null) return fallback;
  const v = String(raw);
  if (validator && !validator(v)) return fallback;
  return v;
}

function parseSize(raw, fallback) {
  // Accept plain bytes or the `2mb` / `512kb` form used by Express body-parser.
  if (!raw) return fallback;
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n) && n >= MIN_FILE_SIZE && n <= MAX_FILE_SIZE) return n;
    return fallback;
  }
  const m = trimmed.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i);
  if (!m) return fallback;
  const mult = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }[m[2].toLowerCase()];
  const n = Number(m[1]) * mult;
  if (!Number.isFinite(n) || n < MIN_FILE_SIZE || n > MAX_FILE_SIZE) return fallback;
  return n;
}

function parseBodySize(raw, fallback) {
  // Body-parser accepts a string like "2mb" or a byte number. We forward
  // the validated value as-is so Express can parse it the same way.
  if (!raw) return fallback;
  const v = String(raw).trim();
  if (/^\d+$/.test(v)) return v;
  if (/^\d+(?:\.\d+)?\s*(b|kb|mb|gb)$/i.test(v)) return v;
  return fallback;
}

function parseApiUrl(raw, fallback) {
  if (!raw) return fallback;
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" && u.protocol !== "http:") return fallback;
    return u.toString().replace(/\/$/, "");
  } catch {
    return fallback;
  }
}

function parseLogLevel(raw) {
  if (!raw) return "info";
  const v = String(raw).toLowerCase();
  return VALID_LOG_LEVELS.has(v) ? v : "info";
}

export const serverConfig = {
  // Server settings
  port: intInRange(process.env.PORT, MIN_PORT, MAX_PORT, FALLBACK.port),

  // File upload limits
  maxFileSize: parseSize(process.env.MAX_FILE_SIZE, FALLBACK.maxFileSize),
  maxJsonBodySize: parseBodySize(process.env.MAX_JSON_BODY_SIZE, FALLBACK.maxJsonBodySize),

  // Asset proxy guardrails
  assetProxyTimeoutMs: intInRange(
    process.env.ASSET_PROXY_TIMEOUT_MS,
    MIN_ASSET_PROXY_TIMEOUT,
    MAX_ASSET_PROXY_TIMEOUT,
    FALLBACK.assetProxyTimeoutMs,
  ),
  assetProxyMaxSize: parseSize(process.env.ASSET_PROXY_MAX_SIZE, FALLBACK.assetProxyMaxSize),

  // API settings
  apiTimeout: intInRange(process.env.API_TIMEOUT, MIN_API_TIMEOUT, MAX_API_TIMEOUT, FALLBACK.apiTimeout),
  apiRetryAttempts: intInRange(
    process.env.API_RETRY_ATTEMPTS,
    MIN_RETRY,
    MAX_RETRY,
    FALLBACK.apiRetryAttempts,
  ),
  apiRetryDelay: intInRange(process.env.API_RETRY_DELAY, 0, MAX_API_TIMEOUT, FALLBACK.apiRetryDelay),

  // Default models
  defaultChatModel: parseString(process.env.DEFAULT_CHAT_MODEL, "gpt-4o-mini", (s) => s.length <= 100),
  defaultCodeModel: parseString(process.env.DEFAULT_CODE_MODEL, "qwen3-coder-plus", (s) => s.length <= 100),
  defaultImageModel: parseString(process.env.DEFAULT_IMAGE_MODEL, "gpt-image-2", (s) => s.length <= 100),
  defaultImageEditorModel: parseString(
    process.env.DEFAULT_IMAGE_EDITOR_MODEL,
    "gpt-image-2",
    (s) => s.length <= 100,
  ),

  // API base URL override (1min.ai production by default; useful for
  // local mock servers or staging environments).
  apiBaseUrl: parseApiUrl(process.env.ONE_MIN_AI_API_BASE_URL, "https://api.1min.ai"),

  // Rate limiting
  rateLimitWindowMs: intInRange(
    process.env.RATE_LIMIT_WINDOW_MS,
    1_000,
    24 * 60 * 60 * 1000,
    FALLBACK.rateLimitWindowMs,
  ),
  rateLimitMax: intInRange(process.env.RATE_LIMIT_MAX, MIN_RATE_LIMIT, MAX_RATE_LIMIT, FALLBACK.rateLimitMax),
  rateLimitAutocompleteMax: intInRange(
    process.env.RATE_LIMIT_AUTOCOMPLETE_MAX,
    MIN_RATE_LIMIT,
    MAX_RATE_LIMIT,
    FALLBACK.rateLimitAutocompleteMax,
  ),
  rateLimitChatMax: intInRange(
    process.env.RATE_LIMIT_CHAT_MAX,
    MIN_RATE_LIMIT,
    MAX_RATE_LIMIT,
    FALLBACK.rateLimitChatMax,
  ),

  // Agent settings
  enableCommandExecution: parseBoolean(process.env.ENABLE_COMMAND_EXECUTION, false),
  commandTimeoutMs: intInRange(
    process.env.COMMAND_TIMEOUT_MS,
    MIN_COMMAND_TIMEOUT,
    MAX_COMMAND_TIMEOUT,
    FALLBACK.commandTimeoutMs,
  ),
  agentAutoApprove: parseBoolean(process.env.AGENT_AUTO_APPROVE, false),
  enableDrivesShellLookup: parseBoolean(process.env.ENABLE_DRIVES_SHELL_LOOKUP, true),

  // Agent max loops
  agentMaxLoops: intInRange(process.env.AGENT_MAX_LOOPS, MIN_LOOPS, MAX_LOOPS, FALLBACK.agentMaxLoops),

  // Session
  sessionTtlMs: intInRange(
    process.env.SESSION_TTL_MS,
    MIN_SESSION_TTL,
    MAX_SESSION_TTL,
    FALLBACK.sessionTtlMs,
  ),

  // Logging
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  logToFile: parseBoolean(process.env.LOG_TO_FILE, false),
  logFilePath: parseString(process.env.LOG_FILE, undefined, (s) => s.length <= 512),
};
