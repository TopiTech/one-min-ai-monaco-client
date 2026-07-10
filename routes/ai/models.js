import express from 'express';
import { getChatModels, getCodeModels, getImageModels, fetchModels } from '../../config/models.js';

const router = express.Router();

// Available models endpoint
router.get('/', (_req, res) => {
  res.json({ chatModels: getChatModels(), codeModels: getCodeModels(), imageModels: getImageModels() });
});

// Manual model refresh endpoint
let _modelRefreshInFlight = null;
router.post('/refresh', async (_req, res, next) => {
  try {
    if (_modelRefreshInFlight) {
      await _modelRefreshInFlight;
    } else {
      _modelRefreshInFlight = fetchModels();
      try {
        await _modelRefreshInFlight;
      } finally {
        _modelRefreshInFlight = null;
      }
    }
    res.json({
      ok: true,
      models: { chatModels: getChatModels(), codeModels: getCodeModels(), imageModels: getImageModels() },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
