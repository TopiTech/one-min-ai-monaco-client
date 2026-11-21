import logger from './logger.js';
import { sanitizeLogText } from './sanitize.js';

export const DEFAULT_MAX_SSE_BYTES = 50 * 1024 * 1024;

/**
 * Iterates raw SSE event blocks (`\r?\n\r?\n`-delimited) from a Fetch Response body.
 * Enforces a byte budget and handles aborted readers cleanly.
 *
 * @param {Response} response
 * @param {{ maxBytes?: number, signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<string, { truncated: boolean, totalBytes: number }, void>}
 */
export async function* readSseBlocks(response, { maxBytes = DEFAULT_MAX_SSE_BYTES, signal } = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader) {
    return { truncated: false, totalBytes: 0 };
  }
  const decoder = new TextDecoder();
  let carry = '';
  let totalBytes = 0;
  let truncated = false;
  let reachedEof = false;

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      totalBytes += value?.byteLength ?? value?.length ?? 0;
      if (totalBytes > maxBytes) {
        logger.warn('SSE stream exceeded max size, aborting', { totalBytes });
        truncated = true;
        break;
      }
      carry += decoder.decode(value, { stream: true });
      const blocks = carry.split(/\r?\n\r?\n/);
      carry = blocks.pop() || '';
      for (const block of blocks) {
        if (block.trim()) yield block.trim();
      }
    }
    const tail = decoder.decode();
    if (tail) carry += tail;
    if (carry.trim() && !truncated && !signal?.aborted) {
      yield carry.trim();
    }
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
  return { truncated, totalBytes };
}

/**
 * Parses an OpenAI-compatible SSE stream (`data: {...}` / `data: [DONE]`) and
 * forwards normalized chunks to callbacks.
 *
 * Both 1min.ai (/openai/v1/chat/completions) and 1forall.ai (/v1/chat/completions)
 * specify that a stream terminating without `[DONE]` (unless explicitly errored)
 * should be treated as incomplete.
 *
 * @param {Response} response
 * @param {object} callbacks
 * @param {(text: string) => void} callbacks.onContent
 * @param {(errMsg: string) => void} [callbacks.onError]
 * @param {(meta: { usage?: any, finishReason?: string | null, sawDone: boolean }) => void} [callbacks.onDone]
 * @param {AbortSignal} [callbacks.signal]
 * @param {number} [callbacks.maxBytes]
 */
export async function consumeOpenAiSseStream(
  response,
  { onContent, onError, onDone, signal, maxBytes = DEFAULT_MAX_SSE_BYTES },
) {
  let sawDone = false;
  let finishReason = null;
  let usage = null;
  const fullChunks = [];

  const blocks = readSseBlocks(response, { maxBytes, signal });
  for await (const block of blocks) {
    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr) continue;
      if (dataStr === '[DONE]') {
        sawDone = true;
        break;
      }

      let parsed;
      try {
        parsed = JSON.parse(dataStr);
      } catch {
        logger.warn(`Failed to parse OpenAI SSE JSON chunk: ${sanitizeLogText(dataStr, 256)}`);
        continue;
      }

      if (parsed?.error) {
        const msg =
          parsed.error?.message || (typeof parsed.error === 'string' ? parsed.error : 'Stream error');
        onError?.(msg);
        return { text: fullChunks.join(''), sawDone, sawError: true, finishReason, usage };
      }

      if (parsed?.usage) {
        usage = parsed.usage;
      }

      const choice = parsed?.choices?.[0];
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (typeof delta === 'string' && delta.length > 0) {
        fullChunks.push(delta);
        onContent?.(delta);
      }
    }
    if (sawDone) break;
  }

  if (!sawDone && !signal?.aborted) {
    onError?.('Upstream OpenAI-compatible stream ended without [DONE]');
    return { text: fullChunks.join(''), sawDone: false, sawError: true, finishReason, usage };
  }

  const text = fullChunks.join('');
  onDone?.({ usage, finishReason, sawDone });
  return { text, sawDone, sawError: false, finishReason, usage };
}

/**
 * Normalizes a non-streaming OpenAI-style text answer into 1min-compatible SSE frames
 * so the frontend SSE parser handles both streaming and fallback responses identically.
 *
 * @param {string} text
 * @param {{ model?: string, usage?: any }} [meta]
 * @returns {string}
 */
export function buildSyntheticSseBody(text, meta = {}) {
  const safeText = typeof text === 'string' ? text : '';
  const resultRecord = {
    aiRecord: {
      status: 'SUCCESS',
      model: meta.model || '',
      aiRecordDetail: {
        resultObject: [safeText],
      },
      ...(meta.usage ? { usage: meta.usage } : {}),
    },
  };
  return (
    `event: content\ndata: ${JSON.stringify({ content: safeText })}\n\n` +
    `event: final-result\ndata: ${JSON.stringify(resultRecord)}\n\n` +
    `data: [DONE]\n\n`
  );
}
