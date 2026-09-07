/**
 * Agent Chat Route — uses CODE_GENERATOR (/api/features) for the coding agent mode.
 *
 * The agent loop needs a general-purpose LLM chat to handle system prompts,
 * multi-turn conversation (flattened into a single prompt), and XML tool call outputs.
 *
 * API Reference: https://docs.1min.ai/docs/api/ai-for-code/code-generator/code-generator-tag
 */

import express from 'express';
import { z } from 'zod';
import { HttpError } from '../utils/errors.js';
import {
  callOneMin,
  extractText,
  isFailedResponse,
  extractFailureMessage,
  normalizeOneMinRawResponse,
} from '../utils/api-client.js';
import { parseWebSearchParams, buildCodePayload } from '../utils/web-search.js';
import logger from '../utils/logger.js';
import { serverConfig } from '../config/server.js';

const router = express.Router();
const CODE_GENERATOR_FEATURE_ENDPOINT = '/api/features?isStreaming=true';
const MAX_AGENT_PROMPT_CHARS = 200000;
const MAX_AGENT_MESSAGES = 100;
const MAX_AGENT_MESSAGE_CHARS = 50000;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Flatten a messages array into a single prompt string with role labels.
 * This preserves the conversation flow so the LLM can infer context.
 */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages
    .map((m) => {
      // SEC: Sanitize role to prevent XML attribute injection.
      // Only allow alphanumeric characters and common role names.
      const rawRole = (m.role || 'user').toLowerCase();
      const role = rawRole.replace(/[^a-z0-9_-]/g, '').slice(0, 50) || 'user';
      const content = typeof m.content === 'string' ? m.content : '';
      // Avoid double-escaping by wrapping content inside CDATA block.
      // Safely escape any existing ']]>' sequence by breaking the CDATA block and restarting.
      const safeContent = content.replace(/\]\]>/g, ']]]]><![CDATA[>');
      return `<message role="${role}"><![CDATA[\n${safeContent}\n]]></message>`;
    })
    .join('\n\n');
}

const agentChatSchema = z
  .object({
    prompt: z.string().max(50000, 'prompt exceeds 50000 characters').optional(),
    messages: z
      .array(
        z.object({
          role: z.string().max(50, 'message role is too long').default('user'),
          content: z.string().max(MAX_AGENT_MESSAGE_CHARS, 'message content is too long').default(''),
        }),
      )
      .max(MAX_AGENT_MESSAGES, `messages exceeds ${MAX_AGENT_MESSAGES} entries`)
      .optional(),
    model: z.string().max(100, 'model is too long').optional(),
    webSearch: z.preprocess((val) => val === 'true' || val === true, z.boolean().default(false)),
    numOfSite: z.preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
      z.number().int().optional(),
    ),
    maxWord: z.preprocess(
      (val) => (val !== undefined && val !== '' ? Number(val) : undefined),
      z.number().int().optional(),
    ),
  })
  .superRefine((data, ctx) => {
    const promptText =
      Array.isArray(data.messages) && data.messages.length > 0 ? flattenMessages(data.messages) : data.prompt;
    if (!promptText || !String(promptText).trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'prompt or messages is required',
      });
    } else if (String(promptText).length > MAX_AGENT_PROMPT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `prompt exceeds ${MAX_AGENT_PROMPT_CHARS} characters`,
      });
    }
  });

// ---------------------------------------------------------------------------
// POST /api/agent/chat
// ---------------------------------------------------------------------------

router.post('/chat', async (req, res, next) => {
  try {
    // 1. Validate request body
    const result = agentChatSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }

    const data = result.data;

    // 2. Build prompt text from messages (array) or plain prompt string
    const promptText =
      Array.isArray(data.messages) && data.messages.length > 0 ? flattenMessages(data.messages) : data.prompt;

    // 3. Parse web search params via shared helper
    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    // 4. Build CODE_GENERATOR payload
    const payload = buildCodePayload({
      prompt: String(promptText),
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    logger.debug('Agent chat request', {
      model: payload.model,
      webSearch: parsedWebSearch,
      promptLength: String(promptText).length,
      type: payload.type,
    });

    // 5. Call 1min.ai /api/features (CODE_GENERATOR)
    const dataRes = await callOneMin(CODE_GENERATOR_FEATURE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
      // SEC: CODE_GENERATOR creates an upstream record; never retry a POST
      // that would duplicate the side effect / credit consumption.
      idempotent: false,
      timeout: serverConfig.agentChatTimeoutMs,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes, {
      context: 'Code Generator agent-chat',
    });

    // 6. Handle upstream failure
    if (isFailedResponse(normalizedDataRes)) {
      throw new HttpError(
        502,
        `1min.ai agent chat failed: ${extractFailureMessage(normalizedDataRes)}`,
        'UPSTREAM_API_ERROR',
        normalizedDataRes,
      );
    }

    // 7. Extract text and return in agent-friendly format
    const text = extractText(normalizedDataRes);
    res.json({ text, raw: normalizedDataRes });
  } catch (err) {
    next(err);
  }
});

export default router;
