import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callOneMin } from '../utils/api-client.js';
import logger from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_PATH = path.join(__dirname, 'models.json');

const raw = JSON.parse(fs.readFileSync(MODELS_JSON_PATH, 'utf-8'));

let _chatModels = raw.chatModels || [];
let _codeModels = raw.codeModels || [];
let _imageModels = raw.imageModels || [];

export const getChatModels = () => _chatModels;
export const getCodeModels = () => _codeModels;
export const getImageModels = () => _imageModels;

let lastFetchStatus = {
  ok: true,
  lastSync: null,
  error: null,
  source: 'fallback',
};

const MAX_MODEL_ID_LENGTH = 200;
const MAX_MODEL_LABEL_LENGTH = 200;
const MAX_MODEL_PROVIDER_LENGTH = 100;
const MAX_MODEL_TAG_LENGTH = 50;
const MAX_MODEL_TAGS = 20;

/**
 * Normalize untrusted model metadata before it is exposed to the browser.
 * The upstream model catalog is external input; a malformed entry must not
 * make the model picker crash or create duplicate option IDs.
 */
function normalizeModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;

  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;

  const label =
    typeof model.label === 'string' &&
    model.label.trim().length > 0 &&
    model.label.length <= MAX_MODEL_LABEL_LENGTH
      ? model.label.trim()
      : id;
  const provider =
    typeof model.provider === 'string' && model.provider.trim().length > 0
      ? model.provider.trim().slice(0, MAX_MODEL_PROVIDER_LENGTH)
      : 'Unknown';
  const tags = Array.isArray(model.tags)
    ? model.tags
        .filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
        .map((tag) => tag.trim().slice(0, MAX_MODEL_TAG_LENGTH))
        .slice(0, MAX_MODEL_TAGS)
    : [];

  return { ...model, id, label, provider, tags };
}

function normalizeModelList(models) {
  const unique = new Map();
  for (const model of models) {
    const normalized = normalizeModel(model);
    if (normalized && !unique.has(normalized.id)) {
      unique.set(normalized.id, normalized);
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

async function fetchModels() {
  try {
    // Model discovery is a read-only endpoint. Be explicit because the API
    // client defaults to POST for mutating endpoints.
    const data = await callOneMin('/api/models', {
      method: 'GET',
      suppressJsonParseErrorLog: true,
    });
    if (data && Array.isArray(data.models)) {
      const modelType = (m) => m?.type ?? m?.featureType ?? m?.modelType ?? '';
      const newChatModels = normalizeModelList(data.models.filter((m) => modelType(m) === 'CHAT'));
      const newCodeModels = normalizeModelList(data.models.filter((m) => modelType(m) === 'CODE_GENERATOR'));
      const newImageModels = normalizeModelList(
        data.models.filter((m) => modelType(m) === 'IMAGE_GENERATOR' || modelType(m) === 'IMAGE_EDITOR'),
      );

      if (newChatModels.length > 0) _chatModels = newChatModels;
      if (newCodeModels.length > 0) _codeModels = newCodeModels;
      if (newImageModels.length > 0) _imageModels = newImageModels;

      lastFetchStatus = { ok: true, lastSync: new Date().toISOString(), error: null, source: 'remote' };
      logger.info('Models dynamically fetched and updated from 1min.ai API.');
    } else {
      lastFetchStatus = {
        ok: true,
        lastSync: new Date().toISOString(),
        error: 'Unexpected model API response shape; using built-in fallbacks.',
        source: 'fallback',
      };
      logger.debug('Models sync returned unexpected format. Using fallbacks.');
    }
  } catch (err) {
    if (err.status === 404) {
      lastFetchStatus = {
        ok: true,
        lastSync: new Date().toISOString(),
        error: '1min.ai /api/models is unavailable; using built-in fallbacks.',
        source: 'fallback',
      };
      logger.info('1min.ai /api/models is unavailable (404). Using hardcoded fallback models.');
    } else {
      lastFetchStatus = {
        ok: false,
        lastSync: lastFetchStatus.lastSync,
        error: err.message,
        source: 'fallback',
      };
      logger.error('Failed to fetch models dynamically from 1min.ai API.', {
        error: err.message,
        status: err.status,
      });
    }
  }
}
