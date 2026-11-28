import express from 'express';
import { getProvider } from '../../providers/index.js';
import { bindRequestAbortSignal } from './utils.js';

const router = express.Router();

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ALLOWED_KINDS = new Set(['image', 'video', 'llm']);

router.get('/:provider/:kind/:jobId', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const { provider: providerId, kind, jobId } = req.params;
    if (providerId !== '1min' && providerId !== '1forall') {
      return res.status(400).json({ error: 'provider must be "1min" or "1forall"' });
    }
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ error: 'kind must be image, video, or llm' });
    }
    if (!JOB_ID_PATTERN.test(jobId)) {
      return res.status(400).json({ error: 'Invalid jobId format' });
    }

    const provider = getProvider(providerId);
    const job = await provider.getJob(jobId, kind, { signal: controller.signal });
    res.json(job);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    if (controller.signal.aborted && !res.headersSent) {
      return res.status(499).json({ error: 'Client Closed Request' });
    }
    next(err);
  } finally {
    cleanup();
  }
});

export default router;
