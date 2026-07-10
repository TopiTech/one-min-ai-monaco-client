import express from 'express';
import { z } from 'zod';
import { callOneMin, isFailedResponse, extractFailureMessage } from '../../utils/api-client.js';
import { HttpError } from '../../utils/errors.js';
import { extractAssetKey } from '../../utils/asset-utils.js';
import { getDefaultModel, outputCompressionSchema } from './utils.js';

const router = express.Router();

const imageGenerateSchema = z
  .object({
    prompt: z.preprocess(
      (val) => (val === undefined || val === null ? '' : String(val)),
      z
        .string({ message: 'prompt is required' })
        .refine((val) => val.trim().length > 0, { message: 'prompt is required' }),
    ),
    model: z.string().optional(),
    num_outputs: z.preprocess(
      (val) => (val === undefined ? 1 : Number(val)),
      z
        .number()
        .min(1, 'num_outputs must be between 1 and 10')
        .max(10, 'num_outputs must be between 1 and 10'),
    ),
    aspect_ratio: z.string().default('1:1'),
    quality: z.string().default('medium'),
    background: z.string().default('auto'),
    output_format: z
      .string()
      .default('png')
      .refine((val) => ['png', 'webp', 'jpeg', 'jpg'].includes(val), {
        message: 'output_format must be one of: png, webp, jpeg, jpg',
      }),
    output_compression: outputCompressionSchema,
    size: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const selectedModel = data.model || getDefaultModel('IMAGE_GENERATOR');
    const isGptImage = selectedModel.startsWith('gpt-image');
    if (!isGptImage) {
      if (data.quality !== 'medium' || data.background !== 'auto' || data.output_compression !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'quality, background, and output_compression are only supported by gpt-image-* models',
        });
      }
    }
  });

const imageEditorSchema = z
  .object({
    imageUrl: z.preprocess(
      (val) => (val === undefined || val === null ? '' : String(val)),
      z
        .string({ message: 'imageUrl or asset key is required' })
        .refine((val) => val.trim().length > 0, { message: 'imageUrl or asset key is required' }),
    ),
    prompt: z.preprocess(
      (val) => (val === undefined || val === null ? '' : String(val)),
      z
        .string({ message: 'prompt is required' })
        .refine((val) => val.trim().length > 0, { message: 'prompt is required' }),
    ),
    model: z.string().optional(),
    size: z.string().default('1024x1024'),
    quality: z.string().default('medium'),
    n: z.preprocess((val) => (val === undefined ? 1 : Number(val)), z.number().default(1)),
    background: z.string().default('auto'),
    output_format: z.string().default('webp'),
    output_compression: outputCompressionSchema,
  })
  .superRefine((data, ctx) => {
    const selectedModel = data.model || getDefaultModel('IMAGE_EDITOR');
    const isGptImage = selectedModel.startsWith('gpt-image');

    if (isGptImage) {
      const sizeMatch = String(data.size).match(/^(\d+)x(\d+)$/);
      if (!sizeMatch) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'size must be in WxH format (e.g. 1024x1024)',
        });
        return;
      }
      const w = Number(sizeMatch[1]);
      const h = Number(sizeMatch[2]);
      if (w % 16 !== 0 || h % 16 !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'width and height must be divisible by 16',
        });
      }
      if (w * h < 655360 || w * h > 8294400) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'total pixels must be between 655,360 and 8,294,400',
        });
      }
      if (Math.max(w, h) > 3840) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'max edge must be <= 3840px',
        });
      }
      if (Math.max(w, h) / Math.min(w, h) > 3) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'aspect ratio must be <= 3:1',
        });
      }
    } else {
      if (data.size && !/^\d+x\d+$/.test(String(data.size))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'size must be in WxH format (e.g. 1024x1024)',
        });
      }
    }
  });

function aspectRatioToSize(aspectRatio) {
  const map = {
    '1:1': '1024x1024',
    '16:9': '1536x1024',
    '9:16': '1024x1536',
    '4:3': '1280x1024',
    '3:4': '1024x1280',
  };
  return map[aspectRatio] || '1024x1024';
}

router.post('/generate', async (req, res, next) => {
  try {
    const result = imageGenerateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const selectedModel = data.model || getDefaultModel('IMAGE_GENERATOR');
    const isGptImage = selectedModel.startsWith('gpt-image');

    const promptObject = {
      prompt: data.prompt,
    };

    if (isGptImage) {
      promptObject.size = data.size || aspectRatioToSize(data.aspect_ratio);
      promptObject.n = data.num_outputs;
      promptObject.quality = data.quality;
      promptObject.background = data.background;
      promptObject.output_format = data.output_format;
      if (data.output_compression !== undefined) {
        promptObject.output_compression = data.output_compression;
      }
    } else {
      promptObject.num_outputs = data.num_outputs;
      promptObject.aspect_ratio = data.aspect_ratio;
      promptObject.output_format = data.output_format;
    }

    const payload = {
      type: 'IMAGE_GENERATOR',
      model: selectedModel,
      promptObject,
    };
    const dataRes = await callOneMin('/api/features', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
    });
    if (isFailedResponse(dataRes)) {
      throw new HttpError(
        502,
        `1min.ai image generate failed: ${extractFailureMessage(dataRes)}`,
        'UPSTREAM_API_ERROR',
        dataRes,
      );
    }
    res.json(dataRes);
  } catch (err) {
    next(err);
  }
});

router.post('/text-editor', async (req, res, next) => {
  try {
    const result = imageEditorSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const selectedModel = data.model || getDefaultModel('IMAGE_EDITOR');
    const isGptImage = selectedModel.startsWith('gpt-image');

    const promptObject = {
      imageUrl: extractAssetKey(data.imageUrl),
      prompt: data.prompt,
      size: data.size,
      n: data.n,
      output_format: data.output_format,
    };

    if (isGptImage) {
      promptObject.quality = data.quality;
      promptObject.background = data.background;
      if (data.output_compression !== undefined) {
        promptObject.output_compression = data.output_compression;
      }
    }
    const payload = {
      type: 'IMAGE_EDITOR',
      model: selectedModel,
      promptObject,
    };

    const dataRes = await callOneMin('/api/features', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
    });
    if (isFailedResponse(dataRes)) {
      throw new HttpError(
        502,
        `1min.ai image edit failed: ${extractFailureMessage(dataRes)}`,
        'UPSTREAM_API_ERROR',
        dataRes,
      );
    }
    res.json(dataRes);
  } catch (err) {
    next(err);
  }
});

export default router;
