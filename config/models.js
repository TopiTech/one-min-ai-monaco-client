import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callOneMin } from '../utils/api-client.js';
import { callOneForAll } from '../providers/one-for-all/client.js';
import { registerOneForAllModelLimits } from '../providers/one-for-all/index.js';
import { updateOneMinCompatModels } from '../providers/one-min/openai-compat.js';
import { hasApiKey } from '../services/key-store.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_PATH = path.join(__dirname, 'models.json');

const raw = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf-8'));

const MODEL_FEATURES = Object.freeze({
  chat: 'UNIFY_CHAT_WITH_AI',
  code: 'CODE_GENERATOR',
  image: 'IMAGE_GENERATOR',
  imageEditor: 'IMAGE_EDITOR',
  textToVideo: 'TEXT_TO_VIDEO',
  imageToVideo: 'IMAGE_TO_VIDEO',
});

const PROVIDER_LABELS = new Map([
  ['alibaba', 'Alibaba'],
  ['aws-bedrock', 'AWS Bedrock'],
  ['anthropic', 'Anthropic'],
  ['cohere', 'Cohere'],
  ['deepseek', 'DeepSeek'],
  ['dzine', 'Dzine'],
  ['googleai', 'Google'],
  ['ideogram', 'Ideogram'],
  ['kling', 'Kling'],
  ['leonardoai', 'Leonardo'],
  ['luma', 'Luma'],
  ['minimax', 'MiniMax'],
  ['mistralai', 'Mistral'],
  ['openai', 'OpenAI'],
  ['openrouter', 'OpenRouter'],
  ['perplexity', 'Perplexity'],
  ['recraft', 'Recraft'],
  ['replicate', 'Replicate'],
  ['stabilityai', 'Stability'],
  ['ttapi', 'Magic Art'],
  ['xai', 'xAI'],
  ['zai', 'Z.AI'],
]);

const MAX_MODEL_ID_LENGTH = 200;
const MAX_MODEL_LABEL_LENGTH = 200;
const MAX_MODEL_PROVIDER_LENGTH = 100;
const MAX_MODEL_TAG_LENGTH = 50;
const MAX_MODEL_TAGS = 20;

let _chatModels = normalizeModelList(raw.chatModels || []);
let _codeModels = normalizeModelList(raw.codeModels || []);
let _imageModels = normalizeModelList(raw.imageModels || []);
let _videoModels = normalizeModelList(raw.videoModels || []);

const fallbackOneForAll = raw.oneForAll || {};
let _oneForAllChatModels = normalizeModelList(fallbackOneForAll.chatModels || []);
let _oneForAllCodeModels = normalizeModelList(fallbackOneForAll.codeModels || []);
let _oneForAllImageModels = normalizeModelList(fallbackOneForAll.imageModels || []);
let _oneForAllVideoModels = normalizeModelList(fallbackOneForAll.videoModels || []);

export const getChatModels = (providerId = '1min') =>
  providerId === '1forall' ? _oneForAllChatModels : _chatModels;
export const getCodeModels = (providerId = '1min') =>
  providerId === '1forall' ? _oneForAllCodeModels : _codeModels;
export const getImageModels = (providerId = '1min') =>
  providerId === '1forall' ? _oneForAllImageModels : _imageModels;
export const getVideoModels = (providerId = '1min') =>
  providerId === '1forall' ? _oneForAllVideoModels : _videoModels;

let lastFetchStatus = {
  ok: true,
  lastSync: null,
  error: null,
  source: 'fallback',
};

let lastOneForAllFetchStatus = {
  ok: true,
  lastSync: null,
  error: null,
  source: 'fallback',
};

function getModelId(model) {
  const id = model?.id ?? model?.modelId ?? model?.code;
  return typeof id === 'string' ? id.trim() : '';
}

function getModelLabel(model, id) {
  const label = model?.label ?? model?.name;
  return typeof label === 'string' && label.trim().length > 0 && label.length <= MAX_MODEL_LABEL_LENGTH
    ? label.trim()
    : id;
}

function getProviderLabel(provider) {
  if (typeof provider !== 'string' || provider.trim().length === 0) return 'Unknown';
  const trimmed = provider.trim();
  return PROVIDER_LABELS.get(trimmed.toLowerCase()) || trimmed.slice(0, MAX_MODEL_PROVIDER_LENGTH);
}

function inferModelTags(model, feature) {
  const tags = new Set(
    Array.isArray(model?.tags)
      ? model.tags
          .filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
          .map((tag) => tag.trim().slice(0, MAX_MODEL_TAG_LENGTH))
          .slice(0, MAX_MODEL_TAGS)
      : [],
  );
  const id = getModelId(model);
  const label = typeof (model?.label ?? model?.name) === 'string' ? (model.label ?? model.name) : '';
  const searchText = `${id} ${label}`.toLowerCase();
  const features = Array.isArray(model?.features) ? model.features : [];

  if (feature === MODEL_FEATURES.code) tags.add('code');
  if (feature === MODEL_FEATURES.image || feature === MODEL_FEATURES.imageEditor) tags.add('image');
  if (feature === MODEL_FEATURES.imageEditor || features.includes(MODEL_FEATURES.imageEditor)) {
    tags.add('editor');
  }
  if (feature === MODEL_FEATURES.textToVideo || feature === MODEL_FEATURES.imageToVideo) {
    tags.add('video');
  }
  if (feature === MODEL_FEATURES.imageToVideo || features.includes(MODEL_FEATURES.imageToVideo)) {
    tags.add('image-to-video');
  }

  if (/(?:reason|thinking|deep-research|o[134](?:[-.\s]|$))/.test(searchText)) tags.add('reasoning');
  if (/(?:mini|nano|flash|fast|small|lite|schnell|turbo|\d+b(?:[-.\s]|$))/.test(searchText)) tags.add('fast');
  if (
    /(?:opus|sonnet|fable|max|plus|pro|large|maverick|phoenix|ultra|recraft|ideogram|gpt-image-2|gpt-5(?:[-.\s]|$)|gpt-4o(?:[-.\s]|$)|kimi-k3|grok-4(?:\.\d+)?(?:[-.\s]|$)|glm-5(?:\.\d+)?(?:[-.\s]|$)|magic-art[_-]7|flux-2-(?:pro|max))/.test(
      searchText,
    )
  ) {
    tags.add('flagship');
  }

  return [...tags].slice(0, MAX_MODEL_TAGS);
}

/**
 * @param {unknown} model
 * @param {{ feature?: string }} [options]
 */
function normalizeModel(model, { feature } = {}) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;

  const id = getModelId(model);
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;

  const label = getModelLabel(model, id);
  const modelRecord = /** @type {Record<string, any>} */ (model);
  const rawProvider =
    typeof modelRecord.provider_details?.name === 'string'
      ? modelRecord.provider_details.name
      : typeof modelRecord.provider === 'string'
        ? modelRecord.provider
        : undefined;
  const provider = getProviderLabel(rawProvider);
  const tags = inferModelTags(model, feature);

  const normalized = { id, label, provider, tags };
  if (modelRecord.meta && typeof modelRecord.meta === 'object' && !Array.isArray(modelRecord.meta)) {
    normalized.meta = modelRecord.meta;
  }
  return normalized;
}

function normalizeModelList(models, options = {}) {
  const unique = new Map();
  for (const model of models) {
    const normalized = normalizeModel(model, options);
    if (normalized && !unique.has(normalized.id)) {
      unique.set(normalized.id, normalized);
    }
  }
  return [...unique.values()];
}

function mergeModelLists(modelLists) {
  const unique = new Map();
  for (const models of modelLists) {
    for (const model of models) {
      const existing = unique.get(model.id);
      if (!existing) {
        unique.set(model.id, { ...model, tags: [...model.tags] });
      } else {
        existing.tags = [...new Set([...existing.tags, ...model.tags])].slice(0, MAX_MODEL_TAGS);
        if (model.meta) {
          existing.meta = { ...(existing.meta || {}), ...model.meta };
        }
      }
    }
  }
  return [...unique.values()];
}

export function getModelSyncStatus(providerId = '1min') {
  return providerId === '1forall' ? lastOneForAllFetchStatus : lastFetchStatus;
}

export function getModelsForProvider(providerId = '1min') {
  return {
    chatModels: getChatModels(providerId),
    codeModels: getCodeModels(providerId),
    imageModels: getImageModels(providerId),
    videoModels: getVideoModels(providerId),
    sync: getModelSyncStatus(providerId),
  };
}

export function getAllProvidersModels() {
  return {
    '1min': getModelsForProvider('1min'),
    '1forall': getModelsForProvider('1forall'),
  };
}

let syncInterval = null;

export async function initModels() {
  await fetchModels();
  if (!syncInterval) {
    syncInterval = setInterval(() => fetchModels({ includeAll: true }), 30 * 60 * 1000);
    syncInterval.unref();
  }
}

export function stopModelSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export { fetchModels, fetchOneForAllModels };

function isActiveModel(model) {
  return model?.status === undefined || String(model.status).toUpperCase() === 'ACTIVE';
}

function getLegacyModelType(model) {
  return String(model?.type ?? model?.featureType ?? model?.modelType ?? '').toUpperCase();
}

function modelMatchesFeature(model, feature) {
  if (Array.isArray(model?.features) && model.features.length > 0) {
    return model.features.includes(feature);
  }

  const type = getLegacyModelType(model);
  if (feature === MODEL_FEATURES.chat) return ['CHAT', 'CHAT_WITH_AI', MODEL_FEATURES.chat].includes(type);
  if (feature === MODEL_FEATURES.code) return type === MODEL_FEATURES.code;
  if (feature === MODEL_FEATURES.image) return type === MODEL_FEATURES.image;
  if (feature === MODEL_FEATURES.imageEditor) return type === MODEL_FEATURES.imageEditor;
  if (feature === MODEL_FEATURES.textToVideo) return type === MODEL_FEATURES.textToVideo;
  if (feature === MODEL_FEATURES.imageToVideo) return type === MODEL_FEATURES.imageToVideo;
  return true;
}

async function fetchFeatureModels(feature) {
  const data = await callOneMin(`/models?feature=${encodeURIComponent(feature)}`, {
    method: 'GET',
    suppressJsonParseErrorLog: true,
  });
  if (!data || !Array.isArray(data.models)) {
    throw new Error(`Unexpected model API response for ${feature}`);
  }
  return normalizeModelList(
    data.models.filter((model) => isActiveModel(model) && modelMatchesFeature(model, feature)),
    { feature },
  );
}

async function fetchOneMinOpenAiCompatCatalog() {
  try {
    const data = await callOneMin('/openai/v1/models', {
      method: 'GET',
      suppressJsonParseErrorLog: true,
    });
    if (Array.isArray(data?.data)) {
      updateOneMinCompatModels(data.data.map((item) => item?.id).filter(Boolean));
    }
  } catch {
    // Non-fatal: static 58-model catalog remains active
  }
}

function isNotFoundError(error) {
  return error?.status === 404;
}

function normalizeOneForAllModel(rawModel, kind) {
  if (!rawModel || typeof rawModel !== 'object' || Array.isArray(rawModel)) return null;
  if (rawModel.enabled === false || rawModel.deprecated === true) return null;

  const id = typeof rawModel.code === 'string' ? rawModel.code.trim() : '';
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;

  const label = getModelLabel(rawModel, id);
  const provider = getProviderLabel(rawModel.provider_details?.name || rawModel.provider || '1forall');
  const mode = typeof rawModel.mode === 'string' ? rawModel.mode.toUpperCase() : '';
  const tags = new Set();

  if (kind === 'code') tags.add('code');
  if (kind === 'image') {
    tags.add('image');
    if (mode === 'IMAGE_TO_IMAGE') tags.add('editor');
    else tags.add('flagship');
  }
  if (kind === 'video') {
    tags.add('video');
    if (mode === 'IMAGE_TO_VIDEO') tags.add('image-to-video');
  }
  const searchText = `${id} ${label}`.toLowerCase();
  if (/(?:reason|thinking|o[134](?:[-.\s]|$))/.test(searchText)) tags.add('reasoning');
  if (/(?:mini|nano|flash|fast|schnell|turbo)/.test(searchText)) tags.add('fast');
  if (rawModel.recommended) tags.add('flagship');

  const meta = {};
  if (rawModel.credits_at_defaults != null) meta.credits = rawModel.credits_at_defaults;
  else if (rawModel.credits_per_output_token != null)
    meta.creditsPerOutputToken = rawModel.credits_per_output_token;
  if (rawModel.min_max_tokens != null && rawModel.min_max_tokens !== '') {
    const parsedMinMax = Number(rawModel.min_max_tokens);
    if (Number.isFinite(parsedMinMax) && parsedMinMax > 0) meta.minMaxTokens = parsedMinMax;
  }
  if (rawModel.default_max_tokens != null && rawModel.default_max_tokens !== '') {
    const parsedDefaultMax = Number(rawModel.default_max_tokens);
    if (Number.isFinite(parsedDefaultMax) && parsedDefaultMax > 0) {
      meta.defaultMaxTokens = parsedDefaultMax;
    }
  }
  if (mode) meta.mode = mode;

  return {
    id,
    label,
    provider,
    tags: [...tags].slice(0, MAX_MODEL_TAGS),
    ...(Object.keys(meta).length > 0 ? { meta } : {}),
  };
}

function dedupeNormalizedModels(models) {
  const unique = new Map();
  for (const model of models) {
    if (model && !unique.has(model.id)) {
      unique.set(model.id, model);
    }
  }
  return [...unique.values()];
}

let _oneMinFetchInFlight = null;
let _oneMinFetchInFlightExtended = false;
let _oneForAllFetchInFlight = null;

async function fetchOneForAllModels() {
  if (_oneForAllFetchInFlight) {
    return _oneForAllFetchInFlight;
  }
  const promise = _runFetchOneForAllModels();
  _oneForAllFetchInFlight = promise;
  try {
    await promise;
  } finally {
    if (_oneForAllFetchInFlight === promise) {
      _oneForAllFetchInFlight = null;
    }
  }
}

async function _runFetchOneForAllModels() {
  if (!hasApiKey('1forall')) {
    lastOneForAllFetchStatus = {
      ok: true,
      lastSync: lastOneForAllFetchStatus.lastSync,
      error: null,
      source: 'fallback',
    };
    return;
  }

  const endpoints = [
    ['llm', '/v1/external/llm/models/'],
    ['image', '/v1/external/image/models/'],
    ['video', '/v1/external/video/models/'],
  ];

  const results = await Promise.allSettled(
    endpoints.map(([, endpoint]) =>
      callOneForAll(endpoint, { method: 'GET', suppressJsonParseErrorLog: true }),
    ),
  );

  const failures = [];
  let updated = 0;

  // LLM catalog
  if (results[0].status === 'fulfilled' && Array.isArray(results[0].value)) {
    const llmModels = dedupeNormalizedModels(results[0].value.map((m) => normalizeOneForAllModel(m, 'chat')));
    const codeModels = dedupeNormalizedModels(
      results[0].value.map((m) => normalizeOneForAllModel(m, 'code')),
    );
    if (llmModels.length > 0) {
      _oneForAllChatModels = llmModels;
      _oneForAllCodeModels = codeModels;
      registerOneForAllModelLimits(llmModels);
      updated++;
    }
  } else if (results[0].status === 'rejected') {
    failures.push(results[0].reason);
  }

  // Image catalog
  if (results[1].status === 'fulfilled' && Array.isArray(results[1].value)) {
    const imgModels = dedupeNormalizedModels(
      results[1].value.map((m) => normalizeOneForAllModel(m, 'image')),
    );
    if (imgModels.length > 0) {
      _oneForAllImageModels = imgModels;
      updated++;
    }
  } else if (results[1].status === 'rejected') {
    failures.push(results[1].reason);
  }

  // Video catalog
  if (results[2].status === 'fulfilled' && Array.isArray(results[2].value)) {
    const vidModels = dedupeNormalizedModels(
      results[2].value.map((m) => normalizeOneForAllModel(m, 'video')),
    );
    if (vidModels.length > 0) {
      _oneForAllVideoModels = vidModels;
      updated++;
    }
  } else if (results[2].status === 'rejected') {
    failures.push(results[2].reason);
  }

  const now = new Date().toISOString();
  if (updated > 0 && failures.length === 0) {
    lastOneForAllFetchStatus = { ok: true, lastSync: now, error: null, source: 'remote' };
    logger.info('Models dynamically fetched and updated from 1forall.ai API.');
  } else if (failures.length > 0) {
    lastOneForAllFetchStatus = {
      ok: updated > 0,
      lastSync: updated > 0 ? now : lastOneForAllFetchStatus.lastSync,
      error: failures.map((e) => e?.message || String(e)).join('; '),
      source: updated > 0 ? 'remote' : 'fallback',
    };
    logger.warn('Failed to fetch some or all 1forall.ai models; using fallback where needed.', {
      error: lastOneForAllFetchStatus.error,
    });
  } else {
    lastOneForAllFetchStatus = {
      ok: true,
      lastSync: now,
      error: 'No active 1forall.ai models were returned; using built-in fallbacks.',
      source: 'fallback',
    };
    logger.debug('1forall.ai model discovery returned no active models. Using fallbacks.');
  }
}

async function fetchOneMinModels({ includeExtended = false } = {}) {
  if (_oneMinFetchInFlight) {
    if (!includeExtended || _oneMinFetchInFlightExtended) {
      return _oneMinFetchInFlight;
    }
    await _oneMinFetchInFlight.catch(() => {});
    if (_oneMinFetchInFlight && _oneMinFetchInFlightExtended) {
      return _oneMinFetchInFlight;
    }
  }
  const promise = _runFetchOneMinModels({ includeExtended });
  _oneMinFetchInFlight = promise;
  _oneMinFetchInFlightExtended = Boolean(includeExtended);
  try {
    await promise;
  } finally {
    if (_oneMinFetchInFlight === promise) {
      _oneMinFetchInFlight = null;
      _oneMinFetchInFlightExtended = false;
    }
  }
}

async function _runFetchOneMinModels({ includeExtended = false } = {}) {
  if (!hasApiKey('1min')) {
    lastFetchStatus = {
      ok: true,
      lastSync: lastFetchStatus.lastSync,
      error: null,
      source: 'fallback',
    };
    return;
  }

  const requestedFeatures = [
    ['chat', MODEL_FEATURES.chat],
    ['code', MODEL_FEATURES.code],
    ['image', MODEL_FEATURES.image],
    ['imageEditor', MODEL_FEATURES.imageEditor],
  ];
  if (includeExtended) {
    requestedFeatures.push(['textToVideo', MODEL_FEATURES.textToVideo]);
    requestedFeatures.push(['imageToVideo', MODEL_FEATURES.imageToVideo]);
  }

  const results = await Promise.allSettled(
    requestedFeatures.map(([, feature]) => fetchFeatureModels(feature)),
  );
  if (includeExtended) {
    await fetchOneMinOpenAiCompatCatalog();
  }

  const failures = [];
  const successfulModels = new Map();

  requestedFeatures.forEach(([key], index) => {
    const result = results[index];
    if (result.status === 'fulfilled') {
      successfulModels.set(key, result.value);
    } else {
      failures.push(result.reason);
    }
  });

  let updatedCategories = 0;
  const chatModels = successfulModels.get('chat');
  if (chatModels?.length > 0) {
    _chatModels = chatModels;
    updatedCategories++;
  }

  const codeModels = successfulModels.get('code');
  if (codeModels?.length > 0) {
    _codeModels = codeModels;
    updatedCategories++;
  }

  const imageModels = mergeModelLists([
    successfulModels.get('image') || [],
    successfulModels.get('imageEditor') || [],
  ]);
  if (imageModels.length > 0) {
    _imageModels = imageModels;
    updatedCategories++;
  }

  if (includeExtended) {
    const videoModels = mergeModelLists([
      successfulModels.get('textToVideo') || [],
      successfulModels.get('imageToVideo') || [],
    ]);
    if (videoModels.length > 0) {
      _videoModels = videoModels;
    }
  }

  const now = new Date().toISOString();
  if (updatedCategories > 0 && failures.length === 0) {
    lastFetchStatus = { ok: true, lastSync: now, error: null, source: 'remote' };
    logger.info('Models dynamically fetched and updated from 1min.ai API.');
    return;
  }

  if (updatedCategories > 0 && failures.length > 0) {
    lastFetchStatus = {
      ok: false,
      lastSync: now,
      error: failures.map((error) => error?.message || String(error)).join('; '),
      source: 'remote',
    };
    logger.error('Partially failed to fetch models dynamically from 1min.ai API.', {
      error: lastFetchStatus.error,
      failedRequests: failures.length,
    });
    return;
  }

  if (failures.length > 0 && failures.every(isNotFoundError)) {
    lastFetchStatus = {
      ok: true,
      lastSync: now,
      error: '1min.ai model discovery endpoints are unavailable; using built-in fallbacks.',
      source: 'fallback',
    };
    logger.info('1min.ai model discovery endpoints are unavailable (404). Using hardcoded fallback models.');
    return;
  }

  if (failures.length > 0) {
    lastFetchStatus = {
      ok: false,
      lastSync: lastFetchStatus.lastSync,
      error: failures.map((error) => error?.message || String(error)).join('; '),
      source: 'fallback',
    };
    logger.error('Failed to fetch models dynamically from 1min.ai API.', {
      error: lastFetchStatus.error,
      failedRequests: failures.length,
    });
    return;
  }

  lastFetchStatus = {
    ok: true,
    lastSync: now,
    error: 'No active models were returned; using built-in fallbacks.',
    source: 'fallback',
  };
  logger.debug('Model discovery returned no active models. Using fallbacks.');
}

/**
 * Fetches model catalogs from configured providers.
 * @param {{ provider?: string, includeAll?: boolean }} [options]
 */
async function fetchModels({ provider, includeAll = false } = {}) {
  if (provider === '1forall') {
    await fetchOneForAllModels();
    return;
  }
  if (provider === '1min') {
    await fetchOneMinModels({ includeExtended: includeAll });
    return;
  }

  await fetchOneMinModels({ includeExtended: includeAll });
  if (hasApiKey('1forall')) {
    await fetchOneForAllModels();
  }
}
