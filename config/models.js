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
    const data = await callOneMin('/api/models');
    if (data && Array.isArray(data.models)) {
      const modelType = (m) => m?.type ?? m?.featureType ?? m?.modelType ?? '';
      const newChatModels = data.models.filter((m) => modelType(m) === 'CHAT');
      const newCodeModels = data.models.filter((m) => modelType(m) === 'CODE_GENERATOR');
      const newImageModels = data.models.filter(
        (m) => modelType(m) === 'IMAGE_GENERATOR' || modelType(m) === 'IMAGE_EDITOR',
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
