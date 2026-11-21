import { getActiveSecretValues } from '../services/key-store.js';

/**
 * Environment variable guard utility.
 * Centralizes environmental filtering to protect credentials like ONE_MIN_AI_API_KEY,
 * ONE_FOR_ALL_API_KEY, UI-stored keys, and LOCAL_BFF_AUTH_TOKEN when executing sub-processes.
 * @returns {NodeJS.ProcessEnv}
 */
export function getSafeEnv() {
  const SAFE_ENV_KEYS = new Set([
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'SystemRoot',
    'WINDIR',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'USER',
    'USERNAME',
    'TMP',
    'TEMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
  ]);
  const SAFE_ENV_KEYS_UPPER = new Set([...SAFE_ENV_KEYS].map((k) => k.toUpperCase()));

  /** @type {NodeJS.ProcessEnv} */
  const safeEnv = {};
  const secretValues = getActiveSecretValues();

  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS_UPPER.has(key.toUpperCase()) && value) {
      const containsSecret = secretValues.some((secret) => value.includes(secret));
      if (!containsSecret) {
        safeEnv[key] = value;
      }
    }
  }
  return safeEnv;
}
