import express from "express";
import { callOneMin, extractText, isFailedResponse, extractFailureMessage } from "../utils/api-client.js";
import { getChatModels, getCodeModels, getImageModels } from "../config/models.js";
import { parseWebSearchParams, buildCodePayload } from "../utils/web-search.js";
import logger from "../utils/logger.js";

const router = express.Router();

import { serverConfig } from "../config/server.js";

async function parseResponsePayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function getDefaultModel(type) {
  if (type === "CODE_GENERATOR") return serverConfig.defaultCodeModel;
  if (type === "IMAGE_GENERATOR") return serverConfig.defaultImageModel;
  if (type === "IMAGE_EDITOR") return serverConfig.defaultImageEditorModel;
  return serverConfig.defaultChatModel;
}

function validateAttachments(attachments) {
  if (attachments == null) return undefined;
  if (typeof attachments !== "object" || Array.isArray(attachments)) {
    const err = new Error("attachments must be an object");
    err.status = 400;
    throw err;
  }
  // M-3: Reject anything that doesn't look like either a 1min.ai asset
  // key (UUID-ish, ~32-64 chars) or an http(s) URL. This prevents the
  // upstream payload from being polluted with arbitrary strings that
  // downstream providers may interpret differently.
  const looksLikeAssetRef = (s) =>
    typeof s === "string" && s.length <= 1024 && (/^https?:\/\//i.test(s) || /^[A-Za-z0-9._/-]+$/.test(s));

  const out = {};
  if (attachments.images !== undefined) {
    if (
      !Array.isArray(attachments.images) ||
      attachments.images.some((x) => typeof x !== "string" || !looksLikeAssetRef(x))
    ) {
      const err = new Error("attachments.images must be an array of URLs or 1min.ai asset keys");
      err.status = 400;
      throw err;
    }
    if (attachments.images.length > 16) {
      const err = new Error("attachments.images exceeds 16 entries");
      err.status = 400;
      throw err;
    }
    const cleaned = attachments.images.map((x) => x.slice(0, 1024)).filter(Boolean);
    if (cleaned.length) out.images = cleaned;
  }
  if (attachments.files !== undefined) {
    if (
      !Array.isArray(attachments.files) ||
      attachments.files.some((x) => typeof x !== "string" || !looksLikeAssetRef(x))
    ) {
      const err = new Error("attachments.files must be an array of URLs or 1min.ai asset keys");
      err.status = 400;
      throw err;
    }
    if (attachments.files.length > 16) {
      const err = new Error("attachments.files exceeds 16 entries");
      err.status = 400;
      throw err;
    }
    const cleaned = attachments.files.map((x) => x.slice(0, 1024)).filter(Boolean);
    if (cleaned.length) out.files = cleaned;
  }
  return Object.keys(out).length ? out : undefined;
}

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
  const {
    prompt,
    model,
    conversationId,
    attachments,
    webSearch = false,
    numOfSite,
    maxWord,
    history = true,
    withMemories = false,
    brandVoiceId,
    isMixed = false,
  } = body;

  if (!prompt || !String(prompt).trim()) {
    return { error: { status: 400, message: "prompt is required" } };
  }

  // #4: Enforce max prompt length consistent with /code endpoints
  const MAX_PROMPT_LENGTH = 50000;
  const promptStr = String(prompt);
  if (promptStr.length > MAX_PROMPT_LENGTH) {
    return {
      error: { status: 400, message: `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters` },
    };
  }

  let safeAttachments;
  try {
    safeAttachments = validateAttachments(attachments);
  } catch (err) {
    return { error: { status: err.status || 400, message: err.message } };
  }

  const payload = buildChatPayload({
    prompt,
    model,
    conversationId,
    attachments: safeAttachments,
    webSearch,
    numOfSite,
    maxWord,
    history,
    withMemories,
    brandVoiceId,
    isMixed,
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

    const response = await callOneMin("/api/chat-with-ai?isStreaming=true", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      raw: true,
      signal: controller.signal,
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
      } else {
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      next(err);
    } else {
      res.end();
    }
  }
});

router.post("/conversations", async (req, res, next) => {
  try {
    const { title = "New AI Conversation", model, type = "UNIFY_CHAT_WITH_AI" } = req.body;
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
function parseOutputCompression(value) {
  if (value === undefined || value === "" || (typeof value === "string" && value.trim() === "")) {
    return { ok: true, value: undefined };
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "output_compression must be a finite number" };
  }
  if (!Number.isInteger(n) || n < 0 || n > 100) {
    return { ok: false, error: "output_compression must be an integer between 0 and 100" };
  }
  return { ok: true, value: n };
}

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
    const {
      prompt,
      model,
      num_outputs = 1,
      aspect_ratio = "1:1",
      quality = "medium",
      background = "auto",
      output_format = "png",
      output_compression,
      size,
    } = req.body;
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: "prompt is required" });

    // #14: Validate num_outputs range
    const numOutputsNum = Number(num_outputs);
    if (numOutputsNum < 1 || numOutputsNum > 10 || isNaN(numOutputsNum)) {
      return res.status(400).json({ error: "num_outputs must be between 1 and 10" });
    }

    // #15: Validate output_format against allowed values
    const ALLOWED_OUTPUT_FORMATS = ["png", "webp", "jpeg", "jpg"];
    if (output_format && !ALLOWED_OUTPUT_FORMATS.includes(output_format)) {
      return res
        .status(400)
        .json({ error: `output_format must be one of: ${ALLOWED_OUTPUT_FORMATS.join(", ")}` });
    }

    const selectedModel = model || getDefaultModel("IMAGE_GENERATOR");
    const isGptImage = selectedModel.startsWith("gpt-image");

    const promptObject = {
      prompt: String(prompt),
    };

    if (isGptImage) {
      promptObject.size = size || aspectRatioToSize(aspect_ratio);
      promptObject.n = Number(num_outputs) || 1;
      promptObject.quality = quality;
      promptObject.background = background;
      promptObject.output_format = output_format;
      const oc = parseOutputCompression(output_compression);
      if (!oc.ok) {
        return res.status(400).json({ error: oc.error });
      }
      if (oc.value !== undefined) {
        promptObject.output_compression = oc.value;
      }
    } else {
      // Reject gpt-image-only parameters for non-gpt-image models to avoid
      // silent 422 from the upstream API.
      if (quality !== "medium" || background !== "auto" || output_compression !== undefined) {
        return res.status(400).json({
          error: "quality, background, and output_compression are only supported by gpt-image-* models",
        });
      }
      promptObject.num_outputs = Number(num_outputs) || 1;
      promptObject.aspect_ratio = aspect_ratio;
      promptObject.output_format = output_format;
    }

    const payload = {
      type: "IMAGE_GENERATOR",
      model: selectedModel,
      promptObject,
    };
    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai image generation failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post("/images/text-editor", async (req, res, next) => {
  try {
    const {
      imageUrl,
      prompt,
      model,
      size = "1024x1024",
      quality = "medium",
      n = 1,
      background = "auto",
      output_format = "webp",
      output_compression,
    } = req.body;

    if (!imageUrl || !String(imageUrl).trim()) {
      return res.status(400).json({ error: "imageUrl or asset key is required" });
    }
    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }

    const selectedModel = model || getDefaultModel("IMAGE_EDITOR");
    const isGptImage = selectedModel.startsWith("gpt-image");

    if (isGptImage) {
      const sizeMatch = String(size).match(/^(\d+)x(\d+)$/);
      if (!sizeMatch) {
        return res.status(400).json({ error: "size must be in WxH format (e.g. 1024x1024)" });
      }
      const w = Number(sizeMatch[1]);
      const h = Number(sizeMatch[2]);
      if (w % 16 !== 0 || h % 16 !== 0) {
        return res.status(400).json({ error: "width and height must be divisible by 16" });
      }
      if (w * h < 655360 || w * h > 8294400) {
        return res.status(400).json({ error: "total pixels must be between 655,360 and 8,294,400" });
      }
      if (Math.max(w, h) > 3840) {
        return res.status(400).json({ error: "max edge must be <= 3840px" });
      }
      if (Math.max(w, h) / Math.min(w, h) > 3) {
        return res.status(400).json({ error: "aspect ratio must be <= 3:1" });
      }
    } else {
      // Non-gpt-image models (Flux Kontext etc.) also expect WxH size.
      if (size && !/^\d+x\d+$/.test(String(size))) {
        return res.status(400).json({ error: "size must be in WxH format (e.g. 1024x1024)" });
      }
    }

    const oc = parseOutputCompression(output_compression);
    if (!oc.ok) {
      return res.status(400).json({ error: oc.error });
    }

    const promptObject = {
      imageUrl: String(imageUrl).trim(),
      prompt: String(prompt).trim(),
      size,
      n: Number(n) || 1,
      output_format,
    };

    // gpt-image-only parameters
    if (isGptImage) {
      promptObject.quality = quality;
      promptObject.background = background;
      if (oc.value !== undefined) {
        promptObject.output_compression = oc.value;
      }
    }
    const payload = {
      type: "IMAGE_EDITOR",
      model: selectedModel,
      promptObject,
    };

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai image edit failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

const MAX_CODE_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 50_000;

function validateLineColumn(line, column) {
  const lineNum = Number(line);
  const colNum = Number(column);
  if (!Number.isInteger(lineNum) || lineNum < 1 || lineNum > 1_000_000) {
    return { error: "line must be a positive integer" };
  }
  if (!Number.isInteger(colNum) || colNum < 1 || colNum > 1_000_000) {
    return { error: "column must be a positive integer" };
  }
  return { lineNum, colNum };
}

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
    const {
      instruction,
      fileName = "untitled",
      language = "plaintext",
      code = "",
      model,
      webSearch = false,
      numOfSite,
      maxWord,
    } = req.body;
    if (!instruction || !String(instruction).trim())
      return res.status(400).json({ error: "instruction is required" });
    if (String(instruction).length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: `instruction exceeds ${MAX_PROMPT_LENGTH} characters` });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const prompt = `あなたは熟練のソフトウェアエンジニアです。以下のコードに対してユーザー指示を実行してください。\n\n出力ルール:\n- 変更コードが必要な場合は完全なコードブロックで返す\n- 変更理由を短く説明する\n- 可能なら注意点も述べる\n\nファイル名: ${sanitizeForPrompt(fileName)}\n言語: ${sanitizeForPrompt(language)}\n\nユーザー指示:\n${instruction}\n\n現在のコード:\n\`\`\`${sanitizeForPrompt(language)}\n${code}\n\`\`\``;

    const payload = buildCodePayload({
      prompt,
      model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });
    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai code generate failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post("/code/autocomplete", async (req, res, next) => {
  try {
    const { code, line, column, fileName, language, model, webSearch = false, numOfSite, maxWord } = req.body;
    if (code === undefined || line === undefined || column === undefined) {
      return res.status(400).json({ error: "code, line, and column are required" });
    }
    const { error: lcErr, lineNum, colNum } = validateLineColumn(line, column);
    if (lcErr) return res.status(400).json({ error: lcErr });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(code, lineNum, colNum, 100);

    const prompt = `あなたはAIコーディングアシスタントです。ユーザーがエディタでコードを入力中であり、カーソルの直後に続くべきコード（数行〜最大20行程度）を提案してください。
必ず提案するコード「のみ」を出力してください。説明、マークダウンのコードブロック記号(\`\`\`)、解説、挨拶などは絶対に含めないでください。
また、提案コードは「カーソルより前のコード」の直後からシームレスに繋がるようにしてください（すでに書かれているコードを重複して出力しないでください）。

コンテキスト:
ファイル名: ${sanitizeForPrompt(fileName || "untitled")}
言語: ${sanitizeForPrompt(language || "plaintext")}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

提案コード:`;

    const payload = buildCodePayload({
      prompt,
      model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai code autocomplete failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }

    let suggestion = extractText(data);
    suggestion = stripCodeFences(suggestion);

    res.json({ suggestion });
  } catch (err) {
    next(err);
  }
});

router.post("/code/inline-chat", async (req, res, next) => {
  try {
    const {
      prompt: userPrompt,
      code,
      line,
      column,
      fileName,
      language,
      model,
      webSearch = false,
      numOfSite,
      maxWord,
    } = req.body;
    if (!userPrompt || code === undefined || line === undefined || column === undefined) {
      return res.status(400).json({ error: "prompt, code, line, and column are required" });
    }
    const { error: lcErr, lineNum, colNum } = validateLineColumn(line, column);
    if (lcErr) return res.status(400).json({ error: lcErr });
    if (String(userPrompt).length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(code, lineNum, colNum, 150);

    const prompt = `あなたは熟練のソフトウェアエンジニアです。エディタのカーソル位置でユーザー指示を実行し、挿入または変更すべきコードを出力してください。
必ず提案するコード「のみ」を出力し、説明やマークダウンのコードブロック記号(\`\`\`)は一切含めないでください。

コンテキスト:
ファイル名: ${sanitizeForPrompt(fileName || "untitled")}
言語: ${sanitizeForPrompt(language || "plaintext")}
ユーザー指示: ${userPrompt}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

挿入/変更コード:`;

    const payload = buildCodePayload({
      prompt,
      model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai inline chat failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }

    let codeResult = extractText(data);
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

router.post("/agent/chat", async (req, res, next) => {
  try {
    const { prompt, messages, model, webSearch = false, numOfSite, maxWord } = req.body;

    // Accept either prompt (string) or messages (array) — messages is preferred.
    const promptText = Array.isArray(messages) && messages.length > 0 ? flattenMessages(messages) : prompt;

    if (!promptText || !String(promptText).trim())
      return res.status(400).json({ error: "prompt or messages is required" });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const payload = buildCodePayload({
      prompt: String(promptText),
      model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
    });

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(`1min.ai agent chat failed: ${extractFailureMessage(data)}`);
      err.status = 502;
      err.payload = data;
      throw err;
    }
    const text = extractText(data);
    res.json({ text, raw: data });
  } catch (err) {
    next(err);
  }
});

export default router;
