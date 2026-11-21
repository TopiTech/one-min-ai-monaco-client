import { serverConfig } from '../../config/server.js';
import { getApiKey } from '../../services/key-store.js';
import { HttpError } from '../../utils/errors.js';
import { createHttpClient } from '../../utils/http-client.js';

function requireOneForAllApiKey() {
  const apiKey = getApiKey('1forall');
  if (!apiKey) {
    throw new HttpError(
      400,
      'ONE_FOR_ALL_API_KEY is not configured. Please configure your 1forall.ai API key in Settings or .env.',
      'PROVIDER_NOT_CONFIGURED',
    );
  }
  return apiKey;
}

const oneForAllHttpClient = createHttpClient({
  providerLabel: '1forall.ai',
  getBaseUrl: () => serverConfig.oneForAllApiBaseUrl,
  getAuthHeaders: () => {
    const apiKey = requireOneForAllApiKey();
    // 1forall.ai accepts Authorization: Bearer <key> across both /v1/external/* and /v1/* OpenAI-compat routes.
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  },
  quietParseErrorPaths: new Set([
    '/v1/external/llm/models/',
    '/v1/external/image/models/',
    '/v1/external/video/models/',
    '/v1/models',
  ]),
});

/**
 * Calls the 1forall.ai API with retry/timeout support and Bearer authentication.
 * @param {string} pathname
 * @param {object} [options]
 */
export async function callOneForAll(pathname, options = {}) {
  return oneForAllHttpClient(pathname, options);
}
