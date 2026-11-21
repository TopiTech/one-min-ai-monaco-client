import express from 'express';
import { z } from 'zod';
import { assertCapability, getProvider, resolveProviderId } from '../../providers/index.js';

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
    duration: z.preprocess(
      (v) => (v === undefined || v === '' ? 5 : Number(v)),
      z
        .number({ message: 'duration must be a number' })
        .int('duration must be an integer')
        .min(1, 'duration must be between 1 and 60 seconds')
        .max(60, 'duration must be between 1 and 60 seconds'),
    ),
    resolution: z.string().max(32).default('720p'),
    audio: z.preprocess(
      (v) => (v === undefined ? true : v === 'true' || v === true),
      z.boolean().default(true),
    ),
    negativePrompt: z.string().max(5000).optional(),
    mode: z.string().max(32).optional(),
    version: z.string().max(32).optional(),
    speed: z.preprocess(
      (v) => (v === undefined || v === '' ? undefined : Number(v)),
      z.number().min(0.1).max(10).optional(),
    ),
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

    const provider = getProvider(providerId);
    const result = await provider.generateVideo({
      prompt: data.prompt.trim(),
      imageUrl: data.imageUrl.trim() || undefined,
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
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
