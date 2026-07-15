import express from 'express';
import { spawn } from 'child_process';
import { z } from 'zod';
import { killProcessTree } from '../../services/command-runner.js';
import { HttpError } from '../../utils/errors.js';
import {
  callOneMin,
  extractText,
  isFailedResponse,
  extractFailureMessage,
  normalizeOneMinRawResponse,
} from '../../utils/api-client.js';
import { parseWebSearchParams, buildCodePayload } from '../../utils/web-search.js';
import fsPkg from 'fs/promises';
import pathPkg from 'path';
import cryptoPkg from 'crypto';
import { validatePath, assertNotProtectedPath, PROJECT_ROOT } from '../../utils/fs-guard.js';
import { getSafeEnv } from '../../utils/env-guard.js';
import { serverConfig } from '../../config/server.js';

const router = express.Router();

const CODE_GENERATOR_FEATURE_ENDPOINT = '/api/features?isStreaming=true';

const codeGenerateSchema = z.object({
  instruction: z.preprocess(
    (val) => (val === undefined || val === null ? '' : String(val)),
    z
      .string()
      .refine((val) => val.trim().length > 0, { message: 'instruction is required' })
      .refine((val) => val.length <= 50000, { message: 'instruction exceeds 50000 characters' }),
  ),
  fileName: z.string().default('untitled'),
  language: z.string().default('plaintext'),
  code: z.preprocess(
    (val) => (val === undefined || val === null ? '' : String(val)),
    z.string().refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
  ),
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
});

function validateLineColumn(data, ctx) {
  const lineNum = Number(data.line);
  if (!Number.isInteger(lineNum) || lineNum < 1 || lineNum > 1000000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'line must be a positive integer',
    });
  }
  const colNum = Number(data.column);
  if (!Number.isInteger(colNum) || colNum < 1 || colNum > 1000000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'column must be a positive integer',
    });
  }
}

const codeAutocompleteSchema = z
  .object({
    code: z
      .string({ message: 'code, line, and column are required' })
      .refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
    line: z.any(),
    column: z.any(),
    fileName: z.string().optional(),
    language: z.string().optional(),
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
  .superRefine(validateLineColumn);

const codeInlineChatSchema = z
  .object({
    prompt: z
      .string({ message: 'prompt, code, line, and column are required' })
      .refine((val) => val.trim().length > 0, { message: 'prompt, code, line, and column are required' })
      .refine((val) => val.length <= 50000, { message: 'prompt exceeds 50000 characters' }),
    code: z
      .string({ message: 'prompt, code, line, and column are required' })
      .refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
    line: z.any(),
    column: z.any(),
    fileName: z.string().optional(),
    language: z.string().optional(),
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
  .superRefine(validateLineColumn);

function buildCodeContext(code, line, column, contextLines = 100) {
  const lines = code.split(/\r?\n/);
  const lineIndex = line - 1;
  const colIndex = column - 1;

  const linesBefore = lines.slice(0, lineIndex);
  const currentLine = lines[lineIndex] || '';
  const beforeCurrent = currentLine.substring(0, colIndex);
  const afterCurrent = currentLine.substring(colIndex);
  const linesAfter = lines.slice(lineIndex + 1);

  const beforeCode = [...linesBefore.slice(-contextLines), beforeCurrent].join('\n');
  const afterCode = [afterCurrent, ...linesAfter.slice(0, contextLines)].join('\n');

  return { beforeCode, afterCode };
}

function sanitizeForPrompt(value, maxLen = 256) {
  if (typeof value !== 'string') return '';
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
      .replace(/`{3}/g, "'''")
      .slice(0, maxLen)
      .trim()
  );
}

function stripCodeFences(text) {
  if (!text.includes('```')) return text;
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  return match ? match[1] : text.replace(/```/g, '');
}

router.post('/generate', async (req, res, next) => {
  try {
    const result = codeGenerateSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
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
    const dataRes = await callOneMin(CODE_GENERATOR_FEATURE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
      timeout: 600000,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes);
    if (isFailedResponse(normalizedDataRes)) {
      throw new HttpError(
        502,
        `1min.ai code generate failed: ${extractFailureMessage(normalizedDataRes)}`,
        'UPSTREAM_API_ERROR',
        normalizedDataRes,
      );
    }
    res.json(normalizedDataRes);
  } catch (err) {
    next(err);
  }
});

router.post('/autocomplete', async (req, res, next) => {
  try {
    const result = codeAutocompleteSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
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
ファイル名: ${sanitizeForPrompt(data.fileName || 'untitled')}
言語: ${sanitizeForPrompt(data.language || 'plaintext')}

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

    const dataRes = await callOneMin(CODE_GENERATOR_FEATURE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes);
    if (isFailedResponse(normalizedDataRes)) {
      throw new HttpError(
        502,
        `1min.ai code autocomplete failed: ${extractFailureMessage(normalizedDataRes)}`,
        'UPSTREAM_API_ERROR',
        normalizedDataRes,
      );
    }

    let suggestion = extractText(normalizedDataRes);
    suggestion = stripCodeFences(suggestion);

    res.json({ suggestion });
  } catch (err) {
    next(err);
  }
});

router.post('/inline-chat', async (req, res, next) => {
  try {
    const result = codeInlineChatSchema.safeParse(req.body);
    if (!result.success) {
      const errorMsg = result.error.issues[0]?.message || 'Validation error';
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
ファイル名: ${sanitizeForPrompt(data.fileName || 'untitled')}
言語: ${sanitizeForPrompt(data.language || 'plaintext')}
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

    const dataRes = await callOneMin(CODE_GENERATOR_FEATURE_ENDPOINT, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      raw: true,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes);
    if (isFailedResponse(normalizedDataRes)) {
      throw new HttpError(
        502,
        `1min.ai inline chat failed: ${extractFailureMessage(normalizedDataRes)}`,
        'UPSTREAM_API_ERROR',
        normalizedDataRes,
      );
    }

    let codeResult = extractText(normalizedDataRes);
    codeResult = stripCodeFences(codeResult);

    res.json({ code: codeResult });
  } catch (err) {
    next(err);
  }
});

const codeRunSchema = z.object({
  filePath: z
    .string()
    .refine((val) => /^[^"\n\r;|`<>&]*$/.test(val), {
      message: 'filePath contains invalid shell characters',
    })
    .optional(),
  code: z.string().max(500000, 'code exceeds 500000 characters').optional(),
  language: z.string().optional(),
  extension: z.string().optional(),
});

router.post('/run', async (req, res, next) => {
  let targetPath;
  let filePath;
  let code;
  let language;
  let extension;
  try {
    if (!serverConfig.enableCodeRun) {
      return res.status(403).json({
        error: 'Code execution is disabled. Set ENABLE_CODE_RUN=true in .env to enable.',
      });
    }

    const result = codeRunSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    }

    ({ filePath, code, language, extension } = result.data);
    if (filePath) {
      const resolvedPath = validatePath(filePath);
      assertNotProtectedPath(resolvedPath);
    }
    const ext = extension || (filePath ? pathPkg.extname(filePath).replace('.', '') : '');

    let runner = null;
    if (ext === 'py' || language === 'python') {
      runner = process.platform === 'win32' ? 'python' : 'python3';
    } else if (
      ext === 'js' ||
      ext === 'mjs' ||
      ext === 'cjs' ||
      language === 'javascript' ||
      language === 'typescript'
    ) {
      runner = 'node';
    }

    if (!runner) {
      return res.status(400).json({
        error: `Unsupported language for execution: ${language || ext || 'unknown'}. Supported: node (js), python (py).`,
      });
    }

    targetPath = filePath;

    if (code) {
      const tmpDir = pathPkg.join(PROJECT_ROOT, '.mimocode', 'tmp');
      await fsPkg.mkdir(tmpDir, { recursive: true });
      const tmpFile = pathPkg.join(
        tmpDir,
        `code_run_${cryptoPkg.randomBytes(6).toString('hex')}.${ext || 'js'}`,
      );
      await fsPkg.writeFile(tmpFile, code, 'utf-8');
      targetPath = tmpFile;
    }

    if (!targetPath) {
      return res.status(400).json({ error: 'No file path or code provided.' });
    }

    const cwd = filePath ? pathPkg.dirname(filePath) : process.cwd();

    const safeEnv = getSafeEnv();

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;

      const child = spawn(runner, [targetPath], {
        cwd,
        env: safeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        killed = true;
        killProcessTree(child, true);
      }, serverConfig.commandTimeoutMs || 30000);

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }

      child.on('close', (exitCode) => {
        clearTimeout(timeoutId);
        if (killed && exitCode === null) {
          exitCode = timedOut ? 124 : 1;
        }
        resolve({
          exitCode: exitCode ?? 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });

    res.json({
      ok: true,
      stdout: output.stdout || '',
      stderr: output.stderr || '',
      output: output.stdout || '',
      exitCode: output.exitCode ?? 0,
    });
  } catch (err) {
    next(err);
  } finally {
    if (targetPath && targetPath !== filePath) {
      fsPkg.unlink(targetPath).catch(() => {});
    }
  }
});

export default router;
