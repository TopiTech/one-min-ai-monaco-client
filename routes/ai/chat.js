import express from 'express';
import { z } from 'zod';
import {
  callOneMin,
  isFailedResponse,
  extractFailureMessage,
  parseResponsePayload,
} from '../../utils/api-client.js';
import { HttpError } from '../../utils/errors.js';
import logger from '../../utils/logger.js';
import { serverConfig } from '../../config/server.js';
import { shouldExposeErrorText } from '../../server.js';
import { assertCapability, getProvider, resolveProviderId } from '../../providers/index.js';
import { consumeOpenAiSseStream, readBoundedResponseText } from '../../utils/sse.js';
import { bindRequestAbortSignal, booleanFlagInput, getDefaultModel, optionalNumberInput } from './utils.js';

const router = express.Router();

const rawAttachmentsSchema = z
  .preprocess(
    (val) => {
      if (val == null) return undefined;
      return val;
    },
    z
      .any()
      .superRefine((val, ctx) => {
        if (val === undefined) return;
        if (typeof val !== 'object' || Array.isArray(val)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'attachments must be an object',
          });
          return;
        }
        const looksLikeAssetRef = (s) =>
          typeof s === 'string' &&
          s.length <= 1024 &&
          (/^https?:\/\//i.test(s) || /^[A-Za-z0-9._/-]+$/.test(s));

        const validateList = (list, name) => {
          if (list !== undefined) {
            if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !looksLikeAssetRef(x))) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `attachments.${name} must be an array of URLs or 1min.ai asset keys`,
              });
            } else if (list.length > 16) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `attachments.${name} exceeds 16 entries`,
              });
            }
          }
        };

        validateList(val.images, 'images');
        validateList(val.files, 'files');
      })
      .transform((val) => {
        if (val === undefined || typeof val !== 'object' || Array.isArray(val)) return undefined;
        const out = {};
        const cleanList = (list) => {
          if (list === undefined || !Array.isArray(list)) return undefined;
          const cleaned = list.map((x) => (typeof x === 'string' ? x.slice(0, 1024) : '')).filter(Boolean);
          return cleaned.length ? cleaned : undefined;
        };
        const images = cleanList(val.images);
        const files = cleanList(val.files);
        if (images) out.images = images;
        if (files) out.files = files;
        return Object.keys(out).length ? out : undefined;
      }),
  )
  .optional();

const chatMessageSchema = z.object({
  role: z.string().max(50).default('user'),
  content: z.string().max(50000).default(''),
});

const chatRequestSchema = z
  .object({
    provider: z.enum(['1min', '1forall']).optional(),
    prompt: z.preprocess(
      (val) => (val === undefined || val === null ? '' : String(val)),
      z.string().refine((val) => val.length <= 50000, {
        message: 'prompt exceeds maximum length of 50000 characters',
      }),
    ),
    messages: z.array(chatMessageSchema).max(200).optional(),
    model: z.string().optional(),
    maxTokens: optionalNumberInput(z.number().int().min(1).max(32768).optional()),
    conversationId: z.string().optional(),
    attachments: rawAttachmentsSchema,
    webSearch: booleanFlagInput(false),
    numOfSite: optionalNumberInput(
      z
        .number()
        .int()
        .min(1, { message: 'numOfSite must be a number between 1 and 10' })
        .max(10, { message: 'numOfSite must be a number between 1 and 10' })
        .optional(),
    ),
    maxWord: optionalNumberInput(
      z
        .number()
        .int()
        .min(100, { message: 'maxWord must be a number between 100 and 10000' })
        .max(10000, { message: 'maxWord must be a number between 100 and 10000' })
        .optional(),
    ),
    history: booleanFlagInput(true),
    withMemories: booleanFlagInput(false),
    brandVoiceId: z.string().optional(),
    isMixed: booleanFlagInput(false),
  })
  .superRefine((data, ctx) => {
    const hasPrompt = data.prompt.trim().length > 0;
    const hasMessages =
      Array.isArray(data.messages) && data.messages.some((m) => String(m.content || '').trim().length > 0);
    if (!hasPrompt && !hasMessages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt is required',
      });
    }
  });

/** @param {Record<string, any>} params */
function buildChatPayload({
  prompt,
  messages,
  model,
  conversationId,
  attachments,
  webSearch,
  numOfSite,
  maxWord,
  history,
  withMemories,
  brandVoiceId,
  isMixed,
}) {
  const effectivePrompt =
    prompt && prompt.trim()
      ? String(prompt)
      : Array.isArray(messages)
        ? messages
            .filter((m) => String(m.content || '').trim())
            .map((m) => `${m.role}: ${m.content}`)
            .join('\n\n')
        : '';

  return {
    type: 'UNIFY_CHAT_WITH_AI',
    model: model || getDefaultModel('CHAT'),
    promptObject: {
      prompt: effectivePrompt,
      settings: {
        webSearchSettings: {
          webSearch: Boolean(webSearch),
          ...(numOfSite !== undefined ? { numOfSite: Number(numOfSite) } : {}),
          ...(maxWord !== undefined ? { maxWord: Number(maxWord) } : {}),
        },
        historySettings: {
          isMixed: Boolean(isMixed),
          historyMessageLimit: history ? 10 : 0,
        },
        withMemories: Boolean(withMemories),
      },
      ...(conversationId ? { conversationId } : {}),
      ...(attachments ? { attachments } : {}),
    },
    ...(brandVoiceId ? { brandVoiceId } : {}),
  };
}

function validateProviderChatCapabilities(providerId, data) {
  if (data.webSearch) assertCapability(providerId, 'webSearch', 'Web search');
  if (data.withMemories) assertCapability(providerId, 'memories', 'AI memories');
  if (data.attachments) assertCapability(providerId, 'chatAttachments', 'Chat attachments');
  if (data.conversationId) assertCapability(providerId, 'serverConversations', 'Server-side conversationId');
  if (data.brandVoiceId) assertCapability(providerId, 'serverConversations', 'Brand voice');
}

function parseChatRequest(body) {
  const result = chatRequestSchema.safeParse(body);
  if (!result.success) {
    const errorMsg = result.error.issues[0]?.message || 'Validation error';
    return { error: { status: 400, message: errorMsg } };
  }
  const data = result.data;
  const providerId = resolveProviderId(data.provider);
  validateProviderChatCapabilities(providerId, data);

  const payload = providerId === '1min' ? buildChatPayload(data) : null;
  return { providerId, data, payload };
}

router.post('/', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const { error, providerId, data, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    if (providerId === '1forall') {
      const provider = getProvider('1forall');
      const result = await provider.chat({
        prompt: data.prompt,
        messages: data.messages,
        model: data.model,
        maxTokens: data.maxTokens,
        signal: controller.signal,
      });
      return res.json(result);
    }

    const responseData = await callOneMin('/api/chat-with-ai', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
      signal: controller.signal,
    });
    if (isFailedResponse(responseData)) {
      throw new HttpError(
        502,
        `1min.ai chat failed: ${extractFailureMessage(responseData)}`,
        'UPSTREAM_API_ERROR',
        responseData,
      );
    }
    res.json(responseData);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    if (controller.signal.aborted && !res.headersSent) {
      return res.status(499).json({ error: 'Client Closed Request' });
    }
    next(err);
  } finally {
    cleanup();
  }
});

function setSseHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

function flushRes(res) {
  if (typeof (/** @type {any} */ (res).flush) === 'function') {
    /** @type {any} */ (res).flush();
  }
}

async function handleOneForAllChatStream(req, res, data, controller) {
  const provider = getProvider('1forall');
  const { response, format } = await provider.openChatStream({
    prompt: data.prompt,
    messages: data.messages,
    model: data.model,
    maxTokens: data.maxTokens,
    signal: controller.signal,
  });

  setSseHeaders(res);

  if (format === '1min-sse') {
    if (controller.signal.aborted || res.writableEnded || res.destroyed) {
      await response.body?.cancel?.().catch(() => {});
      return;
    }
    const { text: bodyText, truncated } = await readBoundedResponseText(response);
    if (truncated) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: 'Upstream stream exceeded maximum size' })}\n\n`,
        );
        flushRes(res);
        res.end();
      }
      return;
    }
    if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      res.write(bodyText);
      flushRes(res);
      res.end();
    }
    return;
  }

  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(':\n\n');
      flushRes(res);
    }
  }, 15_000);
  heartbeatInterval.unref?.();

  let streamErrorMsg = null;
  let accumulated = '';
  let finalUsage = null;
  try {
    const result = await consumeOpenAiSseStream(response, {
      signal: controller.signal,
      onContent: (chunk) => {
        accumulated += chunk;
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: content\ndata: ${JSON.stringify({ content: chunk })}\n\n`);
          flushRes(res);
        }
      },
      onError: (msg) => {
        streamErrorMsg = msg;
      },
      onDone: ({ usage }) => {
        finalUsage = usage || null;
      },
    });

    if (streamErrorMsg) {
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: streamErrorMsg })}\n\n`);
        flushRes(res);
      }
      return;
    }

    const finalText = result.text || accumulated;
    if (!res.writableEnded && !res.destroyed) {
      const finalRecord = {
        aiRecord: {
          status: 'SUCCESS',
          model: data.model || serverConfig.defaultChatModel1ForAll,
          aiRecordDetail: { resultObject: [finalText] },
          ...(finalUsage ? { usage: finalUsage } : {}),
        },
      };
      res.write(`event: final-result\ndata: ${JSON.stringify(finalRecord)}\n\n`);
      res.write('data: [DONE]\n\n');
      flushRes(res);
    }
  } catch (streamErr) {
    if (controller.signal.aborted || streamErr?.name === 'AbortError') {
      logger.info('1forall stream reading aborted due to client disconnection.');
    } else if (!res.writableEnded && !res.destroyed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Upstream stream interrupted' })}\n\n`);
    }
  } finally {
    clearInterval(heartbeatInterval);
    if (!res.writableEnded) res.end();
  }
}

router.post('/stream', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const { error, providerId, data, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    if (providerId === '1forall') {
      await handleOneForAllChatStream(req, res, data, controller);
      return;
    }

    const response = await callOneMin('/api/chat-with-ai?isStreaming=true', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
      signal: controller.signal,
      idempotent: false,
      timeout: serverConfig.apiStreamTimeoutMs,
    });

    if (controller.signal.aborted) {
      await response.body?.cancel?.().catch(() => {});
      return;
    }

    if (!response.ok) {
      const errorPayload = await parseResponsePayload(response);
      const exposeErrorText = shouldExposeErrorText(response.status, req);
      return res.status(response.status).json({
        error: `1min.ai API error: ${response.status}`,
        details: exposeErrorText
          ? errorPayload?.error?.message || errorPayload?.message || 'Upstream API Error'
          : 'Upstream API Error',
      });
    }

    if (response.headers.get('content-type')?.includes('application/json')) {
      const jsonData = await response.json().catch(() => null);
      if (isFailedResponse(jsonData)) {
        throw new HttpError(
          502,
          `1min.ai conversation failed: ${extractFailureMessage(jsonData)}`,
          'UPSTREAM_API_ERROR',
          jsonData,
        );
      }
      if (!res.writableEnded && !res.destroyed) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.write(`event: final-result\ndata: ${JSON.stringify(jsonData)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
      return;
    }

    if (!response.body) {
      throw new HttpError(502, '1min.ai stream returned empty response body', 'UPSTREAM_API_ERROR');
    }

    setSseHeaders(res);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(':\n\n');
        flushRes(res);
      }
    }, 15_000);
    heartbeatInterval.unref?.();

    const resultBlocks = [];
    const doneBlocks = [];
    let carry = '';
    let totalStreamBytes = 0;
    let streamLimitExceeded = false;
    let readerFinished = false;
    const MAX_STREAM_BYTES = 50 * 1024 * 1024;

    const normalizeResultBlock = (block) => {
      const lines = block.split(/\r?\n/);
      let replaced = false;
      return lines
        .map((line) => {
          if (!replaced && line.startsWith('event:')) {
            replaced = true;
            return 'event: final-result';
          }
          return line;
        })
        .join('\n');
    };

    const classifySseBlock = (block) => {
      const trimmedBlock = block.trim();
      if (!trimmedBlock) return { type: 'ignore', block: '' };

      let eventName = 'message';
      const dataLines = [];
      for (const line of trimmedBlock.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trim());
        }
      }

      if (eventName === 'result' || eventName === 'final-result') {
        return { type: 'result', block: trimmedBlock };
      }
      if (
        eventName === 'done' ||
        (eventName === 'message' && dataLines.length === 1 && dataLines[0] === '[DONE]')
      ) {
        return { type: 'done', block: trimmedBlock };
      }

      return {
        type: 'forward',
        block: trimmedBlock,
      };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          readerFinished = true;
          break;
        }
        totalStreamBytes += value?.byteLength ?? value?.length ?? 0;
        if (totalStreamBytes > MAX_STREAM_BYTES) {
          logger.warn('SSE stream exceeded max size, aborting', { totalStreamBytes });
          streamLimitExceeded = true;
          break;
        }
        carry += decoder.decode(value, { stream: true });

        const blocks = carry.split(/\r?\n\r?\n/);
        carry = blocks.pop() || '';

        for (const block of blocks) {
          const classified = classifySseBlock(block);
          if (classified.type === 'result') {
            resultBlocks.push(classified.block);
            continue;
          }
          if (classified.type === 'done') {
            doneBlocks.push(classified.block);
            continue;
          }
          if (classified.type === 'forward' && !res.writableEnded && !res.destroyed) {
            res.write(classified.block + '\n\n');
            flushRes(res);
          }
        }
      }

      const tail = decoder.decode();
      if (tail) carry += tail;

      if (carry.trim()) {
        const classified = classifySseBlock(carry);
        if (classified.type === 'result') {
          resultBlocks.push(classified.block);
        } else if (classified.type === 'done') {
          doneBlocks.push(classified.block);
        } else if (classified.type === 'forward' && !res.writableEnded && !res.destroyed) {
          res.write(classified.block + '\n\n');
          flushRes(res);
        }
      }

      if (resultBlocks.length > 0 && !res.writableEnded && !res.destroyed) {
        for (const resultBlock of resultBlocks) {
          res.write(normalizeResultBlock(resultBlock) + '\n\n');
        }
        flushRes(res);
      }
      if (doneBlocks.length > 0 && !res.writableEnded && !res.destroyed) {
        for (const doneBlock of doneBlocks) {
          res.write(doneBlock + '\n\n');
        }
        flushRes(res);
      }
    } catch (streamErr) {
      if (controller.signal.aborted || streamErr.name === 'AbortError') {
        logger.info('Stream reading aborted due to client disconnection.');
      } else {
        logger.warn('Stream interrupted', { error: streamErr.message });
        if (!res.writableEnded && !res.destroyed) {
          res.write(`event: error\ndata: ${JSON.stringify({ error: 'Upstream stream interrupted' })}\n\n`);
        }
      }
    } finally {
      if (!readerFinished) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }
      if (streamLimitExceeded && !res.writableEnded && !res.destroyed) {
        res.write(`event: error\ndata: ${JSON.stringify({ error: 'Stream exceeded maximum size' })}\n\n`);
      }
      clearInterval(heartbeatInterval);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    }
  } catch (err) {
    if (err.name === 'AbortError' || err.status === 499) {
      logger.info('Stream request aborted as client disconnected.');
      if (!res.headersSent) {
        res.status(499).json({ error: 'Client Closed Request' });
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      next(err);
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    cleanup();
  }
});

export default router;
