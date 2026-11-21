import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { SessionLock } from '../utils/async-lock.js';
import { HttpError } from '../utils/errors.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_KEYS_FILE = path.join(PROJECT_ROOT, '.mimocode', 'data', 'api_keys.json');
const keyStoreLock = new SessionLock();

export const SUPPORTED_PROVIDERS = Object.freeze(/** @type {const} */ (['1min', '1forall']));

const PLACEHOLDER_PATTERNS = [
  'your_1min_ai_api_key_here',
  'your_1forall_api_key_here',
  'your_one_for_all_api_key_here',
  'your_api_key_here',
  '<your_api_key>',
  '<your api key>',
];

/** @type {string | null} */
let customKeysFilePath = null;
/** @type {Record<string, string> | null} */
let memoryKeysCache = null;

/**
 * Override the backing file path (used by tests to isolate from workspace data).
 * Pass `null` to restore default behavior.
 * @param {string | null} filePath
 */
export function setKeyStoreFilePath(filePath) {
  customKeysFilePath = filePath;
  memoryKeysCache = null;
}

/**
 * Reset in-memory key store cache (useful in tests).
 */
export function resetKeyStoreCache() {
  memoryKeysCache = null;
}

function getEffectiveFilePath() {
  if (customKeysFilePath !== null) return customKeysFilePath;
  if (process.env.API_KEYS_STORE_PATH) return path.resolve(process.env.API_KEYS_STORE_PATH);
  // In test environment without an explicit custom path, keep UI keys in-memory only
  // so unit tests that manipulate process.env are never affected by local disk state.
  if (process.env.NODE_ENV === 'test') return '';
  return DEFAULT_KEYS_FILE;
}

function isPlaceholderKey(value) {
  if (!value || typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return PLACEHOLDER_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Strips common auth header prefixes if the user pasted "Bearer xxx" or "Api-Key xxx".
 * @param {string} rawKey
 * @returns {string}
 */
export function normalizeRawApiKey(rawKey) {
  if (typeof rawKey !== 'string') return '';
  let trimmed = rawKey.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    trimmed = trimmed.replace(/^bearer\s+/i, '').trim();
  } else if (/^api-key\s+/i.test(trimmed)) {
    trimmed = trimmed.replace(/^api-key\s+/i, '').trim();
  }
  return trimmed;
}

/**
 * Validates an API key string before storing.
 * @param {unknown} rawKey
 * @returns {string} Normalized key
 */
export function validateApiKeyInput(rawKey) {
  if (typeof rawKey !== 'string') {
    throw new HttpError(400, 'API key must be a string', 'INVALID_API_KEY_FORMAT');
  }
  const normalized = normalizeRawApiKey(rawKey);
  if (!normalized) {
    throw new HttpError(400, 'API key is required', 'INVALID_API_KEY_FORMAT');
  }
  if (normalized.length < 8 || normalized.length > 512) {
    throw new HttpError(400, 'API key length must be between 8 and 512 characters', 'INVALID_API_KEY_FORMAT');
  }
  // Reject control characters or whitespace inside the normalized key
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\s]/.test(normalized)) {
    throw new HttpError(
      400,
      'API key must not contain whitespace or control characters',
      'INVALID_API_KEY_FORMAT',
    );
  }
  if (isPlaceholderKey(normalized)) {
    throw new HttpError(400, 'Please provide a real API key, not a placeholder', 'INVALID_API_KEY_FORMAT');
  }
  return normalized;
}

/**
 * Masks an API key for safe display in the UI.
 * Never exposes more than 4 leading and 4 trailing characters.
 * @param {string} key
 * @returns {string | null}
 */
export function maskApiKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  if (!trimmed) return null;
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}...${trimmed.slice(-2)}`;
  }
  if (trimmed.length <= 12) {
    return `${trimmed.slice(0, 3)}...${trimmed.slice(-3)}`;
  }
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}

function loadStoredKeysSync() {
  if (memoryKeysCache !== null) {
    return memoryKeysCache;
  }
  const filePath = getEffectiveFilePath();
  if (!filePath) {
    memoryKeysCache = {};
    return memoryKeysCache;
  }
  try {
    if (!fs.existsSync(filePath)) {
      memoryKeysCache = {};
      return memoryKeysCache;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    /** @type {Record<string, string>} */
    const clean = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const provider of SUPPORTED_PROVIDERS) {
        const val = parsed[provider];
        if (typeof val === 'string' && !isPlaceholderKey(val)) {
          clean[provider] = normalizeRawApiKey(val);
        }
      }
    }
    memoryKeysCache = clean;
    return memoryKeysCache;
  } catch (err) {
    logger.warn('Failed to read stored API keys file; starting with empty UI key store', {
      error: err.message,
    });
    memoryKeysCache = {};
    return memoryKeysCache;
  }
}

async function persistStoredKeys(keysObj) {
  const filePath = getEffectiveFilePath();
  if (!filePath) {
    memoryKeysCache = { ...keysObj };
    return;
  }

  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true });
  const tmpFile = path.join(dir, `api_keys.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify(keysObj, null, 2);
  try {
    await fsp.writeFile(tmpFile, payload, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      const stat = await fsp.lstat(filePath);
      if (stat.isSymbolicLink()) {
        throw new Error('Target API key file is a symbolic link, writing blocked');
      }
    } catch (statErr) {
      if (statErr.code !== 'ENOENT') throw statErr;
    }
    await fsp.rename(tmpFile, filePath);
    memoryKeysCache = { ...keysObj };
  } catch (err) {
    await fsp.unlink(tmpFile).catch(() => {});
    throw err;
  }
}

function getEnvApiKey(providerId) {
  if (providerId === '1min') {
    const raw = process.env.ONE_MIN_AI_API_KEY || process.env.ONEMIN_API_KEY || '';
    return isPlaceholderKey(raw) ? '' : normalizeRawApiKey(raw);
  }
  if (providerId === '1forall') {
    const raw = process.env.ONE_FOR_ALL_API_KEY || process.env.ONEFORALL_API_KEY || '';
    return isPlaceholderKey(raw) ? '' : normalizeRawApiKey(raw);
  }
  return '';
}

/**
 * Returns the active API key for the given provider, preferring UI-saved keys
 * over environment variables.
 * @param {'1min'|'1forall'} [providerId='1min']
 * @returns {string}
 */
export function getApiKey(providerId = '1min') {
  const stored = loadStoredKeysSync();
  if (stored[providerId]) {
    return stored[providerId];
  }
  return getEnvApiKey(providerId);
}

/**
 * Returns where the key comes from ('ui', 'env', or 'none').
 * @param {'1min'|'1forall'} [providerId='1min']
 * @returns {'ui'|'env'|'none'}
 */
export function getApiKeySource(providerId = '1min') {
  const stored = loadStoredKeysSync();
  if (stored[providerId]) return 'ui';
  if (getEnvApiKey(providerId)) return 'env';
  return 'none';
}

/**
 * Returns true if the provider has a usable API key configured.
 * @param {'1min'|'1forall'} [providerId='1min']
 * @returns {boolean}
 */
export function hasApiKey(providerId = '1min') {
  return Boolean(getApiKey(providerId));
}

/**
 * Saves an API key for a provider (persisted to .mimocode/data/api_keys.json).
 * @param {'1min'|'1forall'} providerId
 * @param {string} rawKey
 */
export async function setApiKey(providerId, rawKey) {
  if (!SUPPORTED_PROVIDERS.includes(providerId)) {
    throw new HttpError(400, `Unsupported provider: ${providerId}`, 'INVALID_PROVIDER');
  }
  const validated = validateApiKeyInput(rawKey);
  await keyStoreLock.acquire('api_keys', async () => {
    const current = { ...loadStoredKeysSync(), [providerId]: validated };
    await persistStoredKeys(current);
  });
  return {
    provider: providerId,
    configured: true,
    source: 'ui',
    masked: maskApiKey(validated),
  };
}

/**
 * Deletes a UI-stored API key for a provider. If an environment variable key
 * exists, the provider falls back to 'env'.
 * @param {'1min'|'1forall'} providerId
 */
export async function deleteApiKey(providerId) {
  if (!SUPPORTED_PROVIDERS.includes(providerId)) {
    throw new HttpError(400, `Unsupported provider: ${providerId}`, 'INVALID_PROVIDER');
  }
  await keyStoreLock.acquire('api_keys', async () => {
    const current = { ...loadStoredKeysSync() };
    delete current[providerId];
    await persistStoredKeys(current);
  });

  const fallbackKey = getEnvApiKey(providerId);
  return {
    provider: providerId,
    configured: Boolean(fallbackKey),
    source: fallbackKey ? 'env' : 'none',
    masked: fallbackKey ? maskApiKey(fallbackKey) : null,
  };
}

/**
 * Returns safe status metadata for all supported providers (never plaintext keys).
 */
export function getProvidersKeyStatus() {
  /** @type {Record<string, {provider: string, configured: boolean, source: string, masked: string|null}>} */
  const status = {};
  for (const providerId of SUPPORTED_PROVIDERS) {
    const key = getApiKey(providerId);
    const source = getApiKeySource(providerId);
    status[providerId] = {
      provider: providerId,
      configured: Boolean(key),
      source,
      masked: key ? maskApiKey(key) : null,
    };
  }
  return status;
}

/**
 * Returns all currently active secret values (API keys and auth tokens) for
 * environment scrubbing and output sanitization.
 * @returns {string[]}
 */
export function getActiveSecretValues() {
  const stored = loadStoredKeysSync();
  const candidates = [
    process.env.ONE_MIN_AI_API_KEY,
    process.env.ONEMIN_API_KEY,
    process.env.ONE_FOR_ALL_API_KEY,
    process.env.ONEFORALL_API_KEY,
    process.env.LOCAL_BFF_AUTH_TOKEN,
    stored['1min'],
    stored['1forall'],
  ];
  const unique = new Set();
  for (const val of candidates) {
    if (val && typeof val === 'string' && val.trim().length > 5 && !isPlaceholderKey(val)) {
      unique.add(val.trim());
    }
  }
  return [...unique];
}
