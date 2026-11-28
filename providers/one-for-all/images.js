/**
 * 1forall.ai image payload construction and asset hand-off.
 *
 * The native API is asynchronous (`code_ref` + `check-status`) and expects
 * `additional_fields` values that the model catalog documents per model.
 * The OpenAI-compatible `/v1/images/generations` route is synchronous and takes
 * a pixel size plus `n` (1..4).
 */
import { serverConfig } from '../../config/server.js';
import { HttpError, invalidRequestError } from '../../utils/errors.js';
import { isTrustedAssetUrl } from '../../services/asset-proxy.js';
import { describeOneForAllParams, getCatalogImageFields, validateParamValues } from '../../services/image-schema.js';
import { unwrapAssetProxyUrl } from '../../utils/asset-utils.js';
import { callOneForAll } from './client.js';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_PROMPT_LENGTH = 5000;
const MAX_TITLE_LENGTH = 100;

/** Ratio code -> pixel size used by the OpenAI-compatible endpoint. */
const RATIO_TO_PIXELS = Object.freeze({
  '1:1': '1024x1024',
  '16:9': '1792x1024',
  '9:16': '1024x1792',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '4:3': '1280x1024',
  '3:4': '1024x1280',
  '4:5': '1024x1280',
  '5:4': '1280x1024',
  '21:9': '1792x768',
  '9:21': '768x1792',
});

/** Canonical request field -> catalog `additional_fields` keys. */
const CANONICAL_TARGETS = Object.freeze({
  output_format: ['output_format', 'format'],
  quality: ['quality', 'output_quality'],
  output_quality: ['output_quality', 'quality'],
  negative_prompt: ['negative_prompt', 'negativePrompt'],
  seed: ['seed'],
  steps: ['steps', 'num_inference_steps'],
  guidance: ['guidance', 'guidance_scale'],
  num_outputs: ['num_outputs', 'n'],
});

export function buildOneForAllTitle(prompt, fallback = 'AI Generation') {
  if (typeof prompt !== 'string') return fallback;
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  // eslint-disable-next-line no-control-regex
  const clean = firstLine.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  const title = clean ? clean.slice(0, 80) : fallback;
  return title.slice(0, MAX_TITLE_LENGTH);
}

function clampPrompt(prompt) {
  return String(prompt ?? '').slice(0, MAX_PROMPT_LENGTH);
}

/**
 * True when the URL is already stored for the 1forall account, i.e. usable as
 * `file_reference` without re-uploading.
 */
export function isOneForAllOwnedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const apiHost = new URL(serverConfig.oneForAllApiBaseUrl).hostname;
  if (parsed.hostname === apiHost) return true;
  const buckets = Array.isArray(serverConfig.oneForAllS3Buckets) ? serverConfig.oneForAllS3Buckets : [];
  return buckets.some((bucket) => {
    if (!bucket) return false;
    const escaped = bucket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    return (
      parsed.hostname === bucket ||
      new RegExp(`^${escaped}\\.s3(?:[.-][\\w-]+)?\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
      (/^s3(?:[.-][\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) &&
        (parsed.pathname === `/${bucket}` || parsed.pathname.startsWith(`/${bucket}/`)))
    );
  });
}

/** Resolves a bare asset key or proxy URL into an absolute upstream URL. */
export function resolveOneForAllImageSource(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  const unwrapped = unwrapAssetProxyUrl(rawUrl.trim());
  if (/^https?:\/\//i.test(unwrapped) || unwrapped.startsWith('data:')) return unwrapped;
  const base = serverConfig.assetBaseUrl.replace(/\/$/, '');
  return `${base}/${unwrapped.replace(/^\//, '')}`;
}

function decodeDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new HttpError(413, 'image payload is too large to upload', 'IMAGE_TOO_LARGE');
  }
  return new Blob([buffer], { type: match[1] });
}

/**
 * Downloads an image so it can be re-uploaded to the 1forall library.
 * Hosts are restricted to the same allowlist the asset proxy uses (SSRF guard).
 *
 * @param {string} rawUrl
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Blob>}
 */
export async function downloadImageForUpload(rawUrl, { signal } = {}) {
  if (rawUrl.startsWith('data:')) {
    const blob = decodeDataUrl(rawUrl);
    if (!blob) throw new HttpError(400, 'unsupported data URI for image upload', 'INVALID_IMAGE_URL');
    return blob;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new HttpError(400, 'imageUrl must be an absolute URL or asset key', 'INVALID_IMAGE_URL');
  }
  if (!isTrustedAssetUrl(parsed)) {
    throw new HttpError(400, `imageUrl host is not allowed: ${parsed.hostname}`, 'INVALID_IMAGE_URL');
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'image/*' },
    });
    if (!response.ok) {
      throw new HttpError(502, `failed to download source image (${response.status})`, 'IMAGE_FETCH_FAILED');
    }
    const contentType = String(response.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      throw new HttpError(415, `source image has unsupported content type: ${contentType}`, 'INVALID_IMAGE_TYPE');
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'source image exceeds the 20MB upload limit', 'IMAGE_TOO_LARGE');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_UPLOAD_BYTES) {
      throw new HttpError(413, 'source image exceeds the 20MB upload limit', 'IMAGE_TOO_LARGE');
    }
    return new Blob([buffer], { type: contentType });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

function extensionForMimeType(type) {
  const normalized = String(type || '').toLowerCase();
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return { ext: 'jpg', format: 'jpeg' };
  if (normalized.includes('webp')) return { ext: 'webp', format: 'webp' };
  return { ext: 'png', format: 'png' };
}

/** Filename wins over MIME type because it is what the user picked. */
function resolveUploadFormat(blob, filename) {
  const match = String(filename || '').match(/\.(jpe?g|png|webp)$/i);
  if (match) {
    const ext = match[1].toLowerCase();
    if (ext.startsWith('jp')) return { ext: 'jpg', format: 'jpeg' };
    if (ext === 'webp') return { ext: 'webp', format: 'webp' };
    return { ext: 'png', format: 'png' };
  }
  return extensionForMimeType(blob?.type);
}

/**
 * Uploads a blob to the 1forall image library and returns its `uploaded_image_url`.
 *
 * @param {Blob} blob
 * @param {{ title?: string, filename?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function uploadImageToLibrary(blob, { title = 'Uploaded Image', filename, signal } = {}) {
  const { ext, format } = resolveUploadFormat(blob, filename);
  const fieldName = process.env.ONE_FOR_ALL_UPLOAD_FIELD || 'file';
  const formData = new FormData();
  formData.append('title', buildOneForAllTitle(title, 'Uploaded Image'));
  formData.append('format', format);
  formData.append(fieldName, blob, filename ? String(filename) : `upload.${ext}`);

  const data = await callOneForAll('/v1/external/image/upload/', {
    method: 'POST',
    body: formData,
    idempotent: false,
    signal,
  });
  const url = data?.uploaded_image_url || data?.url_file || data?.source_image_path || '';
  if (!url) {
    throw new HttpError(502, '1forall.ai upload did not return an image URL', 'UPSTREAM_API_ERROR', data);
  }
  return url;
}

/**
 * Makes any supported image reference usable as `file_reference`: already owned
 * URLs pass through, everything else is downloaded and re-uploaded.
 *
 * @param {string} rawUrl
 * @param {{ title?: string, signal?: AbortSignal }} [options]
 * @returns {Promise<string>}
 */
export async function ensureOneForAllFileReference(rawUrl, { title, signal } = {}) {
  const source = resolveOneForAllImageSource(rawUrl);
  if (!source) {
    throw new HttpError(400, 'imageUrl is required', 'INVALID_IMAGE_URL');
  }
  if (/^https?:\/\//i.test(source) && isOneForAllOwnedUrl(source)) {
    return source;
  }
  const blob = await downloadImageForUpload(source, { signal });
  return uploadImageToLibrary(blob, { title, signal });
}

/**
 * Picks the `size` code to send: an explicit supported code wins, then the
 * aspect ratio, then the catalog default.
 *
 * @param {Record<string, any>|null} entry
 * @param {{ size?: string, aspectRatio?: string }} [options]
 * @returns {string}
 */
export function pickOneForAllSize(entry, { size, aspectRatio } = {}) {
  const { sizes } = getCatalogImageFields(entry);
  const enabled = sizes.filter((item) => item?.code && item.enabled !== false);
  const codes = enabled.map((item) => item.code);

  if (size && codes.includes(String(size))) return String(size);
  if (aspectRatio && codes.includes(String(aspectRatio))) return String(aspectRatio);

  if (size && /^\d+x\d+$/.test(String(size)) && codes.length > 0) {
    // Match a pixel size to the ratio the catalog advertises for it.
    const matched = enabled.find((item) => item.ratio === size || item.code === size);
    if (matched) return matched.code;
  }

  const defaultSize = enabled.find((item) => item.default);
  if (defaultSize) return defaultSize.code;
  if (codes.length > 0) return codes[0];
  return String(aspectRatio || size || '1:1');
}

/** Converts a catalog ratio/size code into a pixel size for the sync endpoint. */
export function toOpenAiPixelSize(sizeOrRatio) {
  const value = String(sizeOrRatio || '').trim();
  if (/^\d+x\d+$/.test(value)) return value;
  if (value === 'auto') return 'auto';
  return RATIO_TO_PIXELS[value] || '1024x1024';
}

/**
 * Splits canonical request params into the model's `additional_fields`.
 * Unknown parameters raise a 400 that lists what the catalog declares.
 *
 * @param {Record<string, any>|null} entry
 * @param {string} model
 * @param {Record<string, any>} [params]
 * @param {Record<string, any>} [extra]
 * @returns {Record<string, any>}
 */
export function buildOneForAllAdditionalFields(entry, model, params = {}, extra = {}) {
  const descriptors = describeOneForAllParams(entry);
  const byKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  const nested = {};
  const passthrough = new Set(['speed']);

  for (const [canonicalKey, rawValue] of Object.entries(params)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (passthrough.has(canonicalKey)) continue;
    if (['prompt', 'imageUrl', 'size', 'aspect_ratio', 'async', 'n'].includes(canonicalKey)) continue;
    const targets = CANONICAL_TARGETS[canonicalKey];
    if (!targets) continue;
    const targetKey = targets.find((key) => byKey.has(key));
    if (targetKey) {
      nested[targetKey] = rawValue;
      continue;
    }
    throw invalidRequestError(
      `${canonicalKey} is not supported by 1forall.ai model "${model}"`,
      'INVALID_IMAGE_PARAMS',
      { model, parameter: canonicalKey, supported: descriptors.map((d) => d.key).join(', ') },
    );
  }

  for (const [key, rawValue] of Object.entries(extra || {})) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    if (!byKey.has(key)) {
      throw invalidRequestError(
        `${key} is not a supported parameter for 1forall.ai model "${model}"`,
        'INVALID_IMAGE_PARAMS',
        { model, parameter: key, supported: descriptors.map((d) => d.key).join(', ') },
      );
    }
    nested[key] = rawValue;
  }

  if (Object.keys(nested).length === 0) return {};

  const { values, issues } = validateParamValues(descriptors, nested);
  if (issues.length > 0) {
    throw invalidRequestError(issues[0], 'INVALID_IMAGE_PARAMS', { model, issues });
  }
  return values;
}

/**
 * @param {{
 *   entry: Record<string, any>|null,
 *   model: string,
 *   prompt: string,
 *   params?: Record<string, any>,
 *   extra?: Record<string, any>,
 * }} options
 * @returns {Record<string, any>}
 */
export function buildOneForAllTextToImageBody({ entry, model, prompt, params = {}, extra = {} }) {
  const size = pickOneForAllSize(entry, {
    size: params.size,
    aspectRatio: params.aspect_ratio,
  });
  const additionalFields = buildOneForAllAdditionalFields(entry, model, params, extra);
  const body = {
    title: buildOneForAllTitle(prompt, 'Generated Image'),
    model,
    size,
    text: clampPrompt(prompt),
  };
  if (params.speed !== undefined && params.speed !== null && params.speed !== '') {
    const speed = Number(params.speed);
    if (!Number.isFinite(speed)) {
      throw new HttpError(400, 'speed must be a finite number', 'INVALID_IMAGE_PARAMS');
    }
    body.speed = speed;
  }
  if (Object.keys(additionalFields).length > 0) {
    body.additional_fields = additionalFields;
  }
  return body;
}

/**
 * @param {{
 *   entry: Record<string, any>|null,
 *   model: string,
 *   prompt: string,
 *   fileReference: string,
 *   params?: Record<string, any>,
 *   extra?: Record<string, any>,
 * }} options
 * @returns {Record<string, any>}
 */
export function buildOneForAllImageToImageBody({ entry, model, prompt, fileReference, params = {}, extra = {} }) {
  if (!fileReference) {
    throw new HttpError(400, 'imageUrl is required', 'INVALID_IMAGE_PARAMS');
  }
  const additionalFields = buildOneForAllAdditionalFields(entry, model, params, extra);
  const body = {
    title: buildOneForAllTitle(prompt, 'Edited Image'),
    model,
    file_reference: fileReference,
    text: clampPrompt(prompt),
  };
  if (params.speed !== undefined && params.speed !== null && params.speed !== '') {
    const speed = Number(params.speed);
    if (!Number.isFinite(speed)) {
      throw new HttpError(400, 'speed must be a finite number', 'INVALID_IMAGE_PARAMS');
    }
    body.speed = speed;
  }
  if (Object.keys(additionalFields).length > 0) {
    body.additional_fields = additionalFields;
  }
  return body;
}

/** Flattens `url_file`, `urls` and `child_conversions` into a URL list. */
export function normalizeOneForAllOutputs(data) {
  const urls = [];
  const push = (value) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!urls.includes(trimmed)) urls.push(trimmed);
  };

  if (typeof data?.url_file === 'string') push(data.url_file);

  const rawUrls = data?.urls;
  if (typeof rawUrls === 'string') {
    const trimmed = rawUrls.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) parsed.forEach(push);
      } catch {
        push(trimmed);
      }
    } else if (trimmed) {
      trimmed.split(/[\s,]+/).forEach(push);
    }
  } else if (Array.isArray(rawUrls)) {
    rawUrls.forEach(push);
  }

  for (const child of Array.isArray(data?.child_conversions) ? data.child_conversions : []) {
    push(child?.url_file);
    push(child?.urls);
    push(child?.uploaded_image_url);
  }

  return urls;
}

/** Maximum image count the synchronous OpenAI-compatible endpoint accepts. */
export const ONE_FOR_ALL_SYNC_MAX_IMAGES = 4;
