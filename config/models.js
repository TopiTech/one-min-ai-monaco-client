// Source: https://docs.1min.ai/

import { callOneMin } from '../utils/api-client.js';
import logger from '../utils/logger.js';

export let chatModels = [
  // OpenAI
  { id: "gpt-4o-mini", label: "GPT-4o mini", provider: "OpenAI", tags: ["fast"] },
  { id: "gpt-4o", label: "GPT-4o", provider: "OpenAI", tags: ["flagship"] },
  { id: "gpt-4.1", label: "GPT-4.1", provider: "OpenAI", tags: ["flagship"] },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", provider: "OpenAI", tags: ["fast"] },
  { id: "gpt-4.1-nano", label: "GPT-4.1 nano", provider: "OpenAI", tags: ["fast"] },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo", provider: "OpenAI" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo", provider: "OpenAI" },
  { id: "gpt-5", label: "GPT-5", provider: "OpenAI", tags: ["flagship"] },
  { id: "gpt-5-mini", label: "GPT-5 mini", provider: "OpenAI", tags: ["fast"] },
  { id: "gpt-5-nano", label: "GPT-5 nano", provider: "OpenAI", tags: ["fast"] },
  { id: "o3", label: "o3", provider: "OpenAI", tags: ["flagship", "reasoning"] },
  { id: "o3-mini", label: "o3 mini", provider: "OpenAI", tags: ["reasoning"] },
  { id: "o4-mini", label: "o4 mini", provider: "OpenAI", tags: ["reasoning", "fast"] },
  // Anthropic
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    provider: "Anthropic",
    tags: ["flagship"],
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Claude Sonnet 4.5",
    provider: "Anthropic",
    tags: ["flagship"],
  },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "Anthropic", tags: ["flagship"] },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", provider: "Anthropic", tags: ["flagship"] },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", provider: "Anthropic", tags: ["flagship"] },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    provider: "Anthropic",
    tags: ["fast"],
  },
  // Google
  { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", provider: "Google", tags: ["flagship"] },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "Google", tags: ["fast"] },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    provider: "Google",
    tags: ["flagship", "fast"],
  },
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro Preview",
    provider: "Google",
    tags: ["flagship"],
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    provider: "Google",
    tags: ["fast"],
  },
  // DeepSeek
  {
    id: "deepseek-reasoner",
    label: "DeepSeek Reasoner",
    provider: "DeepSeek",
    tags: ["reasoning"],
  },
  { id: "deepseek-chat", label: "DeepSeek Chat", provider: "DeepSeek", tags: ["fast"] },
  // xAI
  { id: "grok-4-0709", label: "Grok 4", provider: "xAI", tags: ["flagship"] },
  {
    id: "grok-4-fast-reasoning",
    label: "Grok 4 Fast Reasoning",
    provider: "xAI",
    tags: ["reasoning"],
  },
  { id: "grok-3", label: "Grok 3", provider: "xAI", tags: ["flagship"] },
  { id: "grok-3-mini", label: "Grok 3 mini", provider: "xAI", tags: ["fast"] },
  // Mistral
  { id: "mistral-large-latest", label: "Mistral Large", provider: "Mistral", tags: ["flagship"] },
  { id: "mistral-medium-latest", label: "Mistral Medium", provider: "Mistral" },
  { id: "mistral-small-latest", label: "Mistral Small", provider: "Mistral", tags: ["fast"] },
  { id: "magistral-medium-latest", label: "Magistral Medium", provider: "Mistral" },
  { id: "magistral-small-latest", label: "Magistral Small", provider: "Mistral" },
  // Alibaba (Qwen)
  { id: "qwen-max", label: "Qwen Max", provider: "Alibaba", tags: ["flagship"] },
  { id: "qwen-plus", label: "Qwen Plus", provider: "Alibaba" },
  { id: "qwen-flash", label: "Qwen Flash", provider: "Alibaba", tags: ["fast"] },
  { id: "qwen3-max", label: "Qwen3 Max", provider: "Alibaba", tags: ["flagship"] },
  { id: "qwen3-8b", label: "Qwen3 8B", provider: "Alibaba", tags: ["fast"] },
  { id: "qwen-vl-max", label: "Qwen VL Max", provider: "Alibaba", tags: ["flagship"] },
  { id: "qwen-vl-plus", label: "Qwen VL Plus", provider: "Alibaba" },
  // Perplexity
  { id: "sonar-pro", label: "Sonar Pro", provider: "Perplexity", tags: ["flagship"] },
  { id: "sonar", label: "Sonar", provider: "Perplexity", tags: ["fast"] },
  {
    id: "sonar-reasoning-pro",
    label: "Sonar Reasoning Pro",
    provider: "Perplexity",
    tags: ["reasoning"],
  },
  {
    id: "sonar-deep-research",
    label: "Sonar Deep Research",
    provider: "Perplexity",
    tags: ["flagship"],
  },
  // Cohere
  { id: "command-r-08-2024", label: "Command R", provider: "Cohere" },
  // Meta / Extra
  {
    id: "meta/llama-4-maverick-instruct",
    label: "Llama 4 Maverick",
    provider: "Meta",
    tags: ["flagship"],
  },
  {
    id: "meta/llama-4-scout-instruct",
    label: "Llama 4 Scout",
    provider: "Meta",
    tags: ["flagship"],
  },
  { id: "meta/meta-llama-3-70b-instruct", label: "Llama 3 70B", provider: "Meta" },
];

export let codeModels = [
  // Alibaba Cloud (Qwen Coder)
  {
    id: "qwen3-coder-plus",
    label: "Qwen3 Coder Plus",
    provider: "Alibaba",
    tags: ["code", "flagship"],
  },
  {
    id: "qwen3-coder-flash",
    label: "Qwen3 Coder Flash",
    provider: "Alibaba",
    tags: ["code", "fast"],
  },
  // Anthropic
  {
    id: "claude-sonnet-4-6",
    label: "Claude 4.6 Sonnet",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-sonnet-4-5-20250929",
    label: "Claude 4.5 Sonnet",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-opus-4-8",
    label: "Claude 4.8 Opus",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-opus-4-7",
    label: "Claude 4.7 Opus",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-opus-4-6",
    label: "Claude 4.6 Opus",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-opus-4-5-20251101",
    label: "Claude 4.5 Opus",
    provider: "Anthropic",
    tags: ["code", "flagship"],
  },
  {
    id: "claude-opus-4-1-20250805",
    label: "Claude 4.1 Opus",
    provider: "Anthropic",
    tags: ["code"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Claude 4.5 Haiku",
    provider: "Anthropic",
    tags: ["code", "fast"],
  },
  // DeepSeek
  {
    id: "deepseek-reasoner",
    label: "DeepSeek V3.2 Reasoner",
    provider: "DeepSeek",
    tags: ["code", "reasoning"],
  },
  {
    id: "deepseek-chat",
    label: "DeepSeek V3.2 Chat",
    provider: "DeepSeek",
    tags: ["code", "fast"],
  },
  // GoogleAI
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: "Google",
    tags: ["code", "flagship"],
  },
  {
    id: "gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite",
    provider: "Google",
    tags: ["code", "fast"],
  },
  {
    id: "gemini-3-flash-preview",
    label: "Gemini 3 Flash",
    provider: "Google",
    tags: ["code", "fast"],
  },
  // OpenAI
  {
    id: "gpt-5.1-codex-mini",
    label: "GPT-5.1 Codex Mini",
    provider: "OpenAI",
    tags: ["code", "fast"],
  },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex", provider: "OpenAI", tags: ["code", "flagship"] },
  { id: "gpt-5.5-pro", label: "GPT-5.5 Pro", provider: "OpenAI", tags: ["code", "flagship"] },
  { id: "gpt-5.5", label: "GPT-5.5", provider: "OpenAI", tags: ["code", "flagship"] },
  { id: "gpt-5.4-nano", label: "GPT-5.4 Nano", provider: "OpenAI", tags: ["code", "fast"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", provider: "OpenAI", tags: ["code", "fast"] },
  { id: "gpt-5.4", label: "GPT-5.4", provider: "OpenAI", tags: ["code"] },
  {
    id: "gpt-5-chat-latest",
    label: "GPT-5 Chat Latest",
    provider: "OpenAI",
    tags: ["code", "flagship"],
  },
  { id: "gpt-5", label: "GPT-5", provider: "OpenAI", tags: ["code", "flagship"] },
  { id: "gpt-4o", label: "GPT-4o", provider: "OpenAI", tags: ["code"] },
  { id: "o3", label: "o3", provider: "OpenAI", tags: ["code", "reasoning"] },
  // xAI
  { id: "grok-code-fast-1", label: "Grok Code Fast 1", provider: "xAI", tags: ["code", "fast"] },
];

export let imageModels = [
  // OpenAI image generation
  { id: "gpt-image-2", label: "GPT Image 2", provider: "OpenAI", tags: ["image", "flagship", "editor"] },
  { id: "gpt-image-1", label: "GPT Image 1", provider: "OpenAI", tags: ["image", "editor"] },
  {
    id: "gpt-image-1-mini",
    label: "GPT Image 1 Mini",
    provider: "OpenAI",
    tags: ["image", "fast", "editor"],
  },
  // Flux image generation
  { id: "black-forest-labs/flux-2-pro", label: "Flux 2 Pro", provider: "Flux", tags: ["image", "flagship"] },
  { id: "black-forest-labs/flux-2-dev", label: "Flux 2 Dev", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-2-flex", label: "Flux 2 Flex", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-2-max", label: "Flux 2 Max", provider: "Flux", tags: ["image", "flagship"] },
  { id: "black-forest-labs/flux-2-klein-4b", label: "Flux 2 Klein 4B", provider: "Flux", tags: ["image", "fast"] },
  { id: "black-forest-labs/flux-2-klein-9b", label: "Flux 2 Klein 9B", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-pro-1.1", label: "Flux Pro 1.1", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-1.1-pro-ultra", label: "Flux 1.1 Pro Ultra", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-pro", label: "Flux Pro", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-dev", label: "Flux Dev", provider: "Flux", tags: ["image"] },
  { id: "black-forest-labs/flux-schnell", label: "Flux Schnell", provider: "Flux", tags: ["image", "fast"] },
  // Google image generation
  {
    id: "gemini-2.5-flash-image",
    label: "Gemini 2.5 Flash Image",
    provider: "Google",
    tags: ["image", "fast"],
  },
  {
    id: "gemini-2.5-flash-image-preview",
    label: "Gemini 2.5 Flash Image Preview",
    provider: "Google",
    tags: ["image", "fast", "editor"],
  },
  {
    id: "gemini-3-pro-image-preview",
    label: "Gemini 3 Pro Image",
    provider: "Google",
    tags: ["image", "flagship"],
  },
  {
    id: "gemini-3.1-flash-image-preview",
    label: "Gemini 3.1 Flash Image",
    provider: "Google",
    tags: ["image", "fast"],
  },
  // Other image generation
  { id: "grok-2-image", label: "Grok-2 Image", provider: "xAI", tags: ["image"] },
  { id: "qwen-image", label: "Qwen Image", provider: "Alibaba", tags: ["image"] },
  { id: "recraft", label: "Recraft", provider: "Recraft", tags: ["image"] },
  { id: "magic-art-7.0", label: "Magic Art 7.0", provider: "Magic Art", tags: ["image", "flagship"] },
  { id: "magic-art-6.1", label: "Magic Art 6.1", provider: "Magic Art", tags: ["image"] },
  { id: "magic-art-5.2", label: "Magic Art 5.2", provider: "Magic Art", tags: ["image", "fast"] },
  // Image Text Editor models (Flux Kontext)
  {
    id: "black-forest-labs/flux-kontext-pro",
    label: "Flux Kontext Pro",
    provider: "Flux",
    tags: ["image", "flagship", "editor"],
  },
  {
    id: "black-forest-labs/flux-kontext-max",
    label: "Flux Kontext Max",
    provider: "Flux",
    tags: ["image", "flagship", "editor"],
  },
  {
    id: "black-forest-labs/flux-kontext-dev-lora",
    label: "Flux Kontext Dev LoRA",
    provider: "Flux",
    tags: ["image", "editor"],
  },
  { id: "black-forest-labs/flux-kontext-dev", label: "Flux Kontext Dev", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-depth-dev", label: "Flux Depth Dev", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-depth-pro", label: "Flux Depth Pro", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-canny-pro", label: "Flux Canny Pro", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-canny-dev", label: "Flux Canny Dev", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-2-pro-editor", label: "Flux 2 Pro (Editor)", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-2-dev-editor", label: "Flux 2 Dev (Editor)", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-2-flex-editor", label: "Flux 2 Flex (Editor)", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-2-max-editor", label: "Flux 2 Max (Editor)", provider: "Flux", tags: ["image", "editor"] },
  { id: "black-forest-labs/flux-2-klein-4b-editor", label: "Flux 2 Klein 4B (Editor)", provider: "Flux", tags: ["image", "editor", "fast"] },
  // Google image text editor
  {
    id: "gemini-3-pro-image-preview-editor",
    label: "Gemini 3 Pro Image (Editor)",
    provider: "Google",
    tags: ["image", "flagship", "editor"],
  },
  {
    id: "gemini-3.1-flash-image-preview-editor",
    label: "Gemini 3.1 Flash Image (Editor)",
    provider: "Google",
    tags: ["image", "editor", "fast"],
  },
  // Other image text editor
  { id: "qwen-image-edit-plus", label: "Qwen Image Edit Plus", provider: "Alibaba", tags: ["image", "editor"] },
];

export async function initModels() {
  await fetchModels();
  setInterval(fetchModels, 30 * 60 * 1000).unref();
}

async function fetchModels() {
  try {
    const data = await callOneMin('/api/models');
    if (data && Array.isArray(data.models)) {
      const newChatModels = data.models.filter(m => m.type === 'CHAT');
      const newCodeModels = data.models.filter(m => m.type === 'CODE_GENERATOR');
      const newImageModels = data.models.filter(m => m.type === 'IMAGE_GENERATOR' || m.type === 'IMAGE_EDITOR');

      if (newChatModels.length > 0) chatModels = newChatModels;
      if (newCodeModels.length > 0) codeModels = newCodeModels;
      if (newImageModels.length > 0) imageModels = newImageModels;
      
      logger.info('Models dynamically fetched and updated from 1min.ai API.');
    }
  } catch (err) {
    logger.debug('Failed to fetch models dynamically. Using hardcoded fallback models.', { error: err.message });
  }
}
