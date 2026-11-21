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
  const providerId = req.query?.provider ? resolveProviderId(String(req.query.provider)) : '1min';
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
let _modelRefreshInFlight = null;
router.post('/refresh', async (req, res, next) => {
  try {
    const provider = req.body?.provider ? resolveProviderId(String(req.body.provider)) : undefined;
    if (_modelRefreshInFlight) {
      await _modelRefreshInFlight;
    } else {
      _modelRefreshInFlight = fetchModels({ provider, includeAll: true });
      try {
        await _modelRefreshInFlight;
      } finally {
        _modelRefreshInFlight = null;
      }
    }
    const activeProvider = provider || '1min';
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
