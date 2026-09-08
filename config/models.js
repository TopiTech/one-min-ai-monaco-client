import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callOneMin } from '../utils/api-client.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_PATH = path.join(__dirname, 'models.json');

const raw = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf-8'));

const MODEL_FEATURES = Object.freeze({
  chat: 'UNIFY_CHAT_WITH_AI',
  code: 'CODE_GENERATOR',
  image: 'IMAGE_GENERATOR',
  imageEditor: 'IMAGE_EDITOR',
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
  ['leonardoai', 'Leonardo'],
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

export const getChatModels = () => _chatModels;
export const getCodeModels = () => _codeModels;
export const getImageModels = () => _imageModels;

let lastFetchStatus = {
  ok: true,
  lastSync: null,
  error: null,
  source: 'fallback',
};

/**
 * Normalize untrusted model metadata before it is exposed to the browser.
 * The upstream model catalog is external input; a malformed entry must not
 * make the model picker crash or create duplicate option IDs.
 */
function getModelId(model) {
  const id = model?.id ?? model?.modelId;
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
  const modelRecord = /** @type {Record<string, unknown>} */ (model);
  const provider = getProviderLabel(
    typeof modelRecord.provider === 'string' ? modelRecord.provider : undefined,
  );
  const tags = inferModelTags(model, feature);

  return { id, label, provider, tags };
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
      }
    }
  }
  return [...unique.values()];
}

export function getModelSyncStatus() {
  return lastFetchStatus;
}

export async function initModels() {
  await fetchModels();
  setInterval(fetchModels, 30 * 60 * 1000).unref();
}

export { fetchModels };

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
  // The endpoint is already scoped by the `feature` query parameter. Accept
  // an entry without a type when an older response omits both metadata fields.
  return true;
}

// The documentation's Available Models section is populated from this
// feature-scoped catalog endpoint, so keep each UI category tied to the
// feature it actually sends to the API.
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

function isNotFoundError(error) {
  return error?.status === 404;
}

async function fetchModels() {
  const requestedFeatures = [
    ['chat', MODEL_FEATURES.chat],
    ['code', MODEL_FEATURES.code],
    ['image', MODEL_FEATURES.image],
    ['imageEditor', MODEL_FEATURES.imageEditor],
  ];
  const results = await Promise.allSettled(
    requestedFeatures.map(([, feature]) => fetchFeatureModels(feature)),
  );
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
      source: 'fallback',
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
