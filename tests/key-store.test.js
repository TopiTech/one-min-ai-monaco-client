import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  deleteApiKey,
  getActiveSecretValues,
  getApiKey,
  getApiKeySource,
  getProvidersKeyStatus,
  hasApiKey,
  maskApiKey,
  normalizeRawApiKey,
  resetKeyStoreCache,
  setApiKey,
  setKeyStoreFilePath,
  validateApiKeyInput,
} from '../services/key-store.js';

describe('services/key-store.js', () => {
  let tmpDir;
  let tmpKeyFile;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-'));
    tmpKeyFile = path.join(tmpDir, 'api_keys.json');
    setKeyStoreFilePath(tmpKeyFile);
    delete process.env.ONE_MIN_AI_API_KEY;
    delete process.env.ONEMIN_API_KEY;
    delete process.env.ONE_FOR_ALL_API_KEY;
    delete process.env.ONEFORALL_API_KEY;
  });

  afterEach(() => {
    setKeyStoreFilePath(null);
    resetKeyStoreCache();
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('normalizeRawApiKey strips Bearer and Api-Key prefixes', () => {
    expect(normalizeRawApiKey('  Bearer sk_live_123456  ')).toBe('sk_live_123456');
    expect(normalizeRawApiKey('api-key gAAAA123456')).toBe('gAAAA123456');
    expect(normalizeRawApiKey('raw_secret_key')).toBe('raw_secret_key');
  });

  test('validateApiKeyInput rejects invalid lengths, whitespace, and placeholders', () => {
    expect(() => validateApiKeyInput(123)).toThrow('must be a string');
    expect(() => validateApiKeyInput('')).toThrow('required');
    expect(() => validateApiKeyInput('short')).toThrow('between 8 and 512');
    expect(() => validateApiKeyInput('invalid key with space')).toThrow('whitespace');
    expect(() => validateApiKeyInput('your_1min_ai_api_key_here')).toThrow('placeholder');
    expect(validateApiKeyInput('Bearer sk_live_valid_1234')).toBe('sk_live_valid_1234');
  });

  test('maskApiKey never reveals full key', () => {
    expect(maskApiKey('')).toBeNull();
    expect(maskApiKey('12345678')).toBe('12...78');
    expect(maskApiKey('sk_live_abcdef123456')).toBe('sk_l...3456');
  });

  test('UI-stored key overrides env key and deleteApiKey falls back to env', async () => {
    process.env.ONE_MIN_AI_API_KEY = 'env_1min_secret_key_999';
    expect(getApiKey('1min')).toBe('env_1min_secret_key_999');
    expect(getApiKeySource('1min')).toBe('env');

    const saved = await setApiKey('1min', 'Bearer ui_1min_secret_key_111');
    expect(saved).toEqual({
      provider: '1min',
      configured: true,
      source: 'ui',
      masked: 'ui_1..._111',
    });
    expect(getApiKey('1min')).toBe('ui_1min_secret_key_111');
    expect(getApiKeySource('1min')).toBe('ui');
    expect(fs.existsSync(tmpKeyFile)).toBe(true);

    // Force disk reload
    resetKeyStoreCache();
    expect(getApiKey('1min')).toBe('ui_1min_secret_key_111');

    const deleted = await deleteApiKey('1min');
    expect(deleted).toEqual({
      provider: '1min',
      configured: true,
      source: 'env',
      masked: 'env_..._999',
    });
    expect(getApiKey('1min')).toBe('env_1min_secret_key_999');
  });

  test('getProvidersKeyStatus and getActiveSecretValues include both providers without placeholders', async () => {
    process.env.ONE_MIN_AI_API_KEY = 'your_1min_ai_api_key_here';
    expect(hasApiKey('1min')).toBe(false);

    await setApiKey('1forall', 'sk_live_1forall_secret_xyz');
    const status = getProvidersKeyStatus();
    expect(status['1min']).toEqual({ provider: '1min', configured: false, source: 'none', masked: null });
    expect(status['1forall']).toEqual({
      provider: '1forall',
      configured: true,
      source: 'ui',
      masked: 'sk_l..._xyz',
    });

    const secrets = getActiveSecretValues();
    expect(secrets).toContain('sk_live_1forall_secret_xyz');
    expect(secrets).not.toContain('your_1min_ai_api_key_here');
  });
});
