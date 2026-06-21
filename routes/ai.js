import express from "express";
import { z } from "zod";
import { callOneMin, extractText, isFailedResponse, extractFailureMessage, parseResponsePayload } from "../utils/api-client.js";
import { getChatModels, getCodeModels, getImageModels } from "../config/models.js";
import { parseWebSearchParams, buildCodePayload } from "../utils/web-search.js";
import logger from "../utils/logger.js";

const router = express.Router();

import { serverConfig } from "../config/server.js";

function getDefaultModel(type) {
  if (type === "CODE_GENERATOR") return serverConfig.defaultCodeModel;
  if (type === "IMAGE_GENERATOR") return serverConfig.defaultImageModel;
  if (type === "IMAGE_EDITOR") return serverConfig.defaultImageEditorModel;
  return serverConfig.defaultChatModel;
}

const rawAttachmentsSchema = z.preprocess((val) => {
  if (val == null) return undefined;
  return val;
}, z.any().superRefine((val, ctx) => {
  if (val === undefined) return;
  if (typeof val !== "object" || Array.isArray(val)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "attachments must be an object"
    });
    return;
  }
  const looksLikeAssetRef = (s) =>
    typeof s === "string" && s.length <= 1024 && (/^https?:\/\//i.test(s) || /^[A-Za-z0-9._/-]+$/.test(s));

  if (val.images !== undefined) {
    if (!Array.isArray(val.images) || val.images.some((x) => typeof x !== "string" || !looksLikeAssetRef(x))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachments.images must be an array of URLs or 1min.ai asset keys"
      });
    } else if (val.images.length > 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachments.images exceeds 16 entries"
      });
    }
  }
  if (val.files !== undefined) {
    if (!Array.isArray(val.files) || val.files.some((x) => typeof x !== "string" || !looksLikeAssetRef(x))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachments.files must be an array of URLs or 1min.ai asset keys"
      });
    } else if (val.files.length > 16) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "attachments.files exceeds 16 entries"
      });
    }
  }
}).transform((val) => {
  if (val === undefined || typeof val !== "object" || Array.isArray(val)) return undefined;
  const out = {};
  if (val.images !== undefined && Array.isArray(val.images)) {
    const cleaned = val.images.map((x) => (typeof x === "string" ? x.slice(0, 1024) : "")).filter(Boolean);
    if (cleaned.length) out.images = cleaned;
  }
  if (val.files !== undefined && Array.isArray(val.files)) {
    const cleaned = val.files.map((x) => (typeof x === "string" ? x.slice(0, 1024) : "")).filter(Boolean);
    if (cleaned.length) out.files = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
})).optional();

const chatRequestSchema = z.object({
  prompt: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val)),
    z.string().refine((val) => val.trim().length > 0, { message: "prompt is required" })
      .refine((val) => val.length <= 50000, { message: "prompt exceeds maximum length of 50000 characters" })
  ),
  model: z.string().optional(),
  conversationId: z.string().optional(),
  attachments: rawAttachmentsSchema,
  webSearch: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  maxWord: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  history: z.preprocess((val) => val === undefined ? true : (val === "true" || val === true), z.boolean().default(true)),
  withMemories: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  brandVoiceId: z.string().optional(),
  isMixed: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
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
    type: "UNIFY_CHAT_WITH_AI",
    model: model || getDefaultModel("CHAT"),
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
    // attachments is intentionally NOT included at top level (it must be nested in promptObject)
    ...(brandVoiceId ? { brandVoiceId } : {}),
  };
}

/**
 * Parse and validate a chat request body. Returns { payload, error }.
 * Used by both /chat and /chat/stream to avoid duplication.
 */
function parseChatRequest(body) {
  const result = chatRequestSchema.safeParse(body);
  if (!result.success) {
    const errorMsg = result.error.issues[0]?.message || "Validation error";
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

// Available models endpoint
router.get("/models", (_req, res) => {
  res.json({ chatModels: getChatModels(), codeModels: getCodeModels(), imageModels: getImageModels() });
});

router.post("/chat", async (req, res, next) => {
  try {
    const { error, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    const data = await callOneMin("/api/chat-with-ai", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai chat failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post("/chat/stream", async (req, res, next) => {
  try {
    const { error, payload } = parseChatRequest(req.body);
    if (error) return res.status(error.status).json({ error: error.message });

    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        logger.info("Client closed the connection. Aborting stream request.");
        controller.abort();
      }
    });

    // L-3: Explicitly mark as non-idempotent so retries never duplicate
    // upstream aiRecords or cause duplicate billing on transient failures.
    const response = await callOneMin("/api/chat-with-ai?isStreaming=true", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      raw: true,
      signal: controller.signal,
      idempotent: false,
    });

    if (response.headers.get("content-type")?.includes("application/json")) {
      // Non-streaming fallback (server didn't honor isStreaming).
      const data = await response.json().catch(() => null);
      if (isFailedResponse(data)) {
        const err = new Error(`1min.ai chat failed: ${extractFailureMessage(data)}`);
        err.status = 502;
        err.payload = data;
        throw err;
      }
      return res.json(data);
    }

    if (!response.ok) {
      const errorPayload = await parseResponsePayload(response);
      const isDev = process.env.NODE_ENV === "development";
      return res.status(response.status).json({
        error: `1min.ai API error: ${response.status}`,
        details: isDev
          ? errorPayload?.error?.message || errorPayload?.message || "Upstream API Error"
          : "Upstream API Error",
      });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // B-1: Shortened heartbeat interval (15s) for better proxy compatibility
    const heartbeatInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(":\n\n");
      }
    }, 15_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // H-3: 1min.ai streams as plain SSE `data: {...}\n\n` chunks without
        // an explicit `event:` line. We forward as-is so the OpenAI-compatible
        // chunk shape (choices[0].delta.content / choices[0].finish_reason)
        // reaches the client intact.
        res.write(chunk);
      }
    } catch (streamErr) {
      if (controller.signal.aborted || streamErr.name === "AbortError") {
        logger.info("Stream reading aborted due to client disconnection.");
      } else {
        logger.warn("Stream interrupted", { error: streamErr.message });
      }
    } finally {
      clearInterval(heartbeatInterval);
      try {
        reader.releaseLock();
      } catch (lockErr) {
        // ignore
      }
      res.end();
    }
  } catch (err) {
    if (err.name === "AbortError" || err.status === 499) {
      logger.info("Stream request aborted as client disconnected.");
      if (!res.headersSent) {
        res.status(499).json({ error: "Client Closed Request" });
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

// Allowed conversation types that map to valid 1min.ai API feature types.
const ALLOWED_CONVERSATION_TYPES = [
  "UNIFY_CHAT_WITH_AI",
  "CODE_GENERATOR",
  "IMAGE_GENERATOR",
];

const conversationCreateSchema = z.object({
  title: z.preprocess(
    (val) => (val === undefined || val === null ? "New AI Conversation" : String(val)),
    z.string().min(1).max(500).default("New AI Conversation"),
  ),
  model: z.string().max(200).optional(),
  type: z.preprocess(
    (val) => (val === undefined || val === null ? "UNIFY_CHAT_WITH_AI" : String(val)),
    z.string().refine(
      (val) => ALLOWED_CONVERSATION_TYPES.includes(val),
      { message: `type must be one of: ${ALLOWED_CONVERSATION_TYPES.join(", ")}` },
    ).default("UNIFY_CHAT_WITH_AI"),
  ),
});

router.post("/conversations", async (req, res, next) => {
  try {
    const result = conversationCreateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const { title, model, type } = result.data;
    const payload = {
      type,
      title,
      model: model || getDefaultModel(type),
    };
    // M-1: Conversation creation is non-idempotent — a retry would create a
    // duplicate conversation. Disable retries explicitly.
    const data = await callOneMin("/api/conversations", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      idempotent: false,
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai conversation creation failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

/**
 * M-11/H-1: Parse output_compression as a finite integer in [0, 100], or
 * return a 400 error. Centralizes NaN handling and range validation so
 * generate/text-editor cannot send invalid values upstream.
 */
const outputCompressionSchema = z.preprocess((val) => {
  if (val === undefined || val === "" || (typeof val === "string" && val.trim() === "")) {
    return undefined;
  }
  return val;
}, z.any().superRefine((val, ctx) => {
  if (val === undefined) return;
  const n = Number(val);
  if (isNaN(n) || !Number.isFinite(n)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "output_compression must be a finite number"
    });
    return;
  }
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "output_compression must be an integer between 0 and 100"
    });
  }
}).transform((val) => {
  if (val === undefined) return undefined;
  return Number(val);
})).optional();

const imageGenerateSchema = z.object({
  prompt: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val)),
    z.string().refine((val) => val.trim().length > 0, { message: "prompt is required" })
  ),
  model: z.string().optional(),
  num_outputs: z.preprocess((val) => (val === undefined ? 1 : Number(val)), z.number().min(1, "num_outputs must be between 1 and 10").max(10, "num_outputs must be between 1 and 10")),
  aspect_ratio: z.string().default("1:1"),
  quality: z.string().default("medium"),
  background: z.string().default("auto"),
  output_format: z.string().default("png").refine(val => ["png", "webp", "jpeg", "jpg"].includes(val), {
    message: "output_format must be one of: png, webp, jpeg, jpg"
  }),
  output_compression: outputCompressionSchema,
  size: z.string().optional(),
}).superRefine((data, ctx) => {
  const selectedModel = data.model || getDefaultModel("IMAGE_GENERATOR");
  const isGptImage = selectedModel.startsWith("gpt-image");
  if (!isGptImage) {
    if (data.quality !== "medium" || data.background !== "auto" || data.output_compression !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "quality, background, and output_compression are only supported by gpt-image-* models"
      });
    }
  }
});

const imageEditorSchema = z.object({
  imageUrl: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val)),
    z.string().refine((val) => val.trim().length > 0, { message: "imageUrl or asset key is required" })
  ),
  prompt: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val)),
    z.string().refine((val) => val.trim().length > 0, { message: "prompt is required" })
  ),
  model: z.string().optional(),
  size: z.string().default("1024x1024"),
  quality: z.string().default("medium"),
  n: z.preprocess((val) => (val === undefined ? 1 : Number(val)), z.number().default(1)),
  background: z.string().default("auto"),
  output_format: z.string().default("webp"),
  output_compression: outputCompressionSchema,
}).superRefine((data, ctx) => {
  const selectedModel = data.model || getDefaultModel("IMAGE_EDITOR");
  const isGptImage = selectedModel.startsWith("gpt-image");

  if (isGptImage) {
    const sizeMatch = String(data.size).match(/^(\d+)x(\d+)$/);
    if (!sizeMatch) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "size must be in WxH format (e.g. 1024x1024)"
      });
      return;
    }
    const w = Number(sizeMatch[1]);
    const h = Number(sizeMatch[2]);
    if (w % 16 !== 0 || h % 16 !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "width and height must be divisible by 16"
      });
    }
    if (w * h < 655360 || w * h > 8294400) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "total pixels must be between 655,360 and 8,294,400"
      });
    }
    if (Math.max(w, h) > 3840) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "max edge must be <= 3840px"
      });
    }
    if (Math.max(w, h) / Math.min(w, h) > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "aspect ratio must be <= 3:1"
      });
    }
  } else {
    if (data.size && !/^\d+x\d+$/.test(String(data.size))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "size must be in WxH format (e.g. 1024x1024)"
      });
    }
  }
});

function aspectRatioToSize(aspectRatio) {
  const map = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "4:3": "1280x1024",
    "3:4": "1024x1280",
  };
  return map[aspectRatio] || "1024x1024";
}

router.post("/images/generate", async (req, res, next) => {
  try {
    const result = imageGenerateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const selectedModel = data.model || getDefaultModel("IMAGE_GENERATOR");
    const isGptImage = selectedModel.startsWith("gpt-image");

    const promptObject = {
      prompt: data.prompt,
    };

    if (isGptImage) {
      promptObject.size = data.size || aspectRatioToSize(data.aspect_ratio);
      promptObject.n = data.num_outputs;
      promptObject.quality = data.quality;
      promptObject.background = data.background;
      promptObject.output_format = data.output_format;
      if (data.output_compression !== undefined) {
        promptObject.output_compression = data.output_compression;
      }
    } else {
      promptObject.num_outputs = data.num_outputs;
      promptObject.aspect_ratio = data.aspect_ratio;
      promptObject.output_format = data.output_format;
    }

    const payload = {
      type: "IMAGE_GENERATOR",
      model: selectedModel,
      promptObject,
    };
    const dataRes = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai image generation failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }
    res.json(dataRes);
  } catch (err) {
    next(err);
  }
});

router.post("/images/text-editor", async (req, res, next) => {
  try {
    const result = imageEditorSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const selectedModel = data.model || getDefaultModel("IMAGE_EDITOR");
    const isGptImage = selectedModel.startsWith("gpt-image");

    const promptObject = {
      imageUrl: data.imageUrl,
      prompt: data.prompt,
      size: data.size,
      n: data.n,
      output_format: data.output_format,
    };

    if (isGptImage) {
      promptObject.quality = data.quality;
      promptObject.background = data.background;
      if (data.output_compression !== undefined) {
        promptObject.output_compression = data.output_compression;
      }
    }
    const payload = {
      type: "IMAGE_EDITOR",
      model: selectedModel,
      promptObject,
    };

    const dataRes = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai image edit failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }
    res.json(dataRes);
  } catch (err) {
    next(err);
  }
});

const MAX_CODE_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 50_000;

const codeGenerateSchema = z.object({
  instruction: z.preprocess(
    (val) => (val === undefined || val === null ? "" : String(val)),
    z.string().refine((val) => val.trim().length > 0, { message: "instruction is required" })
      .refine((val) => val.length <= 50000, { message: "instruction exceeds 50000 characters" })
  ),
  fileName: z.string().default("untitled"),
  language: z.string().default("plaintext"),
  code: z.preprocess((val) => (val === undefined || val === null ? "" : String(val)), z.string().refine((val) => val.length <= 100000, { message: "code exceeds 100000 characters" })),
  model: z.string().optional(),
  webSearch: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  maxWord: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
});

function validateLineColumn(data, ctx) {
  const lineNum = Number(data.line);
  if (!Number.isInteger(lineNum) || lineNum < 1 || lineNum > 1000000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "line must be a positive integer"
    });
  }
  const colNum = Number(data.column);
  if (!Number.isInteger(colNum) || colNum < 1 || colNum > 1000000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "column must be a positive integer"
    });
  }
}

const codeAutocompleteSchema = z.object({
  code: z.string({ required_error: "code, line, and column are required" }).refine((val) => val.length <= 100000, { message: "code exceeds 100000 characters" }),
  line: z.any({ required_error: "code, line, and column are required" }),
  column: z.any({ required_error: "code, line, and column are required" }),
  fileName: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
  webSearch: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  maxWord: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
}).superRefine(validateLineColumn);

const codeInlineChatSchema = z.object({
  prompt: z.string({ required_error: "prompt, code, line, and column are required" }).refine((val) => val.trim().length > 0, { message: "prompt, code, line, and column are required" }).refine((val) => val.length <= 50000, { message: "prompt exceeds 50000 characters" }),
  code: z.string({ required_error: "prompt, code, line, and column are required" }).refine((val) => val.length <= 100000, { message: "code exceeds 100000 characters" }),
  line: z.any({ required_error: "prompt, code, line, and column are required" }),
  column: z.any({ required_error: "prompt, code, line, and column are required" }),
  fileName: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
  webSearch: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  maxWord: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
}).superRefine(validateLineColumn);

function buildCodeContext(code, line, column, contextLines = 100) {
  const lines = code.split(/\r?\n/);
  const lineIndex = line - 1;
  const colIndex = column - 1;

  const linesBefore = lines.slice(0, lineIndex);
  const currentLine = lines[lineIndex] || "";
  const beforeCurrent = currentLine.substring(0, colIndex);
  const afterCurrent = currentLine.substring(colIndex);
  const linesAfter = lines.slice(lineIndex + 1);

  const beforeCode = [...linesBefore.slice(-contextLines), beforeCurrent].join("\n");
  const afterCode = [afterCurrent, ...linesAfter.slice(0, contextLines)].join("\n");

  return { beforeCode, afterCode };
}

/**
 * M-2: Sanitize a value before embedding it into an AI prompt.
 * Strips control characters (except HT/LF/CR needed for code formatting)
 * and truncates to prevent prompt injection via crafted fileName or language fields.
 */
function sanitizeForPrompt(value, maxLen = 256) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "") // strip control chars, keep HT(\x09) LF(\x0a) CR(\x0d)
    .replace(/`{3}/g, "'''") // neutralize markdown code fence markers
    .slice(0, maxLen)
    .trim();
}

function stripCodeFences(text) {
  if (!text.includes("```")) return text;
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1] : text.replace(/```/g, "");
}

router.post("/code/generate", async (req, res, next) => {
  try {
    const result = codeGenerateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const prompt = `あなたは熟練のソフトウェアエンジニアです。以下のコードに対してユーザー指示を実行してください。\n\n出力ルール:\n- 変更コードが必要な場合は完全なコードブロックで返す\n- 変更理由を短く説明する\n- 可能なら注意点も述べる\n\nファイル名: ${sanitizeForPrompt(data.fileName)}\n言語: ${sanitizeForPrompt(data.language)}\n\nユーザー指示:\n${data.instruction}\n\n現在のコード:\n\`\`\`${sanitizeForPrompt(data.language)}\n${data.code}\n\`\`\``;

    const payload = buildCodePayload({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });
    const dataRes = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai code generate failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }
    res.json(dataRes);
  } catch (err) {
    next(err);
  }
});

router.post("/code/autocomplete", async (req, res, next) => {
  try {
    const result = codeAutocompleteSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const lineNum = Number(data.line);
    const colNum = Number(data.column);

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(data.code, lineNum, colNum, 100);

    const prompt = `あなたはAIコーディングアシスタントです。ユーザーがエディタでコードを入力中であり、カーソルの直後に続くべきコード（数行〜最大20行程度）を提案してください。
必ず提案するコード「のみ」を出力してください。説明、マークダウンのコードブロック記号(\`\`\`)、解説、挨拶などは絶対に含めないでください。
また、提案コードは「カーソルより前のコード」の直後からシームレスに繋がるようにしてください（すでに書かれているコードを重複して出力しないでください）。

コンテキスト:
ファイル名: ${sanitizeForPrompt(data.fileName || "untitled")}
言語: ${sanitizeForPrompt(data.language || "plaintext")}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

提案コード:`;

    const payload = buildCodePayload({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    const dataRes = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai code autocomplete failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }

    let suggestion = extractText(dataRes);
    suggestion = stripCodeFences(suggestion);

    res.json({ suggestion });
  } catch (err) {
    next(err);
  }
});

router.post("/code/inline-chat", async (req, res, next) => {
  try {
    const result = codeInlineChatSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const lineNum = Number(data.line);
    const colNum = Number(data.column);

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(data.code, lineNum, colNum, 150);

    const prompt = `あなたは熟練のソフトウェアエンジニアです。エディタのカーソル位置でユーザー指示を実行し、挿入または変更すべきコードを出力してください。
必ず提案するコード「のみ」を出力し、説明やマークダウンのコードブロック記号(\`\`\`)は一切含めないでください。

コンテキスト:
ファイル名: ${sanitizeForPrompt(data.fileName || "untitled")}
言語: ${sanitizeForPrompt(data.language || "plaintext")}
ユーザー指示: ${data.prompt}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

挿入/変更コード:`;

    const payload = buildCodePayload({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    const dataRes = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai inline chat failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }

    let codeResult = extractText(dataRes);
    codeResult = stripCodeFences(codeResult);

    res.json({ code: codeResult });
  } catch (err) {
    next(err);
  }
});

/**
 * Flatten a messages array into a single prompt string.
 * Maintains role labels so the LLM can infer conversation flow.
 */
function flattenMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  return messages
    .map((m) => {
      const role = (m.role || "user").toUpperCase();
      const content = typeof m.content === "string" ? m.content : "";
      return `[${role}]\n${content}`;
    })
    .join("\n\n");
}

const agentChatSchema = z.object({
  prompt: z.string().optional(),
  messages: z.array(z.object({
    role: z.string().default("user"),
    content: z.string().default("")
  })).optional(),
  model: z.string().optional(),
  webSearch: z.preprocess((val) => val === "true" || val === true, z.boolean().default(false)),
  numOfSite: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
  maxWord: z.preprocess((val) => (val !== undefined && val !== "" ? Number(val) : undefined), z.number().int().optional()),
}).superRefine((data, ctx) => {
  const promptText = Array.isArray(data.messages) && data.messages.length > 0 ? flattenMessages(data.messages) : data.prompt;
  if (!promptText || !String(promptText).trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "prompt or messages is required"
    });
  }
});

router.post("/agent/chat", async (req, res, next) => {
  try {
    const result = agentChatSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || "Validation error";
      return res.status(400).json({ error: errorMsg });
    }
    const data = result.data;
    const promptText = Array.isArray(data.messages) && data.messages.length > 0 ? flattenMessages(data.messages) : data.prompt;

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const payload = buildChatPayload({
      prompt: String(promptText),
      model: data.model,
      webSearch: parsedWebSearch,
      numOfSite: parsedNumOfSite,
      maxWord: parsedMaxWord,
      history: false,
    });

    const dataRes = await callOneMin("/api/chat-with-ai", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(dataRes)) {
      const err = new Error(`1min.ai agent chat failed: ${extractFailureMessage(dataRes)}`);
      err.status = 502;
      err.payload = dataRes;
      throw err;
    }
    const text = extractText(dataRes);
    res.json({ text, raw: dataRes });
  } catch (err) {
    next(err);
  }
});

export default router;
