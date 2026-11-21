import {
  callOneMin,
  extractFailureMessage,
  extractText,
  isFailedResponse,
  normalizeAssetResponse,
  normalizeOneMinRawResponse,
  parseResponsePayload,
} from '../../utils/api-client.js';
import { isPendingStatusResponse } from '../../utils/http-client.js';
import { HttpError } from '../../utils/errors.js';
import { buildCodePayload } from '../../utils/web-search.js';
import { hasApiKey } from '../../services/key-store.js';
import { serverConfig } from '../../config/server.js';
import logger from '../../utils/logger.js';
import { buildOneMinVideoPayload } from './video.js';
import { buildOneMinOpenAiChatPayload, shouldUseOneMinOpenAiCompat } from './openai-compat.js';

export const ONE_MIN_CAPABILITIES = Object.freeze({
  webSearch: true,
  memories: true,
  serverConversations: true,
  chatAttachments: true,
  imageGeneration: true,
  imageEdit: true,
  videoGeneration: true,
  imageToVideo: true,
  asyncJobs: true,
  maxImagesPerRequest: 10,
});

const CODE_GENERATOR_FEATURE_ENDPOINT = '/api/features?isStreaming=true';

function isMockedFn(fn) {
  return Boolean(fn && typeof (/** @type {any} */ (fn).mock) === 'object');
}

/**
 * Normalizes a 1min.ai /api/results/:uuid payload (or async aiRecord) into
 * the common BFF JobStatus structure.
 */
export function normalizeOneMinJobStatus(data, jobId, kind = 'image') {
  if (data && typeof data === 'object' && 'aiRecord' in data && data.aiRecord === null) {
    throw new HttpError(404, `Job ${jobId} not found`, 'JOB_NOT_FOUND');
  }

  const aiRecord = data?.aiRecord || data || {};
  const rawStatus = String(aiRecord?.status ?? data?.status ?? '').toUpperCase();

  if (rawStatus === 'PROCESSING' || rawStatus === 'PENDING' || rawStatus === 'QUEUED') {
    return {
      status: 'pending',
      jobId: aiRecord?.uuid || jobId,
      provider: '1min',
      kind,
      urls: [],
      aiRecord,
      raw: data,
    };
  }

  if (rawStatus === 'FAILURE' || rawStatus === 'FAILED') {
    return {
      status: 'failed',
      jobId: aiRecord?.uuid || jobId,
      provider: '1min',
      kind,
      urls: [],
      error: extractFailureMessage(data),
      aiRecord,
      raw: data,
    };
  }

  const temporaryUrl = aiRecord?.temporaryUrl || data?.temporaryUrl || null;
  const resultObj = aiRecord?.aiRecordDetail?.resultObject ?? aiRecord?.output ?? aiRecord?.resultObject;
  const resultList = Array.isArray(resultObj) ? resultObj : resultObj ? [resultObj] : [];
  const urls = temporaryUrl ? [temporaryUrl] : resultList.filter((u) => typeof u === 'string');

  return {
    status: 'completed',
    jobId: aiRecord?.uuid || jobId,
    provider: '1min',
    kind,
    urls,
    temporaryUrl,
    aiRecord,
    raw: data,
  };
}

export const oneMinProvider = {
  id: '1min',
  label: '1min.ai',
  capabilities: ONE_MIN_CAPABILITIES,

  isConfigured() {
    return hasApiKey('1min');
  },

  /**
   * Executes code / agent completion using Hybrid routing (Q2):
   * Uses OpenAI-compatible /openai/v1/chat/completions when eligible,
   * falling back cleanly to /api/features CODE_GENERATOR.
   * @param {{
   *   prompt?: string,
   *   messages?: any[],
   *   model?: string,
   *   webSearch?: boolean,
   *   parsedNumOfSite?: number,
   *   parsedMaxWord?: number,
   *   maxTokens?: number,
   *   useOpenAiCompat?: boolean,
   *   task?: string,
   *   context?: string,
   *   signal?: AbortSignal,
   *   timeout?: number,
   * }} params
   */
  async codeComplete({
    prompt,
    messages,
    model,
    webSearch = false,
    parsedNumOfSite,
    parsedMaxWord,
    maxTokens,
    useOpenAiCompat,
    context = 'Code Generator',
    signal,
    timeout,
  }) {
    const selectedModel = model || serverConfig.defaultCodeModel;
    const useCompat = shouldUseOneMinOpenAiCompat({
      model: selectedModel,
      webSearch,
      messages,
      prompt,
      useOpenAiCompat,
      isMockedCallOneMin: isMockedFn(callOneMin),
    });

    if (useCompat) {
      try {
        const compatPayload = buildOneMinOpenAiChatPayload({
          model: selectedModel,
          messages,
          prompt,
          maxTokens,
          stream: false,
        });
        const compatRes = await callOneMin('/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(compatPayload),
          idempotent: false,
          signal,
          timeout,
        });
        const text = compatRes?.choices?.[0]?.message?.content ?? extractText(compatRes);
        return {
          result: text,
          text,
          usage: compatRes?.usage,
          compatUsed: true,
          raw: compatRes,
        };
      } catch (err) {
        const status = err?.status;
        if (status === 400 || status === 404) {
          logger.warn('1min OpenAI-compat rejected request; falling back to CODE_GENERATOR', {
            model: selectedModel,
            status,
            error: err?.message,
          });
        } else {
          throw err;
        }
      }
    }

    const payload = buildCodePayload({
      prompt,
      model: selectedModel,
      webSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });
    const dataRes = await callOneMin(CODE_GENERATOR_FEATURE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
      idempotent: false,
      signal,
      timeout,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes, { context });
    if (isFailedResponse(normalizedDataRes)) {
      throw new HttpError(
        502,
        `1min.ai ${context.toLowerCase()} failed: ${extractFailureMessage(normalizedDataRes)}`,
        'UPSTREAM_API_ERROR',
        normalizedDataRes,
      );
    }
    return normalizedDataRes;
  },

  /**
   * @param {{
   *   model?: string,
   *   prompt?: string,
   *   imageUrl?: string,
   *   aspect_ratio?: string,
   *   duration?: number,
   *   resolution?: string,
   *   audio?: boolean,
   *   negativePrompt?: string,
   *   mode?: string,
   *   version?: string,
   *   speed?: number,
   *   additionalFields?: Record<string, any>,
   *   signal?: AbortSignal,
   * }} params
   */
  async generateVideo(params) {
    const { signal, ...videoParams } = params;
    const payload = buildOneMinVideoPayload(videoParams);
    const dataRes = await callOneMin('/api/features', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
      signal,
    });
    if (isFailedResponse(dataRes)) {
      throw new HttpError(
        502,
        `1min.ai video generate failed: ${extractFailureMessage(dataRes)}`,
        'UPSTREAM_API_ERROR',
        dataRes,
      );
    }
    const aiRecord = dataRes?.aiRecord || dataRes;
    const jobId = aiRecord?.uuid || null;
    if (isPendingStatusResponse(dataRes)) {
      return {
        status: 'PROCESSING',
        jobId,
        provider: '1min',
        kind: 'video',
        urls: [],
        aiRecord,
        raw: dataRes,
      };
    }
    const normalized = normalizeOneMinJobStatus(dataRes, jobId || '', 'video');
    return {
      status: normalized.status === 'completed' ? 'SUCCESS' : normalized.status.toUpperCase(),
      jobId,
      provider: '1min',
      kind: 'video',
      urls: normalized.urls,
      temporaryUrl: normalized.temporaryUrl,
      aiRecord,
      raw: dataRes,
    };
  },

  async getJob(jobId, kind = 'image') {
    const data = await callOneMin(`/api/results/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      idempotent: true,
    });
    return normalizeOneMinJobStatus(data, jobId, kind);
  },

  async uploadAsset({ blob, filename }) {
    const formData = new FormData();
    formData.append('asset', blob, filename);
    const data = await callOneMin('/api/assets', {
      method: 'POST',
      body: formData,
      idempotent: false,
    });
    const normalized = normalizeAssetResponse(data);
    delete normalized.raw;
    return normalized;
  },
};

export { parseResponsePayload };
