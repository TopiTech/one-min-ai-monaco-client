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
import { getDefaultModel } from './utils.js';

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

const chatRequestSchema = z.object({
  prompt: z.preprocess(
    (val) => (val === undefined || val === null ? '' : String(val)),
    z
      .string()
      .refine((val) => val.trim().length > 0, { message: 'prompt is required' })
      .refine((val) => val.length <= 50000, { message: 'prompt exceeds maximum length of 50000 characters' }),
  ),
  model: z.string().optional(),
  conversationId: z.string().optional(),
  attachments: rawAttachmentsSchema,
  webSearch: z.preprocess((val) => val === 'true' || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess(
    (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
    z.number().int().optional(),
  ),
  maxWord: z.preprocess(
    (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
    z.number().int().optional(),
  ),
  history: z.preprocess(
    (val) => (val === undefined ? true : val === 'true' || val === true),
    z.boolean().default(true),
  ),
  withMemories: z.preprocess((val) => val === 'true' || val === true, z.boolean().default(false)),
  brandVoiceId: z.string().optional(),
  isMixed: z.preprocess((val) => val === 'true' || val === true, z.boolean().default(false)),
});

function buildChatPayload({
  prompt,
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
  return {
    type: 'UNIFY_CHAT_WITH_AI',
    model: model || getDefaultModel('CHAT'),
    promptObject: {
      prompt: String(prompt),
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

function parseChatRequest(body) {
  const result = chatRequestSchema.safeParse(body);
  if (!result.success) {
    const errorMsg = result.error.issues[0]?.message || 'Validation error';
    return { error: { status: 400, message: errorMsg } };
  }
  const data = result.data;
  const payload = buildChatPayload({
    prompt: data.prompt,
    model: data.model,
    conversationId: data.conversationId,
    attachments: data.attachments,
    webSearch: data.webSearch,
    numOfSite: data.numOfSite,
    maxWord: data.maxWord,
    history: data.history,
    withMemories: data.withMemories,
    brandVoiceId: data.brandVoiceId,
    isMixed: data.isMixed,
  });
  return { payload };
}

router.post('/', async (req, res, next) => {
  try {
    const { error, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    const data = await callOneMin('/api/chat-with-ai', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      idempotent: false,
    });
    if (isFailedResponse(data)) {
      throw new HttpError(
        502,
        `1min.ai chat failed: ${extractFailureMessage(data)}`,
        'UPSTREAM_API_ERROR',
        data,
      );
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post('/stream', async (req, res, next) => {
  try {
    const { error, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        logger.info('Client closed the connection. Aborting stream request.');
        controller.abort();
      }
    });

    const response = await callOneMin('/api/chat-with-ai?isStreaming=true', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
      signal: controller.signal,
      idempotent: false,
      timeout: serverConfig.apiStreamTimeoutMs,
    });

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
      const data = await response.json().catch(() => null);
      if (isFailedResponse(data)) {
        throw new HttpError(
          502,
          `1min.ai conversation failed: ${extractFailureMessage(data)}`,
          'UPSTREAM_API_ERROR',
          data,
        );
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`event: result\ndata: ${JSON.stringify(data)}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(':\n\n');
        if (typeof (/** @type {any} */ (res).flush) === 'function') /** @type {any} */ (res).flush();
      }
    }, 15_000);

    let resultBlocks = [];
    let carry = '';
    let totalStreamBytes = 0;
    const MAX_STREAM_BYTES = 50 * 1024 * 1024; // 50MB safety limit

    const normalizeResultBlock = (block) => {
      const lines = block.split('\n');
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
      for (const line of trimmedBlock.split(/\r?\n/)) {
        if (line.startsWith('event:')) {
          eventName = line.slice(6).trim() || 'message';
          break;
        }
      }

      return {
        type: eventName === 'result' ? 'result' : 'forward',
        block: trimmedBlock,
      };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalStreamBytes += value?.byteLength ?? value?.length ?? 0;
        if (totalStreamBytes > MAX_STREAM_BYTES) {
          logger.warn('SSE stream exceeded max size, aborting', { totalStreamBytes });
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
          if (classified.type === 'forward') {
            res.write(classified.block + '\n\n');
            if (typeof (/** @type {any} */ (res).flush) === 'function') /** @type {any} */ (res).flush();
          }
        }
      }

      const tail = decoder.decode();
      if (tail) carry += tail;

      if (carry.trim()) {
        const classified = classifySseBlock(carry);
        if (classified.type === 'result') {
          resultBlocks.push(classified.block);
        } else if (classified.type === 'forward') {
          res.write(classified.block + '\n\n');
          if (typeof (/** @type {any} */ (res).flush) === 'function') /** @type {any} */ (res).flush();
        }
      }

      if (resultBlocks.length > 0) {
        for (const resultBlock of resultBlocks) {
          res.write(normalizeResultBlock(resultBlock) + '\n\n');
        }
        if (typeof (/** @type {any} */ (res).flush) === 'function') /** @type {any} */ (res).flush();
      }
    } catch (streamErr) {
      if (controller.signal.aborted || streamErr.name === 'AbortError') {
        logger.info('Stream reading aborted due to client disconnection.');
      } else {
        logger.warn('Stream interrupted', { error: streamErr.message });
      }
    } finally {
      clearInterval(heartbeatInterval);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
      res.end();
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
  }
});

export default router;
