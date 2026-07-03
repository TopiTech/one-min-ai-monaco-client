/**
 * Environment variable guard utility.
 * Centralizes environmental filtering to protect credentials like ONE_MIN_AI_API_KEY
 * and LOCAL_BFF_AUTH_TOKEN when executing sub-processes.
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

  const safeEnv = {};
  const secretValues = [process.env.ONE_MIN_AI_API_KEY, process.env.LOCAL_BFF_AUTH_TOKEN].filter(
    (v) => v && typeof v === 'string' && v.length > 5,
  );

  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV_KEYS.has(key) && value) {
      const containsSecret = secretValues.some((secret) => value.includes(secret));
      if (!containsSecret) {
        safeEnv[key] = value;
      }
    }
  }
  return safeEnv;
}
