/**
 * 1min.AI image payload construction.
 *
 * Every image feature posts to `/api/features` with `{type, model, promptObject}`.
 * The promptObject shape is model specific (47 generator models, 27 editor
 * models, ...), so it is derived from the docs transcription in
 * config/image-specs/1min.json through services/image-schema.js instead of
 * being hardcoded per model family.
 */
import { invalidRequestError } from '../../utils/errors.js';
import { extractAssetKey } from '../../utils/asset-utils.js';
import {
  describeOneMinParams,
  describeOneMinFeature,
  validateGptImageSize,
  validateParamValues,
} from '../../services/image-schema.js';

const IMAGE_ARRAY_KEYS = new Set([
  'additional_images',
  'style_reference_images',
  'character_reference_images',
  'leonardo_image_prompts',
]);

/** Canonical request field -> promptObject keys, in preference order. */
const CANONICAL_TARGETS = Object.freeze({
  prompt: ['prompt'],
  imageUrl: ['imageUrl', 'image_url', 'image'],
  maskUrl: ['maskUrl', 'mask'],
  num_outputs: ['n', 'num_outputs', 'num_images'],
  aspect_ratio: ['aspect_ratio'],
  size: ['size', 'imageSize'],
  quality: ['quality'],
  background: ['background'],
  output_format: ['output_format', 'format'],
  output_compression: ['output_compression'],
  negative_prompt: ['negativePrompt', 'negative_prompt'],
  seed: ['seed', 'seed_fixed'],
  steps: ['steps', 'num_inference_steps'],
  guidance: ['guidance', 'guidance_scale'],
  speed: ['speed'],
});

/**
 * Values used only for parameters the selected model marks as required.
 * Without them a plain "prompt + model" request would fail upstream for models
 * such as ideogram-4 (rendering_speed) or gpt-image-2 (size/quality).
 */
const REQUIRED_PARAM_DEFAULTS = Object.freeze({
  size: '1024x1024',
  imageSize: '1024x1024',
  width: 1024,
  height: 1024,
  n: 1,
  num_outputs: 1,
  num_images: 1,
  quality: 'medium',
  rendering_speed: 'DEFAULT',
  resolution: '1K',
  output_resolution: '1K',
  aspect_ratio: '1:1',
  output_format: 'png',
  format: 'png',
  style_type: 'AUTO',
});

const ASPECT_RATIO_SIZES = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1280x1024',
  '3:4': '1024x1280',
});

export function aspectRatioToSize(aspectRatio) {
  return ASPECT_RATIO_SIZES[aspectRatio] || '1024x1024';
}

function supportedParamList(descriptors) {
  return descriptors.map((descriptor) => descriptor.key).join(', ');
}

/**
 * Payload shape: the global error handler prefers `payload.message` over the
 * error message when sanitizing, so the human-readable reason must travel with
 * the details.
 */
function invalidParams(message, details = {}) {
  return invalidRequestError(message, 'INVALID_IMAGE_PARAMS', details);
}

function isProvided(value) {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

/**
 * Maps the canonical request envelope onto the model's documented parameters.
 * Unknown-but-model-supported keys can be passed through `extra`.
 *
 * @param {{
 *   feature: string,
 *   model: string,
 *   params: Record<string, unknown>,
 *   extra?: Record<string, unknown>,
 *   requirePrompt?: boolean,
 * }} options
 */
export function buildOneMinImagePayload({ feature, model, params = {}, extra = {}, requirePrompt = false }) {
  const descriptors = describeOneMinParams(feature, model);
  if (descriptors.length === 0) {
    throw invalidRequestError(`${feature} is not supported for model "${model}"`, 'UNSUPPORTED_IMAGE_MODEL', {
      feature,
      model,
    });
  }
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  const values = {};

  for (const [canonicalKey, rawValue] of Object.entries(params)) {
    if (!isProvided(rawValue)) continue;
    const targets = CANONICAL_TARGETS[canonicalKey];
    if (!targets) continue;
    const targetKey = targets.find((key) => byKey.has(key));
    if (targetKey) {
      values[targetKey] = rawValue;
      continue;
    }
    // Backwards compatibility: older clients always send num_outputs and
    // aspect_ratio. Translate them when the model expresses the same idea with
    // size-like parameters instead of rejecting the request.
    if (canonicalKey === 'num_outputs') continue;
    if (canonicalKey === 'aspect_ratio') {
      const sizeKey = ['size', 'imageSize'].find((key) => byKey.has(key));
      if (sizeKey) values[sizeKey] = aspectRatioToSize(String(rawValue));
      continue;
    }
    if (canonicalKey === 'prompt') {
      throw invalidParams(`prompt is not supported by model "${model}"`, {
        model,
        supported: supportedParamList(descriptors),
      });
    }
    throw invalidParams(`${canonicalKey} is not supported by model "${model}"`, {
      model,
      supported: supportedParamList(descriptors),
      parameter: canonicalKey,
    });
  }

  for (const [key, rawValue] of Object.entries(extra || {})) {
    if (!isProvided(rawValue)) continue;
    if (!byKey.has(key)) {
      throw invalidParams(`${key} is not a supported parameter for model "${model}"`, {
        model,
        supported: supportedParamList(descriptors),
        parameter: key,
      });
    }
    values[key] = rawValue;
  }

  for (const descriptor of descriptors) {
    if (!descriptor.required) continue;
    if (isProvided(values[descriptor.key])) continue;
    if (typeof descriptor.default !== 'undefined') {
      values[descriptor.key] = descriptor.default;
      continue;
    }
    if (descriptor.key in REQUIRED_PARAM_DEFAULTS) {
      values[descriptor.key] = REQUIRED_PARAM_DEFAULTS[descriptor.key];
    }
  }

  if (requirePrompt && !isProvided(values.prompt)) {
    throw invalidParams('prompt is required', { model, parameter: 'prompt' });
  }

  // Unwrap local BFF proxy URLs or 1min S3 URLs on all image-typed parameters
  // (including dynamic model fields such as swapImageUrl, targetImageUrl, maskUrl,
  // referenceImage1, and image-array parameters).
  for (const descriptor of descriptors) {
    if (!(descriptor.key in values)) continue;
    if (descriptor.type === 'image' && typeof values[descriptor.key] === 'string') {
      values[descriptor.key] = extractAssetKey(values[descriptor.key].trim());
    } else if (descriptor.type === 'array' && IMAGE_ARRAY_KEYS.has(descriptor.key)) {
      if (Array.isArray(values[descriptor.key])) {
        values[descriptor.key] = values[descriptor.key].map((item) =>
          typeof item === 'string' ? extractAssetKey(item.trim()) : item,
        );
      } else if (typeof values[descriptor.key] === 'string') {
        values[descriptor.key] = values[descriptor.key]
          .split(/[\n,]/)
          .map((item) => extractAssetKey(item.trim()))
          .filter(Boolean);
      }
    }
  }

  // Validate the gpt-image dimension rules first so their specific messages win
  // over the generic WxH pattern check.
  if (String(model).startsWith('gpt-image') && isProvided(values.size)) {
    const sizeError = validateGptImageSize(String(values.size));
    if (sizeError) {
      throw invalidParams(sizeError, { model, parameter: 'size', value: values.size });
    }
  }

  const { values: clean, issues } = validateParamValues(descriptors, values);
  if (issues.length > 0) {
    throw invalidParams(issues[0], {
      model,
      issues,
      supported: supportedParamList(descriptors),
    });
  }

  // output_compression is only honoured for jpeg/webp output.
  if (isProvided(clean.output_compression)) {
    const format = String(clean.output_format || clean.format || '').toLowerCase();
    if (format && format !== 'jpeg' && format !== 'jpg' && format !== 'webp') {
      delete clean.output_compression;
    }
  }

  const promptObject = {};
  for (const descriptor of descriptors) {
    if (!isProvided(clean[descriptor.key])) continue;
    promptObject[descriptor.key] = clean[descriptor.key];
  }

  return promptObject;
}

/**
 * Describes a feature/model pair for the capabilities endpoint.
 */
export function describeOneMinImage(feature, model) {
  return describeOneMinFeature(feature, model);
}
