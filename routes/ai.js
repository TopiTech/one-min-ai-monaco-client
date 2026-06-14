import express from "express";
import { callOneMin, extractText } from "../utils/api-client.js";
import { chatModels, codeModels, imageModels } from "../config/models.js";
import logger from "../utils/logger.js";

const router = express.Router();

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
      history = true,
      withMemories = false,
      brandVoiceId,
      isMixed = false,
    } = req.body;
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

    const payload = {
      type: "UNIFY_CHAT_WITH_AI",
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
      promptObject: {
        prompt: String(prompt),
        settings: {
          webSearchSettings: {
            webSearch: Boolean(webSearch),
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

    const data = await callOneMin("/api/chat-with-ai", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
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
      history = true,
      withMemories = false,
      brandVoiceId,
      isMixed = false,
    } = req.body;
    if (!prompt || !String(prompt).trim())
      return res.status(400).json({ error: "prompt is required" });

    const payload = {
      type: "UNIFY_CHAT_WITH_AI",
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
      promptObject: {
        prompt: String(prompt),
        settings: {
          webSearchSettings: {
            webSearch: Boolean(webSearch),
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

    const response = await callOneMin("/api/chat-with-ai?isStreaming=true", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      raw: true,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } catch (streamErr) {
      logger.warn("Stream interrupted", { error: streamErr.message });
    } finally {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) {
      next(err);
    } else {
      res.end();
    }
  }
});

router.post("/conversations", async (req, res, next) => {
  try {
    const { title = "New AI Conversation", model } = req.body;
    const payload = {
      type: "UNIFY_CHAT_WITH_AI",
      title,
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
    };
    const data = await callOneMin("/api/conversations", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) {
    next(err);
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

    const selectedModel = model || process.env.DEFAULT_IMAGE_MODEL || "gpt-image-2";
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
      if (output_compression !== undefined && output_compression !== "") {
        promptObject.output_compression = Number(output_compression);
      }
    } else {
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

    const selectedModel = model || process.env.DEFAULT_IMAGE_EDITOR_MODEL || "gpt-image-2";
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
        ...(output_compression !== undefined && output_compression !== ""
          ? { output_compression: Number(output_compression) }
          : {}),
      },
    };

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

const MAX_CODE_LENGTH = 100_000;
const MAX_PROMPT_LENGTH = 50_000;

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
    } = req.body;
    if (!instruction || !String(instruction).trim())
      return res.status(400).json({ error: "instruction is required" });
    if (String(instruction).length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: `instruction exceeds ${MAX_PROMPT_LENGTH} characters` });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const prompt = `あなたは熟練のソフトウェアエンジニアです。以下のコードに対してユーザー指示を実行してください。\n\n出力ルール:\n- 変更コードが必要な場合は完全なコードブロックで返す\n- 変更理由を短く説明する\n- 可能なら注意点も述べる\n\nファイル名: ${fileName}\n言語: ${language}\n\nユーザー指示:\n${instruction}\n\n現在のコード:\n\`\`\`${language}\n${code}\n\`\`\``;

    const payload = {
      type: "CODE_GENERATOR",
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
      conversationId: "CODE_GENERATOR",
      promptObject: { prompt, webSearch: false },
    };
    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.post("/code/autocomplete", async (req, res, next) => {
  try {
    const { code, line, column, fileName, language, model } = req.body;
    if (code === undefined || !line || !column) {
      return res.status(400).json({ error: "code, line, and column are required" });
    }
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const lines = code.split(/\r?\n/);
    const lineIndex = line - 1;
    const colIndex = column - 1;

    const linesBefore = lines.slice(0, lineIndex);
    const currentLine = lines[lineIndex] || "";
    const beforeCurrent = currentLine.substring(0, colIndex);
    const afterCurrent = currentLine.substring(colIndex);
    const linesAfter = lines.slice(lineIndex + 1);

    const beforeCode = [...linesBefore, beforeCurrent].join("\n");
    const afterCode = [afterCurrent, ...linesAfter].join("\n");

    const prompt = `あなたはAIコーディングアシスタントです。ユーザーがエディタでコードを入力中であり、カーソルの直後に続くべきコード（数行〜最大20行程度）を提案してください。
必ず提案するコード「のみ」を出力してください。説明、マークダウンのコードブロック記号(\`\`\`)、解説、挨拶などは絶対に含めないでください。
また、提案コードは「カーソルより前のコード」の直後からシームレスに繋がるようにしてください（すでに書かれているコードを重複して出力しないでください）。

コンテキスト:
ファイル名: ${fileName || "untitled"}
言語: ${language || "plaintext"}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

提案コード:`;

    const payload = {
      type: "CODE_GENERATOR",
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
      conversationId: "CODE_GENERATOR",
      promptObject: { prompt, webSearch: false },
    };

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let suggestion = extractText(data);
    suggestion = stripCodeFences(suggestion);

    res.json({ suggestion });
  } catch (err) {
    next(err);
  }
});

router.post("/code/inline-chat", async (req, res, next) => {
  try {
    const { prompt: userPrompt, code, line, column, fileName, language, model } = req.body;
    if (!userPrompt || code === undefined || !line || !column) {
      return res.status(400).json({ error: "prompt, code, line, and column are required" });
    }
    if (String(userPrompt).length > MAX_PROMPT_LENGTH)
      return res.status(400).json({ error: `prompt exceeds ${MAX_PROMPT_LENGTH} characters` });
    if (String(code).length > MAX_CODE_LENGTH)
      return res.status(400).json({ error: `code exceeds ${MAX_CODE_LENGTH} characters` });

    const lines = code.split(/\r?\n/);
    const lineIndex = line - 1;
    const colIndex = column - 1;

    const linesBefore = lines.slice(0, lineIndex);
    const currentLine = lines[lineIndex] || "";
    const beforeCurrent = currentLine.substring(0, colIndex);
    const afterCurrent = currentLine.substring(colIndex);
    const linesAfter = lines.slice(lineIndex + 1);

    const beforeCode = [...linesBefore, beforeCurrent].join("\n");
    const afterCode = [afterCurrent, ...linesAfter].join("\n");

    const prompt = `あなたは熟練のソフトウェアエンジニアです。エディタのカーソル位置でユーザー指示を実行し、挿入または変更すべきコードを出力してください。
必ず提案するコード「のみ」を出力し、説明やマークダウンのコードブロック記号(\`\`\`)は一切含めないでください。

コンテキスト:
ファイル名: ${fileName || "untitled"}
言語: ${language || "plaintext"}
ユーザー指示: ${userPrompt}

カーソルより前のコード:
${beforeCode}

カーソルより後のコード:
${afterCode}

挿入/変更コード:`;

    const payload = {
      type: "CODE_GENERATOR",
      model: model || process.env.DEFAULT_CHAT_MODEL || "gpt-4o-mini",
      conversationId: "CODE_GENERATOR",
      promptObject: { prompt, webSearch: false },
    };

    const data = await callOneMin("/api/features", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let codeResult = extractText(data);
    codeResult = stripCodeFences(codeResult);

    res.json({ code: codeResult });
  } catch (err) {
    next(err);
  }
});

export default router;
