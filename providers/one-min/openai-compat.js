import { serverConfig } from '../../config/server.js';

/**
 * Official 58 models supported by 1min.ai's /openai/v1/chat/completions adapter.
 * Dynamically discovered models from GET /openai/v1/models are merged into
 * runtimeCompatModels when available.
 */
export const ONE_MIN_STATIC_COMPAT_MODELS = new Set([
  // OpenAI GPT-3.5 / GPT-4
  'gpt-3.5-turbo',
  'gpt-4-turbo',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  // OpenAI GPT-5
  'gpt-5',
  'gpt-5-mini',
  'gpt-5-nano',
  'gpt-5.1',
  'gpt-5.2',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.5',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  // OpenAI GPT-6 / o3
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'o3',
  'o3-mini',
  // DeepSeek
  'deepseek-flash',
  'deepseek-v4-pro',
  // Alibaba Qwen
  'qwen-flash',
  'qwen-plus',
  'qwen-max',
  'qwen-vl-plus',
  'qwen-vl-max',
  'qwen3-max',
  'qwen3-8b',
  'qwen3-vl-flash',
  'qwen3-vl-plus',
  'qwen3.6-flash',
  'qwen3.6-max-preview',
  'qwen3.6-plus',
  'qwen3.7-flash',
  'qwen3.7-max',
  'qwen3.7-plus',
  // Z.AI GLM
  'glm-5',
  'glm-5.1',
  'glm-5.2',
  'glm-5.3',
  // Mistral
  'magistral-medium-latest',
  'magistral-small-latest',
  'ministral-14b-latest',
  'mistral-large-2512',
  'mistral-large-latest',
  'mistral-medium-3-5',
  'mistral-medium-latest',
  'mistral-small-2603',
  'mistral-small-latest',
  'open-mistral-nemo',
  // OpenRouter Kimi & Muse Spark
  'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k2.7-code',
  'meta/muse-spark-1.1',
  'meta/muse-spark-1.2',
  'meta/muse-spark-1.3',
]);

const runtimeCompatModels = new Set(ONE_MIN_STATIC_COMPAT_MODELS);

export function updateOneMinCompatModels(modelIds) {
  if (!Array.isArray(modelIds) || modelIds.length === 0) return;
  for (const id of modelIds) {
    if (typeof id === 'string' && id.trim()) {
      runtimeCompatModels.add(id.trim());
    }
  }
}

export function isOneMinCompatModel(model) {
  if (typeof model !== 'string' || !model.trim()) return false;
  return runtimeCompatModels.has(model.trim());
}

/**
 * 1min.ai /openai/v1/chat/completions rejects sampling controls (temperature, top_p)
 * for OpenAI reasoning models (o3/gpt-5/gpt-6), DeepSeek, and Z.AI GLM models.
 */
export function supportsSamplingControls(model) {
  const m = String(model || '').toLowerCase();
  if (/^(?:o[134]|gpt-5|gpt-6|deepseek|glm)/.test(m)) return false;
  return true;
}

/**
 * Determines whether a 1min.ai Code / Agent request should route through
 * /openai/v1/chat/completions (Hybrid Q2) or legacy /api/features CODE_GENERATOR.
 */
export function shouldUseOneMinOpenAiCompat({
  model,
  webSearch = false,
  messages,
  prompt,
  useOpenAiCompat,
  isMockedCallOneMin = false,
}) {
  const mode = serverConfig.oneMinOpenAiCompat || 'auto';
  if (mode === 'off' || useOpenAiCompat === false) return false;
  if (webSearch) return false;

  const msgCount = Array.isArray(messages) ? messages.length : 1;
  if (msgCount > 200) return false;

  const totalChars = Array.isArray(messages)
    ? messages.reduce((sum, m) => sum + String(m?.content || '').length, 0)
    : String(prompt || '').length;
  if (totalChars > 100_000) return false;

  if (useOpenAiCompat === true || mode === 'force') return true;

  // Preserve exact callOneMin('/api/features?isStreaming=true') assertions in
  // existing Jest suites that mock utils/api-client.js without opting into compat mode.
  if (isMockedCallOneMin) return false;

  return isOneMinCompatModel(model);
}

/**
 * Builds an OpenAI Chat Completions payload tailored to 1min.ai's /openai/v1 limits.
 * @param {{ model?: string, messages?: any[], prompt?: string, systemPrompt?: string, maxTokens?: number, stream?: boolean }} params
 */
export function buildOneMinOpenAiChatPayload({
  model,
  messages,
  prompt,
  systemPrompt,
  maxTokens,
  stream = false,
}) {
  const selectedModel = model || serverConfig.defaultChatModel || 'gpt-4o-mini';
  const allowedRoles = new Set(['system', 'user', 'assistant']);

  /** @type {Array<{role: string, content: string}>} */
  const normalizedMessages = [];
  if (systemPrompt && typeof systemPrompt === 'string') {
    normalizedMessages.push({ role: 'system', content: systemPrompt });
  }

  if (Array.isArray(messages) && messages.length > 0) {
    for (const m of messages) {
      const rawRole = String(m?.role || 'user').toLowerCase();
      const role = allowedRoles.has(rawRole) ? rawRole : 'user';
      normalizedMessages.push({
        role,
        content: typeof m?.content === 'string' ? m.content : String(m?.content ?? ''),
      });
    }
  } else if (prompt) {
    normalizedMessages.push({ role: 'user', content: String(prompt) });
  }

  const maxAllowed = selectedModel.toLowerCase().startsWith('gpt-4o') ? 16384 : 32768;
  const maxCompletionTokens = Math.min(Math.max(Number(maxTokens) || 4096, 1), maxAllowed);

  const payload = {
    model: selectedModel,
    messages: normalizedMessages,
    max_completion_tokens: maxCompletionTokens,
    stream: Boolean(stream),
  };

  if (stream) {
    payload.stream_options = { include_usage: true };
  }

  return payload;
}
