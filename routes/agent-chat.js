/**
 * Agent Chat Route — routes to 1min.ai (hybrid OpenAI-compat / CODE_GENERATOR)
 * or 1forall.ai (/v1/chat/completions) while keeping XML tool formatting intact.
 */

import express from 'express';
import { z } from 'zod';
import { extractText } from '../utils/api-client.js';
import { parseWebSearchParams, stripSearchArtifacts } from '../utils/web-search.js';
import logger from '../utils/logger.js';
import { serverConfig } from '../config/server.js';
import { assertCapability, getProvider, resolveProviderId } from '../providers/index.js';

const router = express.Router();
export const MAX_AGENT_PROMPT_CHARS = 200000;
export const MAX_AGENT_MESSAGES = 100;
export const MAX_AGENT_MESSAGE_CHARS = 50000;

/**
 * Flatten a messages array into a single prompt string with role labels.
 * This preserves the conversation flow when routing via CODE_GENERATOR.
 */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages
    .map((m) => {
      const rawRole = (m.role || 'user').toLowerCase();
      const role = rawRole.replace(/[^a-z0-9_-]/g, '').slice(0, 50) || 'user';
      const content = typeof m.content === 'string' ? m.content : '';
      const safeContent = content.replace(/\]\]>/g, ']]]]><![CDATA[>');
      return `<message role="${role}"><![CDATA[\n${safeContent}\n]]></message>`;
    })
    .join('\n\n');
}

export const agentChatSchema = z
  .object({
    provider: z.enum(['1min', '1forall']).optional(),
    useOpenAiCompat: z.boolean().optional(),
    prompt: z
      .string()
      .max(MAX_AGENT_MESSAGE_CHARS, `prompt exceeds ${MAX_AGENT_MESSAGE_CHARS} characters`)
      .optional(),
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

router.post('/chat', async (req, res, next) => {
  try {
    const result = agentChatSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
      return res.status(400).json({ error: errorMsg });
    }

    const data = result.data;
    const providerId = resolveProviderId(data.provider);
    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });
    if (parsedWebSearch) {
      assertCapability(providerId, 'webSearch', 'Web search');
    }

    const promptText =
      Array.isArray(data.messages) && data.messages.length > 0 ? flattenMessages(data.messages) : data.prompt;

    logger.debug('Agent chat request', {
      provider: providerId,
      model: data.model,
      webSearch: parsedWebSearch,
      promptLength: String(promptText).length,
    });

    const provider = getProvider(providerId);
    const normalizedDataRes = await provider.codeComplete({
      prompt: String(promptText),
      messages: data.messages,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
      useOpenAiCompat: data.useOpenAiCompat,
      task: 'agent',
      context: 'Code Generator agent-chat',
      maxTokens: serverConfig.oneForAllMaxTokensChat,
      timeout: serverConfig.agentChatTimeoutMs,
    });

    const rawText = extractText(normalizedDataRes);
    const text = stripSearchArtifacts(rawText);
    res.json({ text, raw: normalizedDataRes });
  } catch (err) {
    next(err);
  }
});

export default router;
