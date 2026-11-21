import express from 'express';
import { z } from 'zod';
import { assertCapability, getProvider, resolveProviderId } from '../../providers/index.js';
import { unwrapAssetProxyUrl } from '../../utils/asset-utils.js';
import { bindRequestAbortSignal, booleanFlagInput, optionalNumberInput } from './utils.js';

const router = express.Router();

const videoGenerateSchema = z
  .object({
    provider: z.enum(['1min', '1forall']).optional(),
    prompt: z
      .preprocess((v) => (v === undefined || v === null ? '' : String(v)), z.string().max(20_000))
      .optional()
      .default(''),
    imageUrl: z
      .preprocess((v) => (v === undefined || v === null ? '' : String(v)), z.string().max(4096))
      .optional()
      .default(''),
    model: z.string().max(200, 'model is too long').optional(),
    aspect_ratio: z.string().max(32, 'aspect_ratio is too long').default('16:9'),
    duration: optionalNumberInput(
      z
        .number({ message: 'duration must be a number' })
        .int('duration must be an integer')
        .min(1, 'duration must be between 1 and 60 seconds')
        .max(60, 'duration must be between 1 and 60 seconds')
        .optional()
        .default(5),
    ),
    resolution: z.string().max(32).default('720p'),
    audio: booleanFlagInput(true),
    negativePrompt: z.string().max(5000).optional(),
    mode: z.string().max(32).optional(),
    version: z.string().max(32).optional(),
    speed: optionalNumberInput(z.number().min(0.1).max(10).optional()),
    additionalFields: z.record(z.string(), z.any()).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.prompt.trim() && !data.imageUrl.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt or imageUrl is required',
      });
    }
  });

router.post('/generate', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const parsed = videoGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Validation error' });
    }

    const data = parsed.data;
    const providerId = resolveProviderId(data.provider);
    assertCapability(providerId, 'videoGeneration', 'Video generation');
    if (data.imageUrl.trim()) {
      assertCapability(providerId, 'imageToVideo', 'Image-to-Video');
    }

    const rawImageUrl = data.imageUrl.trim();
    const resolvedImageUrl =
      rawImageUrl && providerId === '1forall' ? unwrapAssetProxyUrl(rawImageUrl) : rawImageUrl;

    const provider = getProvider(providerId);
    const result = await provider.generateVideo({
      prompt: data.prompt.trim(),
      imageUrl: resolvedImageUrl || undefined,
      model: data.model,
      aspect_ratio: data.aspect_ratio,
      duration: data.duration,
      resolution: data.resolution,
      audio: data.audio,
      negativePrompt: data.negativePrompt,
      mode: data.mode,
      version: data.version,
      speed: data.speed,
      additionalFields: data.additionalFields,
      signal: controller.signal,
    });

    res.json(result);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

export default router;
