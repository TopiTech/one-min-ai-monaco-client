import express from 'express';
import { z } from 'zod';
import { callOneMin, isFailedResponse, extractFailureMessage } from '../../utils/api-client.js';
import { isPendingStatusResponse } from '../../utils/http-client.js';
import { HttpError, invalidRequestError } from '../../utils/errors.js';
import { extractAssetKey } from '../../utils/asset-utils.js';
import { assertCapability, getProvider, resolveProviderId } from '../../providers/index.js';
import { serverConfig } from '../../config/server.js';
import { getOneForAllImageModel } from '../../config/models.js';
import {
  IMAGE_FEATURE_TYPES,
  describeOneForAllImage,
  getCatalogImageFields,
  listOneMinImageFeatures,
  listOneMinImageModels,
} from '../../services/image-schema.js';
import { buildOneMinImagePayload, describeOneMinImage } from '../../providers/one-min/images.js';
import {
  bindRequestAbortSignal,
  getDefaultModel,
  optionalNumberInput,
  outputCompressionSchema,
} from './utils.js';

const router = express.Router();

const IMAGE_PROMPT_MAX_LENGTH = 50_000;
const IMAGE_REFERENCE_MAX_LENGTH = 4096;
const IMAGE_MODEL_MAX_LENGTH = 200;
const IMAGE_SIZE_MAX_LENGTH = 32;
const IMAGE_OPTION_MAX_LENGTH = 32;

const imagePromptSchema = z
  .string({ message: 'prompt is required' })
  .max(IMAGE_PROMPT_MAX_LENGTH, `prompt exceeds ${IMAGE_PROMPT_MAX_LENGTH} characters`)
  .refine((val) => val.trim().length > 0, { message: 'prompt is required' });

const optionalPromptSchema = z.preprocess(
  (val) => (val === undefined || val === null ? undefined : String(val)),
  imagePromptSchema.optional(),
);

const imageCountSchema = z
  .number()
  .int('image count must be an integer')
  .min(1, 'image count must be between 1 and 10')
  .max(10, 'image count must be between 1 and 10');

const imageReferenceSchema = z
  .string({ message: 'imageUrl or asset key is required' })
  .max(IMAGE_REFERENCE_MAX_LENGTH, `imageUrl exceeds ${IMAGE_REFERENCE_MAX_LENGTH} characters`)
  .refine((val) => val.trim().length > 0, { message: 'imageUrl or asset key is required' });

const optionalReferenceSchema = z.preprocess(
  (val) => (val === undefined || val === null ? undefined : String(val)),
  imageReferenceSchema.optional(),
);

const outputFormatSchema = z
  .string()
  .max(IMAGE_OPTION_MAX_LENGTH)
  .refine((val) => ['png', 'webp', 'jpeg', 'jpg'].includes(val), {
    message: 'output_format must be one of: png, webp, jpeg, jpg',
  });

const finiteNumberInput = optionalNumberInput(z.number().finite().optional());

/**
 * Fields shared by every image request. Model-specific options are accepted
 * through `params` and validated against the model's documented shape.
 */
const imageEnvelope = {
  provider: z.enum(['1min', '1forall']).optional(),
  async: z.boolean().optional(),
  prompt: optionalPromptSchema,
  model: z.string().max(IMAGE_MODEL_MAX_LENGTH, 'model is too long').optional(),
  num_outputs: optionalNumberInput(imageCountSchema.optional()),
  n: optionalNumberInput(imageCountSchema.optional()),
  aspect_ratio: z.string().max(IMAGE_OPTION_MAX_LENGTH).optional(),
  size: z.string().max(IMAGE_SIZE_MAX_LENGTH, 'size is too long').optional(),
  quality: z.string().max(IMAGE_OPTION_MAX_LENGTH).optional(),
  background: z.string().max(IMAGE_OPTION_MAX_LENGTH).optional(),
  output_format: outputFormatSchema.optional(),
  output_compression: outputCompressionSchema,
  negative_prompt: z.string().max(IMAGE_REFERENCE_MAX_LENGTH).optional(),
  seed: finiteNumberInput,
  steps: finiteNumberInput,
  guidance: finiteNumberInput,
  speed: finiteNumberInput,
  params: z.record(z.string(), z.unknown()).optional(),
};

const imageGenerateSchema = z.object({
  ...imageEnvelope,
  prompt: imagePromptSchema,
});

const imageEditorSchema = z.object({
  ...imageEnvelope,
  prompt: imagePromptSchema,
  imageUrl: imageReferenceSchema,
  maskUrl: optionalReferenceSchema,
});

const imageFeatureSchema = z
  .object({
    ...imageEnvelope,
    feature: z.enum(IMAGE_FEATURE_TYPES),
    imageUrl: optionalReferenceSchema,
    maskUrl: optionalReferenceSchema,
  })
  .refine((data) => data.feature !== 'IMAGE_GENERATOR', {
    message: 'use /api/images/generate for IMAGE_GENERATOR',
    path: ['feature'],
  })
  .refine((data) => data.feature !== 'IMAGE_EDITOR', {
    message: 'use /api/images/text-editor for IMAGE_EDITOR',
    path: ['feature'],
  });

/**
 * Collects the canonical (provider-agnostic) request fields. Undefined values
 * are dropped later by the payload builders, so a model never receives a
 * parameter it does not declare.
 */
function canonicalParams(data, extra = {}) {
  return {
    prompt: data.prompt,
    num_outputs: data.num_outputs ?? data.n,
    aspect_ratio: data.aspect_ratio,
    size: data.size,
    quality: data.quality,
    background: data.background,
    output_format: data.output_format,
    output_compression: data.output_compression,
    negative_prompt: data.negative_prompt,
    seed: data.seed,
    steps: data.steps,
    guidance: data.guidance,
    speed: data.speed,
    ...extra,
  };
}

function validationError(result) {
  return new HttpError(400, result.error.issues[0]?.message || 'Validation error', 'INVALID_REQUEST');
}

/**
 * Resolves the model for a feature, rejecting an explicit request for a model
 * the docs do not list for that feature (e.g. a generator model sent to the
 * inpainter) instead of silently switching models.
 */
function resolveOneMinModel(feature, requestedModel, fallbackModel) {
  const supported = listOneMinImageModels(feature);
  const candidate = requestedModel || fallbackModel;
  if (candidate && supported.includes(candidate)) return candidate;
  if (requestedModel) {
    throw invalidRequestError(
      `model "${requestedModel}" does not support ${feature}`,
      'UNSUPPORTED_IMAGE_MODEL',
      { feature, supported },
    );
  }
  if (supported.length === 0) {
    throw new HttpError(400, `No 1min.ai model available for ${feature}`, 'INVALID_IMAGE_FEATURE');
  }
  return supported[0];
}

async function callOneMinFeature({ feature, model, promptObject, useAsync, signal }) {
  const payload = {
    type: feature,
    model,
    ...(useAsync ? { async: true } : {}),
    promptObject,
  };
  const dataRes = await callOneMin('/api/features', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    idempotent: false,
    signal,
  });
  if (isFailedResponse(dataRes)) {
    throw new HttpError(
      502,
      `1min.ai ${feature.toLowerCase()} failed: ${extractFailureMessage(dataRes)}`,
      'UPSTREAM_API_ERROR',
      dataRes,
    );
  }
  if (isPendingStatusResponse(dataRes) && dataRes?.aiRecord?.uuid) {
    return {
      ...dataRes,
      status: 'PROCESSING',
      jobId: dataRes.aiRecord.uuid,
      provider: '1min',
      kind: 'image',
      model,
    };
  }
  return dataRes;
}

function assertOneForAllEditorEntry(entry, model) {
  const { mode } = getCatalogImageFields(entry);
  if (mode && mode !== 'IMAGE_TO_IMAGE') {
    throw invalidRequestError(
      `1forall.ai model "${model}" does not support image editing (mode: ${mode})`,
      'UNSUPPORTED_IMAGE_MODEL',
      { model, mode },
    );
  }
}

/**
 * Describes the parameters a provider/model pair accepts, so the UI can render
 * model-specific controls instead of a fixed form.
 */
router.get('/capabilities', (req, res, next) => {
  try {
    const providerId = resolveProviderId(req.query.provider);
    const requestedFeature =
      typeof req.query.feature === 'string' && req.query.feature.trim()
        ? req.query.feature.trim().toUpperCase()
        : null;
    const requestedModel =
      typeof req.query.model === 'string' && req.query.model.trim()
        ? req.query.model.trim().slice(0, IMAGE_MODEL_MAX_LENGTH)
        : null;

    if (providerId === '1forall') {
      const model = requestedModel || serverConfig.defaultImageModel1ForAll;
      const entry = getOneForAllImageModel(model);
      return res.json(describeOneForAllImage(entry, model));
    }

    const feature = requestedFeature || 'IMAGE_GENERATOR';
    if (!IMAGE_FEATURE_TYPES.includes(feature)) {
      throw new HttpError(400, `Unknown image feature "${feature}"`, 'INVALID_IMAGE_FEATURE');
    }
    const fallbackModel =
      feature === 'IMAGE_GENERATOR'
        ? getDefaultModel('IMAGE_GENERATOR')
        : feature === 'IMAGE_EDITOR'
          ? getDefaultModel('IMAGE_EDITOR')
          : undefined;
    const model = resolveOneMinModel(feature, requestedModel, fallbackModel);
    const { models, ...rest } = describeOneMinImage(feature, model);
    return res.json({ ...rest, models, features: listOneMinImageFeatures() });
  } catch (err) {
    next(err);
  }
});

router.post('/generate', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const parsed = imageGenerateSchema.safeParse(req.body);
    if (!parsed.success) {
      const errorMsg = parsed.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }
    const data = parsed.data;
    const providerId = resolveProviderId(data.provider);
    const params = canonicalParams(data);

    if (providerId === '1forall') {
      const provider = getProvider('1forall');
      const model = data.model || serverConfig.defaultImageModel1ForAll;
      const entry = getOneForAllImageModel(model);
      const resData = await provider.generateImage({
        prompt: data.prompt,
        model,
        entry,
        params,
        extra: data.params,
        async: data.async,
        signal: controller.signal,
      });
      return res.json(resData);
    }

    const model = resolveOneMinModel('IMAGE_GENERATOR', data.model, getDefaultModel('IMAGE_GENERATOR'));
    const promptObject = buildOneMinImagePayload({
      feature: 'IMAGE_GENERATOR',
      model,
      params,
      extra: data.params,
      requirePrompt: true,
    });
    const dataRes = await callOneMinFeature({
      feature: 'IMAGE_GENERATOR',
      model,
      promptObject,
      useAsync: data.async,
      signal: controller.signal,
    });
    res.json(dataRes);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

router.post('/text-editor', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const parsed = imageEditorSchema.safeParse(req.body);
    if (!parsed.success) {
      const errorMsg = parsed.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }
    const data = parsed.data;
    const providerId = resolveProviderId(data.provider);
    assertCapability(providerId, 'imageEdit', 'Image editing');

    if (providerId === '1forall') {
      const provider = getProvider('1forall');
      const model = data.model || serverConfig.defaultImageEditorModel1ForAll;
      const entry = getOneForAllImageModel(model);
      assertOneForAllEditorEntry(entry, model);
      const resData = await provider.editImage({
        imageUrl: data.imageUrl,
        prompt: data.prompt,
        model,
        entry,
        params: canonicalParams(data),
        extra: data.params,
        signal: controller.signal,
      });
      return res.json(resData);
    }

    const model = resolveOneMinModel('IMAGE_EDITOR', data.model, getDefaultModel('IMAGE_EDITOR'));
    const promptObject = buildOneMinImagePayload({
      feature: 'IMAGE_EDITOR',
      model,
      params: canonicalParams(data, {
        imageUrl: extractAssetKey(data.imageUrl),
        ...(data.maskUrl ? { maskUrl: extractAssetKey(data.maskUrl) } : {}),
      }),
      extra: data.params,
      requirePrompt: true,
    });
    const dataRes = await callOneMinFeature({
      feature: 'IMAGE_EDITOR',
      model,
      promptObject,
      useAsync: data.async,
      signal: controller.signal,
    });
    res.json(dataRes);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

/**
 * Generic entry point for the remaining 1min.ai image features
 * (IMAGE_INPAINTER, IMAGE_VARIATOR, IMAGE_UPSCALER, BACKGROUND_REMOVER, ...).
 * The payload is validated against the model's documented parameter table.
 */
router.post('/feature', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const parsed = imageFeatureSchema.safeParse(req.body);
    if (!parsed.success) {
      return next(validationError(parsed));
    }
    const data = parsed.data;
    const providerId = resolveProviderId(data.provider);
    if (providerId !== '1min') {
      throw new HttpError(
        400,
        `${data.feature} is not supported by provider "1forall"`,
        'UNSUPPORTED_FOR_PROVIDER',
      );
    }
    assertCapability(providerId, 'imageGeneration', 'Image features');

    const model = resolveOneMinModel(data.feature, data.model, undefined);
    const promptObject = buildOneMinImagePayload({
      feature: data.feature,
      model,
      params: canonicalParams(data, {
        ...(data.imageUrl ? { imageUrl: extractAssetKey(data.imageUrl) } : {}),
        ...(data.maskUrl ? { maskUrl: extractAssetKey(data.maskUrl) } : {}),
      }),
      extra: data.params,
      requirePrompt: false,
    });
    const dataRes = await callOneMinFeature({
      feature: data.feature,
      model,
      promptObject,
      useAsync: data.async,
      signal: controller.signal,
    });
    res.json(dataRes);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

export default router;
