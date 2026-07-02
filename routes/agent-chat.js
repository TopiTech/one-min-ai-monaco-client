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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function escapeXmlText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Flatten a messages array into a single prompt string with role labels.
 * This preserves the conversation flow so the LLM can infer context.
 */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages
    .map((m) => {
      const role = (m.role || 'user').toLowerCase();
      const content = typeof m.content === 'string' ? m.content : '';
      const escapedContent = escapeXmlText(content);
      return `<message role="${role}">\n${escapedContent}\n</message>`;
    })
    .join('\n\n');
}

const agentChatSchema = z
  .object({
    prompt: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.string().default('user'),
          content: z.string().default(''),
        }),
      )
      .optional(),
    model: z.string().optional(),
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
      timeout: serverConfig.agentChatTimeoutMs,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes);

    // 6. Handle upstream failure
    if (isFailedResponse(normalizedDataRes)) {
      const err = new Error(`1min.ai agent chat failed: ${extractFailureMessage(normalizedDataRes)}`);
      err.status = 502;
      err.payload = normalizedDataRes;
      throw err;
    }

    // 7. Extract text and return in agent-friendly format
    const text = extractText(normalizedDataRes);
    res.json({ text, raw: normalizedDataRes });
  } catch (err) {
    next(err);
  }
});

export default router;
