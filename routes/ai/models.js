import express from 'express';
import {
  getChatModels,
  getCodeModels,
  getImageModels,
  getVideoModels,
  getAllProvidersModels,
  fetchModels,
} from '../../config/models.js';
import { serverConfig } from '../../config/server.js';
import { resolveProviderId } from '../../providers/index.js';

const router = express.Router();

// Available models endpoint (supports optional ?provider=1min|1forall)
router.get('/', (req, res) => {
  const providerId = resolveProviderId(req.query?.provider);
  res.json({
    chatModels: getChatModels(providerId),
    codeModels: getCodeModels(providerId),
    imageModels: getImageModels(providerId),
    videoModels: getVideoModels(providerId),
    providers: getAllProvidersModels(),
    defaultProvider: serverConfig.defaultProvider,
  });
});

// Manual model refresh endpoint
const _modelRefreshInFlight = new Map();
router.post('/refresh', async (req, res, next) => {
  try {
    const rawProvider = req.body?.provider;
    const hasExplicitProvider = rawProvider !== undefined && rawProvider !== null && rawProvider !== '';
    const provider = hasExplicitProvider ? resolveProviderId(rawProvider) : undefined;
    const refreshKey = provider || '__all__';
    let inFlight = _modelRefreshInFlight.get(refreshKey);
    if (!inFlight) {
      inFlight = fetchModels({ provider, includeAll: true });
      _modelRefreshInFlight.set(refreshKey, inFlight);
      try {
        await inFlight;
      } finally {
        if (_modelRefreshInFlight.get(refreshKey) === inFlight) {
          _modelRefreshInFlight.delete(refreshKey);
        }
      }
    } else {
      await inFlight;
    }
    const activeProvider = provider || resolveProviderId(undefined);
    res.json({
      ok: true,
      models: {
        chatModels: getChatModels(activeProvider),
        codeModels: getCodeModels(activeProvider),
        imageModels: getImageModels(activeProvider),
        videoModels: getVideoModels(activeProvider),
        providers: getAllProvidersModels(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
