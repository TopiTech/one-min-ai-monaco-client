/**
 * Provider-agnostic description and validation of image-generation payloads.
 *
 * Two sources feed it:
 * - 1min.AI: the per-model promptObject transcription in
 *   config/image-specs/1min.json (regenerated from the public docs by
 *   scripts/sync-image-specs.js) plus hand-verified UI metadata in
 *   config/image-specs/1min-overrides.json.
 * - 1forall.ai: the live model catalog (`GET /v1/external/image/models/`),
 *   whose `sizes` and `additional_fields` already describe every parameter.
 *
 * The route layer only ever sees normalized descriptors, so adding a model
 * upstream does not require touching the request handlers.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPEC_DIR = path.resolve(__dirname, '..', 'config', 'image-specs');

const ONE_MIN_SPEC = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, '1min.json'), 'utf8'));
const ONE_MIN_OVERRIDES = JSON.parse(fs.readFileSync(path.join(SPEC_DIR, '1min-overrides.json'), 'utf8'));

const IMAGE_REF_PATTERN =
  /(?:^|[_-])(?:image|mask)(?:[_-]?(?:url|path|reference|prompt)s?)?\d*$|^(?:swap|target|reference)image(?:url)?\d*$|^(?:character|style|omni)_reference$/i;
const DEFAULT_PROMPT_MAX_LENGTH = 5000;
const DEFAULT_REF_MAX_LENGTH = 4096;

export const IMAGE_FEATURE_TYPES = Object.freeze(
  Object.keys(ONE_MIN_SPEC.features).sort((a, b) => a.localeCompare(b)),
);

const FEATURE_PARAM_DEFAULTS = Object.freeze({
  IMAGE_GENERATOR: 'IMAGE_GENERATOR',
  IMAGE_EDITOR: 'IMAGE_EDITOR',
});

function humanizeKey(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function inferUiType(param) {
  const rawType = String(param.type || 'string').toLowerCase();
  const meta = ONE_MIN_OVERRIDES.paramMeta?.[param.name] || {};
  if (meta.ui) return meta.ui;
  if (rawType === 'boolean') return 'boolean';
  if (rawType === 'number' || rawType === 'integer' || rawType === 'float' || rawType === 'double') {
    return 'number';
  }
  if (rawType === 'array' || rawType.includes('[]')) return 'array';
  if (IMAGE_REF_PATTERN.test(param.name)) return 'image';
  return 'text';
}

/**
 * @typedef {Object} ImageParamDescriptor
 * @property {string} key
 * @property {'select'|'number'|'boolean'|'text'|'image'|'array'} type
 * @property {boolean} required
 * @property {string|null} labelKey
 * @property {string} label
 * @property {string} group
 * @property {string} description
 * @property {number} [min]
 * @property {number} [max]
 * @property {number} [step]
 * @property {boolean} [integer]
 * @property {Array<string|number>} [options]
 * @property {boolean} [allowOther]
 * @property {Array<string>} [presets]
 * @property {string} [pattern]
 * @property {boolean} [multiline]
 * @property {boolean} [multiple]
 * @property {*} [default]
 */

/**
 * @param {{ key: string, source: Record<string, any>, meta?: Record<string, any>, fallbackDescription?: string }} input
 * @returns {ImageParamDescriptor}
 */
function buildDescriptor({ key, source, meta = {}, fallbackDescription = '' }) {
  const ui = meta.ui || inferUiType(source);
  /** @type {ImageParamDescriptor} */
  const descriptor = {
    key,
    type: ui,
    required: Boolean(source.required),
    labelKey: meta.labelKey || null,
    label: humanizeKey(key),
    group: meta.group || 'advanced',
    description: source.description || fallbackDescription || '',
  };

  const min = meta.min !== undefined ? meta.min : source.min;
  const max = meta.max !== undefined ? meta.max : source.max;
  if (ui === 'number') {
    if (Number.isFinite(Number(min))) descriptor.min = Number(min);
    if (Number.isFinite(Number(max))) descriptor.max = Number(max);
    descriptor.step =
      meta.step !== undefined ? meta.step : Number.isInteger(source.step) ? source.step : undefined;
    if (descriptor.step === undefined) {
      descriptor.step = min !== undefined || max !== undefined ? 1 : undefined;
    }
    const rawType = String(source.type || '').toLowerCase();
    descriptor.integer = Boolean(meta.integer) || rawType === 'integer' || descriptor.step === 1;
  }

  if (ui === 'select' && Array.isArray(meta.options) && meta.options.length > 0) {
    descriptor.options = [...meta.options];
    descriptor.allowOther = Boolean(meta.allowOther);
  }
  if (ui === 'text' && Array.isArray(meta.presets)) {
    descriptor.presets = [...meta.presets];
  }
  if (ui === 'text' && meta.pattern) {
    descriptor.pattern = meta.pattern;
  }
  if (meta.multiline) descriptor.multiline = true;
  if (ui === 'array') descriptor.multiple = true;

  const defaultValue = source.default ?? meta.default;
  if (defaultValue !== undefined && defaultValue !== '' && defaultValue !== '-') {
    descriptor.default = defaultValue;
  }
  return descriptor;
}

function getFeatureSpec(feature) {
  const normalized = String(feature || '').toUpperCase();
  return ONE_MIN_SPEC.features[normalized] || null;
}

/** All 1min image feature types, with their model counts. */
export function listOneMinImageFeatures() {
  return IMAGE_FEATURE_TYPES.map((feature) => ({
    feature,
    labelKey: ONE_MIN_OVERRIDES.featureMeta?.[feature]?.labelKey || null,
    group: ONE_MIN_OVERRIDES.featureMeta?.[feature]?.group || 'generation',
    modelCount: Object.keys(getFeatureSpec(feature)?.models || {}).length,
  }));
}

/** Model ids documented for a feature type (docs order). */
export function listOneMinImageModels(feature) {
  const spec = getFeatureSpec(feature);
  if (!spec) return [];
  return Object.keys(spec.models);
}

/**
 * Chooses a supported model for a feature: the requested one when the docs
 * describe it, otherwise the first documented model.
 */
export function pickOneMinModel(feature, requestedModel) {
  const models = listOneMinImageModels(feature);
  if (requestedModel && models.includes(requestedModel)) return requestedModel;
  return models[0] || requestedModel || null;
}

function getOneMinModelParams(feature, model) {
  const normalizedFeature = String(feature || '').toUpperCase();
  const spec = getFeatureSpec(normalizedFeature);
  const documented = spec?.models?.[model]?.params;
  if (Array.isArray(documented) && documented.length > 0) return documented;
  return ONE_MIN_OVERRIDES.modelParams?.[`${normalizedFeature}:${model}`] || [];
}

/** Normalized parameter descriptors for a 1min feature/model pair. */
export function describeOneMinParams(feature, model) {
  const params = getOneMinModelParams(feature, model);
  return params.map((param) =>
    buildDescriptor({
      key: param.name,
      source: param,
      meta: ONE_MIN_OVERRIDES.paramMeta?.[param.name] || {},
    }),
  );
}

export function describeOneMinFeature(feature, model) {
  const normalizedFeature = String(feature || '').toUpperCase();
  const meta = ONE_MIN_OVERRIDES.featureMeta?.[normalizedFeature] || {};
  const models = listOneMinImageModels(normalizedFeature);
  return {
    provider: '1min',
    feature: normalizedFeature,
    labelKey: meta.labelKey || null,
    group: meta.group || 'generation',
    promptParam: meta.promptParam || null,
    model,
    models,
    params: describeOneMinParams(normalizedFeature, model),
  };
}

function toNumberOrUndefined(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function splitOptions(raw) {
  return String(raw || '')
    .split(',')
    .map((option) => option.trim())
    .filter(Boolean);
}

function mapOneForAllFieldType(field) {
  const raw = String(field?.type || '').toUpperCase();
  if (raw === 'BOOLEAN') return 'boolean';
  if (raw === 'SELECT' || raw === 'SELECT_INTEGER') return 'select';
  if (raw === 'SLIDER' || raw === 'INTEGER' || raw === 'NUMBER' || raw === 'FLOAT') return 'number';
  if (raw === 'IMAGE') return 'image';
  if (raw === 'ARRAY') return 'array';
  return 'text';
}

/**
 * Reads the image-specific catalog metadata. Normalized models keep it under
 * `meta` (config/models.js), while a raw catalog entry carries it at the top
 * level; both shapes are accepted.
 */
export function getCatalogImageFields(entry) {
  const sizes = Array.isArray(entry?.sizes)
    ? entry.sizes
    : Array.isArray(entry?.meta?.sizes)
      ? entry.meta.sizes
      : [];
  const additionalFields = Array.isArray(entry?.additionalFields)
    ? entry.additionalFields
    : Array.isArray(entry?.meta?.additionalFields)
      ? entry.meta.additionalFields
      : Array.isArray(entry?.additional_fields)
        ? entry.additional_fields
        : [];
  return {
    sizes,
    additionalFields,
    mode: entry?.mode || entry?.meta?.mode || null,
  };
}

/**
 * Normalizes a 1forall catalog entry (`sizes` + `additional_fields`) into the
 * same descriptor shape used for 1min, so both providers share one UI.
 */
export function describeOneForAllParams(entry) {
  const { additionalFields } = getCatalogImageFields(entry);
  return additionalFields
    .filter((field) => field?.code && field.enabled !== false)
    .map((field) => {
      const type = mapOneForAllFieldType(field);
      const rawItemType = field?.items_type ?? field?.itemsType;
      const itemType =
        type === 'array' && typeof rawItemType === 'string' && rawItemType.trim()
          ? rawItemType.trim().toLowerCase()
          : undefined;
      /** @type {Record<string, any>} */
      const descriptor = {
        key: field.code,
        type,
        ...(itemType ? { itemType } : {}),
        required: Boolean(field.required),
        labelKey: null,
        label: field.name || humanizeKey(field.code),
        group: type === 'number' || type === 'boolean' ? 'advanced' : 'output',
        description: field.description || '',
      };
      if (type === 'select') {
        descriptor.options = splitOptions(field.options);
        descriptor.allowOther = descriptor.options.length === 0;
      }
      if (type === 'number') {
        const min = toNumberOrUndefined(field.min);
        const max = toNumberOrUndefined(field.max);
        const step = toNumberOrUndefined(field.step);
        if (min !== undefined) descriptor.min = min;
        if (max !== undefined) descriptor.max = max;
        descriptor.step = step !== undefined ? step : 1;
        descriptor.integer = descriptor.step === 1;
      }
      if (field.default_value !== undefined && field.default_value !== null && field.default_value !== '') {
        descriptor.default = /^-?\d+(?:\.\d+)?$/.test(String(field.default_value))
          ? Number(field.default_value)
          : field.default_value;
      }
      return descriptor;
    });
}

/** Size codes a 1forall model accepts (empty when the catalog has none). */
export function describeOneForAllSizes(entry) {
  const { sizes } = getCatalogImageFields(entry);
  return sizes
    .filter((size) => size?.code && size.enabled !== false)
    .map((size) => ({
      code: size.code,
      label: size.name || size.code,
      ratio: size.ratio || size.code,
      default: Boolean(size.default),
    }));
}

export function describeOneForAllImage(entry, model) {
  const { mode } = getCatalogImageFields(entry);
  return {
    provider: '1forall',
    feature: mode === 'IMAGE_TO_IMAGE' ? 'IMAGE_EDITOR' : 'IMAGE_GENERATOR',
    labelKey: null,
    group: 'generation',
    promptParam: null,
    model,
    mode,
    sizes: describeOneForAllSizes(entry),
    params: describeOneForAllParams(entry),
  };
}

/**
 * GPT Image (gpt-image-*) accepts arbitrary dimensions within strict bounds:
 * both sides divisible by 16, 655,360-8,294,400 total pixels, longest edge
 * <= 3840 and aspect ratio <= 3:1.
 *
 * @param {string} size
 * @returns {string|null} error message, or null when valid
 */
export function validateGptImageSize(size) {
  const match = String(size || '').match(/^(\d+)x(\d+)$/);
  if (!match) return 'size must be in WxH format (e.g. 1024x1024)';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'size must be positive integers in WxH format';
  }
  if (width % 16 !== 0 || height % 16 !== 0) {
    return 'width and height must be divisible by 16';
  }
  const pixels = width * height;
  if (pixels < 655360 || pixels > 8294400) {
    return 'total pixels must be between 655,360 and 8,294,400';
  }
  if (Math.max(width, height) > 3840) {
    return 'max edge must be <= 3840px';
  }
  if (Math.max(width, height) / Math.min(width, height) > 3) {
    return 'aspect ratio must be <= 3:1';
  }
  return null;
}

function coerceSingleValue(descriptor, raw) {
  const { key, type } = descriptor;
  if (raw === undefined || raw === null || raw === '') {
    if (descriptor.required) return { issue: `${key} is required` };
    return { skip: true };
  }

  if (type === 'number') {
    const num = Number(raw);
    if (!Number.isFinite(num)) return { issue: `${key} must be a finite number` };
    if (descriptor.integer && !Number.isInteger(num)) return { issue: `${key} must be an integer` };
    if (descriptor.min !== undefined && num < descriptor.min) {
      return { issue: `${key} must be >= ${descriptor.min}` };
    }
    if (descriptor.max !== undefined && num > descriptor.max) {
      return { issue: `${key} must be <= ${descriptor.max}` };
    }
    return { value: num };
  }

  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { value: raw };
    if (raw === 1 || raw === '1' || raw === 'true') return { value: true };
    if (raw === 0 || raw === '0' || raw === 'false') return { value: false };
    return { issue: `${key} must be a boolean` };
  }

  if (type === 'image') {
    const value = String(raw).trim();
    if (!value) return { issue: `${key} must be a non-empty image reference` };
    if (value.length > DEFAULT_REF_MAX_LENGTH) {
      return { issue: `${key} exceeds ${DEFAULT_REF_MAX_LENGTH} characters` };
    }
    return { value };
  }

  if (type === 'array') {
    const rawItems = Array.isArray(raw)
      ? raw
      : String(raw)
          .split(/[\n,]/)
          .map((item) => item.trim())
          .filter(Boolean);
    const list = [];
    for (const item of rawItems) {
      if (item === undefined || item === null) continue;
      if (typeof item === 'object') {
        return { issue: `${key} entries must be primitive strings or numbers` };
      }
      const trimmed = String(item).trim();
      if (!trimmed) continue;
      if (trimmed.length > DEFAULT_REF_MAX_LENGTH) {
        return { issue: `${key} entries exceed ${DEFAULT_REF_MAX_LENGTH} characters` };
      }
      list.push(trimmed);
    }
    if (list.length > 32) {
      return { issue: `${key} exceeds maximum of 32 items` };
    }
    if (list.length === 0) {
      if (descriptor.required) return { issue: `${key} requires at least one value` };
      return { skip: true };
    }
    return { value: list };
  }

  if (type === 'select') {
    const value = String(raw).trim();
    if (Array.isArray(descriptor.options) && descriptor.options.length > 0) {
      const match = descriptor.options.find((option) => String(option) === value);
      if (!match && !descriptor.allowOther) {
        return { issue: `${key} must be one of: ${descriptor.options.join(', ')}` };
      }
    }
    return { value };
  }

  const value = String(raw).trim();
  const maxLength = key === 'prompt' ? DEFAULT_PROMPT_MAX_LENGTH : DEFAULT_REF_MAX_LENGTH;
  if (value.length > maxLength) return { issue: `${key} exceeds ${maxLength} characters` };
  if (descriptor.pattern && !new RegExp(descriptor.pattern).test(value)) {
    return { issue: `${key} must match ${descriptor.pattern}` };
  }
  return { value };
}

/**
 * Validates and coerces `values` against `descriptors`, dropping unknown keys.
 * Unknown keys are reported so a caller can decide between 400 and ignore.
 *
 * @param {Array<ReturnType<typeof buildDescriptor>>} descriptors
 * @param {Record<string, unknown>} values
 * @param {{ rejectUnknown?: boolean }} [options]
 */
export function validateParamValues(descriptors, values = {}, { rejectUnknown = false } = {}) {
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  const issues = [];
  const clean = {};

  for (const [key, raw] of Object.entries(values || {})) {
    const descriptor = byKey.get(key);
    if (!descriptor) {
      if (rejectUnknown) issues.push(`${key} is not a supported parameter for this model`);
      continue;
    }
    const result = coerceSingleValue(descriptor, raw);
    if (result.issue) {
      issues.push(result.issue);
      continue;
    }
    if (result.skip) continue;
    clean[key] = result.value;
  }

  for (const descriptor of descriptors) {
    if (!descriptor.required) continue;
    if (clean[descriptor.key] !== undefined) continue;
    if (values?.[descriptor.key] !== undefined) continue;
    // Required-but-missing is reported once, not per descriptor copy.
    if (!issues.some((issue) => issue.startsWith(`${descriptor.key} `))) {
      issues.push(`${descriptor.key} is required`);
    }
  }

  return { values: clean, issues };
}

export const IMAGE_FEATURE_DEFAULTS = FEATURE_PARAM_DEFAULTS;
