/**
 * 1forall.ai text-model token limits.
 *
 * Lives in its own module so config/models.js can register catalog limits
 * without importing the provider (which would be a circular import).
 */
import { serverConfig } from '../../config/server.js';

/** @type {Map<string, { minMaxTokens?: number, defaultMaxTokens?: number }>} */
const modelTokenLimits = new Map();

export function registerOneForAllModelLimits(models) {
  if (!Array.isArray(models)) return;
  for (const model of models) {
    if (!model?.id) continue;
    const min = Number(model?.meta?.minMaxTokens ?? model?.min_max_tokens);
    const def = Number(model?.meta?.defaultMaxTokens ?? model?.default_max_tokens);
    if (Number.isFinite(min) || Number.isFinite(def)) {
      modelTokenLimits.set(model.id, {
        minMaxTokens: Number.isFinite(min) ? min : undefined,
        defaultMaxTokens: Number.isFinite(def) ? def : undefined,
      });
    }
  }
}

/**
 * Resolves `max_tokens` for 1forall text calls, honoring task defaults (cost
 * control) and ensuring the value never drops below the model's
 * `min_max_tokens`.
 */
export function resolveOneForAllMaxTokens({ task = 'chat', requestedMaxTokens, model }) {
  let base;
  if (Number.isFinite(Number(requestedMaxTokens)) && Number(requestedMaxTokens) > 0) {
    base = Math.floor(Number(requestedMaxTokens));
  } else if (task === 'autocomplete') {
    base = serverConfig.oneForAllMaxTokensAutocomplete;
  } else if (task === 'inline') {
    base = serverConfig.oneForAllMaxTokensInline;
  } else {
    base = serverConfig.oneForAllMaxTokensChat;
  }

  const limits = model ? modelTokenLimits.get(model) : undefined;
  const minTokens = limits?.minMaxTokens ?? 1;
  return Math.max(base, minTokens);
}
