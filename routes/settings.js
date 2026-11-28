import express from 'express';
import { z } from 'zod';
import { serverConfig } from '../config/server.js';
import { fetchModels, resetProviderModels } from '../config/models.js';
import { PROVIDER_CAPABILITIES } from '../providers/index.js';
import {
  deleteApiKey,
  getProvidersKeyStatus,
  hasApiKey,
  setApiKey,
  validateApiKeyInput,
} from '../services/key-store.js';
import { HttpError } from '../utils/errors.js';
import { fetchWithTimeout } from '../utils/http-client.js';
import logger from '../utils/logger.js';

const router = express.Router();

const saveKeySchema = z.object({
  provider: z.enum(['1min', '1forall'], {
    message: 'provider must be "1min" or "1forall"',
  }),
  apiKey: z.string({ message: 'apiKey is required' }),
  verify: z.boolean().optional().default(true),
});

async function verifyProviderApiKey(provider, normalizedKey) {
  const timeoutMs = Math.min(serverConfig.apiTimeout, 15_000);
  const targetUrl =
    provider === '1min'
      ? `${serverConfig.apiBaseUrl.replace(/\/$/, '')}/openai/v1/models`
      : `${serverConfig.oneForAllApiBaseUrl.replace(/\/$/, '')}/v1/external/llm/models/`;
  const headers =
    provider === '1min'
      ? {
          Authorization: `Bearer ${normalizedKey}`,
          'API-KEY': normalizedKey,
        }
      : {
          Authorization: `Bearer ${normalizedKey}`,
        };

  const res = await fetchWithTimeout(targetUrl, { method: 'GET', headers }, timeoutMs);
  try {
    if (res.status === 401 || res.status === 403) {
      const label = provider === '1min' ? '1min.ai' : '1forall.ai';
      throw new HttpError(
        401,
        `${label} API key verification failed: Invalid or revoked API key.`,
        'INVALID_API_KEY',
      );
    }
    return { verified: res.ok, status: res.status };
  } finally {
    await res.body?.cancel?.().catch(() => {});
  }
}

router.get('/providers', (_req, res) => {
  const keyStatus = getProvidersKeyStatus();
  res.json({
    defaultProvider: serverConfig.defaultProvider,
    providers: {
      '1min': {
        id: '1min',
        label: '1min.ai',
        ...keyStatus['1min'],
        capabilities: PROVIDER_CAPABILITIES['1min'],
      },
      '1forall': {
        id: '1forall',
        label: '1forall.ai',
        ...keyStatus['1forall'],
        capabilities: PROVIDER_CAPABILITIES['1forall'],
      },
    },
  });
});

router.post('/keys', async (req, res, next) => {
  try {
    const parsed = saveKeySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation error' });
    }
    const { provider, apiKey, verify } = parsed.data;
    const normalizedKey = validateApiKeyInput(apiKey);

    let verification = { verified: false, skipped: !verify };
    if (verify) {
      try {
        const result = await verifyProviderApiKey(provider, normalizedKey);
        verification = { verified: result.verified, skipped: false };
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          throw err;
        }
        throw new HttpError(
          502,
          `Could not verify ${provider} API key (${err?.message || 'network error'}). You may retry or save without verification.`,
          'KEY_VERIFICATION_FAILED',
        );
      }
    }

    const status = await setApiKey(provider, normalizedKey);
    logger.info('API key updated via settings UI', { provider, verified: verification.verified });

    // Refresh model catalog for this provider asynchronously
    fetchModels({ provider, includeAll: true }).catch((err) => {
      logger.warn('Background model refresh after key update failed', {
        provider,
        error: err?.message,
      });
    });

    res.json({
      ok: true,
      provider: status,
      verification,
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/keys/:provider', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (provider !== '1min' && provider !== '1forall') {
      return res.status(400).json({ error: 'provider must be "1min" or "1forall"' });
    }
    const status = await deleteApiKey(provider);
    logger.info('UI-stored API key removed', { provider });

    if (hasApiKey(provider)) {
      fetchModels({ provider, includeAll: true }).catch((err) => {
        logger.warn('Background model refresh after key delete failed', {
          provider,
          error: err?.message,
        });
      });
    } else {
      resetProviderModels(provider);
    }

    res.json({
      ok: true,
      provider: status,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
