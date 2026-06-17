import express from "express";
import {
  callOneMin,
  extractText,
  isFailedResponse,
  extractFailureMessage,
} from "../utils/api-client.js";
import { chatModels, codeModels, imageModels } from "../config/models.js";
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

function validateAttachments(attachments) {
  if (attachments == null) return undefined;
  if (typeof attachments !== "object" || Array.isArray(attachments)) {
    const err = new Error("attachments must be an object");
    err.status = 400;
    throw err;
  }
  const out = {};
  if (attachments.images !== undefined) {
    if (
      !Array.isArray(attachments.images) ||
      attachments.images.some((x) => typeof x !== "string")
    ) {
      const err = new Error("attachments.images must be an array of strings");
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
    if (!Array.isArray(attachments.files) || attachments.files.some((x) => typeof x !== "string")) {
      const err = new Error("attachments.files must be an array of strings");
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

// Available models endpoint
router.get("/models", (_req, res) => {
  res.json({ chatModels, codeModels, imageModels });
});

router.post("/chat", async (req, res, next) => {
  try {
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
    } = req.body;
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

    let safeAttachments;
    try {
      safeAttachments = validateAttachments(attachments);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
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
    } = req.body;
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

    let safeAttachments;
    try {
      safeAttachments = validateAttachments(attachments);
    } catch (err) {
      return res.status(err.status || 400).json({ error: err.message });
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
      const errorText = await response.text();
      const isDev = process.env.NODE_ENV === "development";
      return res.status(response.status).json({
        error: `1min.ai API error: ${response.status}`,
        details: isDev ? errorText : "Upstream API Error",
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
    const data = await callOneMin("/api/conversations", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isFailedResponse(data)) {
      const err = new Error(
        `1min.ai conversation creation failed: ${extractFailureMessage(data)}`,
      );
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
  if (value === undefined || value === "") return { ok: true, value: undefined };
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
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

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
          error:
            "quality, background, and output_compression are only supported by gpt-image-* models",
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
        return res
          .status(400)
          .json({ error: "total pixels must be between 655,360 and 8,294,400" });
      }
      if (Math.max(w, h) > 3840) {
        return res.status(400).json({ error: "max edge must be <= 3840px" });
      }
      if (Math.max(w, h) / Math.min(w, h) > 3) {
        return res.status(400).json({ error: "aspect ratio must be <= 3:1" });
      }
    }

    const oc = parseOutputCompression(output_compression);
    if (!oc.ok) {
      return res.status(400).json({ error: oc.error });
    }
    const payload = {
      type: "IMAGE_EDITOR",
      model: selectedModel,
      promptObject: {
        imageUrl: String(imageUrl).trim(),
        prompt: String(prompt).trim(),
        size,
        quality,
        n: Number(n) || 1,
        background,
        output_format,
        ...(oc.value !== undefined ? { output_compression: oc.value } : {}),
      },
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
    const {
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
    if (code === undefined || !line || !column) {
      return res.status(400).json({ error: "code, line, and column are required" });
    }
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const lines = code.split(/\r?\n/);
    const lineIndex = line - 1;
    const colIndex = column - 1;

    const linesBefore = lines.slice(0, lineIndex);
    const currentLine = lines[lineIndex] || "";
    const beforeCurrent = currentLine.substring(0, colIndex);
    const afterCurrent = currentLine.substring(colIndex);
    const linesAfter = lines.slice(lineIndex + 1);

    // Trim context lines to save tokens/credits for inline completions (Local window only)
    const beforeCode = [...linesBefore.slice(-100), beforeCurrent].join("\n");
    const afterCode = [afterCurrent, ...linesAfter.slice(0, 100)].join("\n");

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
    if (!userPrompt || code === undefined || !line || !column) {
      return res.status(400).json({ error: "prompt, code, line, and column are required" });
    }
    if (String(userPrompt).length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const lines = code.split(/\r?\n/);
    const lineIndex = line - 1;
    const colIndex = column - 1;

    const linesBefore = lines.slice(0, lineIndex);
    const currentLine = lines[lineIndex] || "";
    const beforeCurrent = currentLine.substring(0, colIndex);
    const afterCurrent = currentLine.substring(colIndex);
    const linesAfter = lines.slice(lineIndex + 1);

    // Trim context lines to save tokens/credits for inline chat editing (Local window only)
    const beforeCode = [...linesBefore.slice(-150), beforeCurrent].join("\n");
    const afterCode = [afterCurrent, ...linesAfter.slice(0, 150)].join("\n");

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

router.post("/agent/chat", async (req, res, next) => {
  try {
    const { prompt, model, webSearch = false, numOfSite, maxWord } = req.body;
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch,
      numOfSite,
      maxWord,
    });

    const payload = buildCodePayload({
      prompt: String(prompt),
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
