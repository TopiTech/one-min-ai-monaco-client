import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const PORT = Number(process.env.PORT || 3000);
const API_BASE = 'https://api.1min.ai';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireApiKey() {
  const apiKey = process.env.ONE_MIN_AI_API_KEY;
  if (!apiKey || apiKey.includes('your_1min_ai_api_key_here')) {
    const err = new Error('ONE_MIN_AI_API_KEY is not configured. Copy .env.example to .env and set your key.');
    err.status = 500;
    throw err;
  }
  return apiKey;
}

async function callOneMin(pathname, { method = 'POST', body, headers = {}, raw = false } = {}) {
  const apiKey = requireApiKey();
  const response = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      'API-KEY': apiKey,
      ...headers,
    },
    body,
  });

  const contentType = response.headers.get('content-type') || '';
  if (raw) return response;

  let payload;
  if (contentType.includes('application/json')) {
    payload = await response.json();
  } else {
    payload = { text: await response.text() };
  }

  if (!response.ok) {
    const err = new Error(`1min.ai request failed: ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }
  return payload;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'one-min-ai-monaco-client', hasApiKey: Boolean(process.env.ONE_MIN_AI_API_KEY) });
});

app.post('/api/chat', async (req, res, next) => {
  try {
    const { prompt, model, conversationId, attachments, webSearch = false, history = true } = req.body;
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });

    const payload = {
      type: 'UNIFY_CHAT_WITH_AI',
      model: model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini',
      promptObject: {
        prompt: String(prompt),
        webSearch: Boolean(webSearch),
        history: Boolean(history),
        ...(conversationId ? { conversationId } : {}),
        ...(attachments ? { attachments } : {}),
      },
    };

    const data = await callOneMin('/api/chat-with-ai', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/conversations', async (req, res, next) => {
  try {
    const { title = 'New AI Conversation', model } = req.body;
    const payload = { type: 'UNIFY_CHAT_WITH_AI', title, model: model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini' };
    const data = await callOneMin('/api/conversations', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/images/generate', async (req, res, next) => {
  try {
    const { prompt, model, num_outputs = 1, aspect_ratio = '1:1', output_format = 'webp' } = req.body;
    if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt is required' });
    const payload = {
      type: 'IMAGE_GENERATOR',
      model: model || process.env.DEFAULT_IMAGE_MODEL || 'black-forest-labs/flux-schnell',
      promptObject: { prompt: String(prompt), num_outputs: Number(num_outputs) || 1, aspect_ratio, output_format },
    };
    const data = await callOneMin('/api/features', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/assets/upload', upload.single('asset'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'asset file is required' });
    const formData = new FormData();
    const blob = new Blob([req.file.buffer], { type: req.file.mimetype || 'application/octet-stream' });
    formData.append('asset', blob, req.file.originalname || 'upload.bin');

    const data = await callOneMin('/api/assets', { method: 'POST', body: formData });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/images/variation', async (req, res, next) => {
  try {
    const { imageUrl, model, n = 4, aspect_width = 1, aspect_height = 1, mode = 'fast' } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl or asset key is required' });
    const payload = {
      type: 'IMAGE_VARIATOR',
      model: model || process.env.DEFAULT_VARIATION_MODEL || 'magic-art',
      promptObject: {
        imageUrl,
        mode,
        n: Number(n) || 4,
        isNiji6: false,
        aspect_width: Number(aspect_width) || 1,
        aspect_height: Number(aspect_height) || 1,
        maintainModeration: true,
      },
    };
    const data = await callOneMin('/api/features', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.post('/api/code/assist', async (req, res, next) => {
  try {
    const { instruction, fileName = 'untitled', language = 'plaintext', code = '', model } = req.body;
    if (!instruction || !String(instruction).trim()) return res.status(400).json({ error: 'instruction is required' });

    const prompt = `あなたは熟練のソフトウェアエンジニアです。以下のコードに対してユーザー指示を実行してください。\n\n出力ルール:\n- 変更コードが必要な場合は完全なコードブロックで返す\n- 変更理由を短く説明する\n- 可能なら注意点も述べる\n\nファイル名: ${fileName}\n言語: ${language}\n\nユーザー指示:\n${instruction}\n\n現在のコード:\n\`\`\`${language}\n${code}\n\`\`\``;

    const payload = {
      type: 'UNIFY_CHAT_WITH_AI',
      model: model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini',
      promptObject: { prompt, webSearch: false, history: false },
    };
    const data = await callOneMin('/api/chat-with-ai', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    res.json(data);
  } catch (err) { next(err); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error', details: err.payload || null });
});

app.listen(PORT, () => {
  console.log(`1min.ai Monaco client running: http://localhost:${PORT}`);
});
