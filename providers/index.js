import { serverConfig } from '../config/server.js';
import { HttpError } from '../utils/errors.js';
import { oneMinProvider, ONE_MIN_CAPABILITIES } from './one-min/index.js';
import { oneForAllProvider, ONE_FOR_ALL_CAPABILITIES } from './one-for-all/index.js';

export const PROVIDER_IDS = Object.freeze(['1min', '1forall']);

const PROVIDERS = Object.freeze({
  '1min': oneMinProvider,
  '1forall': oneForAllProvider,
});

export const PROVIDER_CAPABILITIES = Object.freeze({
  '1min': ONE_MIN_CAPABILITIES,
  '1forall': ONE_FOR_ALL_CAPABILITIES,
});

/**
 * Resolves and validates a provider ID, falling back to `serverConfig.defaultProvider`.
 * @param {unknown} [rawProvider]
 * @returns {'1min'|'1forall'}
 */
export function resolveProviderId(rawProvider) {
  if (rawProvider === undefined || rawProvider === null || rawProvider === '') {
    return /** @type {'1min'|'1forall'} */ (serverConfig.defaultProvider || '1min');
  }
  if (typeof rawProvider !== 'string') {
    throw new HttpError(
      400,
      'Unsupported provider. Provider must be a string ("1min" or "1forall").',
      'INVALID_PROVIDER',
    );
  }
  const normalized = rawProvider.trim().toLowerCase();
  if (normalized !== '1min' && normalized !== '1forall') {
    throw new HttpError(
      400,
      `Unsupported provider "${rawProvider}". Supported providers: 1min, 1forall`,
      'INVALID_PROVIDER',
    );
  }
  return /** @type {'1min'|'1forall'} */ (normalized);
}

/**
 * Returns the provider adapter instance for a given ID.
 * @param {unknown} [providerId]
 */
export function getProvider(providerId) {
  const id = resolveProviderId(providerId);
  return PROVIDERS[id];
}

/**
 * Resolves the provider from an Express request (`req.body.provider` or `req.query.provider`).
 * @param {import('express').Request} req
 */
export function resolveProvider(req) {
  const raw = req?.body?.provider !== undefined ? req.body.provider : req?.query?.provider;
  return getProvider(raw);
}

/**
 * Throws a 400 UNSUPPORTED_FOR_PROVIDER error when a caller requests a
 * capability not supported by the target provider.
 * @param {'1min'|'1forall'} providerId
 * @param {keyof typeof ONE_MIN_CAPABILITIES} capability
 * @param {string} featureLabel
 */
export function assertCapability(providerId, capability, featureLabel) {
  const caps = PROVIDER_CAPABILITIES[providerId];
  if (!caps || !caps[capability]) {
    throw new HttpError(
      400,
      `${featureLabel} is not supported by provider "${providerId}"`,
      'UNSUPPORTED_FOR_PROVIDER',
    );
  }
}
