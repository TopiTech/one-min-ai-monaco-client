import express from 'express';
import { z } from 'zod';
import { callOneMin, isFailedResponse, extractFailureMessage } from '../../utils/api-client.js';
import { HttpError } from '../../utils/errors.js';
import { assertCapability, resolveProviderId } from '../../providers/index.js';
import { bindRequestAbortSignal, getDefaultModel } from './utils.js';

const router = express.Router();

const ALLOWED_CONVERSATION_TYPES = ['UNIFY_CHAT_WITH_AI', 'CODE_GENERATOR', 'IMAGE_GENERATOR'];

const conversationCreateSchema = z.object({
  provider: z.enum(['1min', '1forall']).optional(),
  title: z.preprocess(
    (val) => (val === undefined || val === null ? 'New AI Conversation' : String(val)),
    z.string().min(1).max(500).default('New AI Conversation'),
  ),
  model: z.string().max(200).optional(),
  type: z.preprocess(
    (val) => (val === undefined || val === null ? 'UNIFY_CHAT_WITH_AI' : String(val)),
    z
      .string()
      .refine((val) => ALLOWED_CONVERSATION_TYPES.includes(val), {
        message: `type must be one of: ${ALLOWED_CONVERSATION_TYPES.join(', ')}`,
      })
      .default('UNIFY_CHAT_WITH_AI'),
  ),
});

router.post('/', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const result = conversationCreateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }
    const { provider: rawProvider, title, model, type } = result.data;
    const providerId = resolveProviderId(rawProvider);
    assertCapability(providerId, 'serverConversations', 'Server-side conversations');

    const payload = {
      type,
      title,
      model: model || getDefaultModel(type),
    };
    const data = await callOneMin('/api/conversations', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
      signal: controller.signal,
    });
    if (isFailedResponse(data)) {
      throw new HttpError(
        502,
        `1min.ai conversation failed: ${extractFailureMessage(data)}`,
        'UPSTREAM_API_ERROR',
        data,
      );
    }
    res.json(data);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

export default router;
