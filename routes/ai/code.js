import express from 'express';
import { spawn } from 'child_process';
import { z } from 'zod';
import { killProcessTree, trackActiveProcess } from '../../services/command-runner.js';
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

function lineColumnSchema() {
  return z.preprocess(
    (val) => {
      if (val === undefined || val === null || val === '') return undefined;
      const n = Number(val);
      // Reject NaN, Infinity, and non-finite values that Number() can produce
      // from non-numeric input. Passing NaN through would otherwise be caught
      // by the downstream int() check, but a single tailored error message
      // is more actionable for the caller.
      if (!Number.isFinite(n)) return val;
      return n;
    },
    z
      .number({ message: 'line and column must be finite numbers' })
      .int({ message: 'line and column must be integers' })
      .min(1, { message: 'line and column must be >= 1' })
      .max(1000000, { message: 'line and column must be <= 1000000' }),
  );
}

const codeAutocompleteSchema = z.object({
  code: z
    .string({ message: 'code, line, and column are required' })
    .min(1, { message: 'code, line, and column are required' })
    .refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
  line: lineColumnSchema(),
  column: lineColumnSchema(),
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
});

const codeInlineChatSchema = z.object({
  prompt: z
    .string({ message: 'prompt, code, line, and column are required' })
    .min(1, { message: 'prompt, code, line, and column are required' })
    .refine((val) => val.trim().length > 0, { message: 'prompt, code, line, and column are required' })
    .refine((val) => val.length <= 50000, { message: 'prompt exceeds 50000 characters' }),
  code: z
    .string({ message: 'prompt, code, line, and column are required' })
    .min(1, { message: 'prompt, code, line, and column are required' })
    .refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
  line: lineColumnSchema(),
  column: lineColumnSchema(),
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
});

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

    const prompt = `You are an expert software engineer. Execute the user instruction on the following code.

Output rules:
- Return a complete code block if modified code is needed
- Briefly explain the reason for the changes
- Mention any important caveats or considerations if applicable

File name: ${sanitizeForPrompt(data.fileName)}
Language: ${sanitizeForPrompt(data.language)}

User instruction:
${data.instruction}

Current code:
\`\`\`${sanitizeForPrompt(data.language)}
${data.code}
\`\`\``;

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
      // SEC: CODE_GENERATOR creates an upstream record; never retry a POST
      // that would duplicate the side effect / credit consumption.
      idempotent: false,
      timeout: 600000,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes, {
      context: 'Code Generator generate',
    });
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
    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(data.code, data.line, data.column, 100);

    const prompt = `You are an AI coding assistant. The user is currently typing code in the editor. Suggest the code (a few lines up to approximately 20 lines) that should immediately follow the cursor position.
Output ONLY the suggested code. Do NOT include any explanations, markdown code block fences (\`\`\`), commentary, or greetings under any circumstances.
Ensure the suggested code connects seamlessly directly after the code before the cursor (do not duplicate code that has already been written).

Context:
File name: ${sanitizeForPrompt(data.fileName || 'untitled')}
Language: ${sanitizeForPrompt(data.language || 'plaintext')}

Code before cursor:
${beforeCode}

Code after cursor:
${afterCode}

Suggested code:`;

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
      // SEC: CODE_GENERATOR creates an upstream record; never retry a POST
      // that would duplicate the side effect / credit consumption.
      idempotent: false,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes, {
      context: 'Code Generator autocomplete',
    });
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
    const { parsedWebSearch, parsedNumOfSite, parsedMaxWord } = parseWebSearchParams({
      webSearch: data.webSearch,
      numOfSite: data.numOfSite,
      maxWord: data.maxWord,
    });

    const { beforeCode, afterCode } = buildCodeContext(data.code, data.line, data.column, 150);

    const prompt = `You are an expert software engineer. Execute the user instruction at the editor cursor position and output the code to be inserted or modified.
Output ONLY the proposed code. Do NOT include any explanations or markdown code block fences (\`\`\`).

Context:
File name: ${sanitizeForPrompt(data.fileName || 'untitled')}
Language: ${sanitizeForPrompt(data.language || 'plaintext')}
User instruction: ${data.prompt}

Code before cursor:
${beforeCode}

Code after cursor:
${afterCode}

Inserted/Modified code:`;

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
      // SEC: CODE_GENERATOR creates an upstream record; never retry a POST
      // that would duplicate the side effect / credit consumption.
      idempotent: false,
    });
    const normalizedDataRes = await normalizeOneMinRawResponse(dataRes, {
      context: 'Code Generator inline-chat',
    });
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
  // SEC-5: `extension` is used to build the temp file name handed to node/python.
  // Restrict it to short alphanumeric strings so it can never inject path
  // separators or traversal sequences (`../`) into the resolved tmp path.
  extension: z
    .string()
    .regex(/^[a-zA-Z0-9]+$/, { message: 'extension must be alphanumeric only' })
    .max(10, { message: 'extension must be 10 characters or fewer' })
    .optional(),
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
    } else if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || language === 'javascript') {
      // Note: `typescript` is intentionally not mapped to node — plain Node
      // cannot execute .ts sources directly on supported LTS runtimes, and
      // running them would surface a confusing SyntaxError instead of a
      // clear "unsupported language" response.
      runner = 'node';
    }

    if (!runner) {
      return res.status(400).json({
        error: `Unsupported language for execution: ${language || ext || 'unknown'}. Supported: node (js), python (py).`,
      });
    }

    targetPath = filePath;

    if (code) {
      const tmpDir = pathPkg.resolve(PROJECT_ROOT, '.mimocode', 'tmp');
      await fsPkg.mkdir(tmpDir, { recursive: true });
      // SEC-5: Defense-in-depth. The schema already restricts `extension` to
      // alphanumeric, but sanitize again and assert the resolved tmp path stays
      // inside tmpDir before writing anything to disk.
      const safeExt =
        String(ext || 'js')
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 10) || 'js';
      const tmpFile = pathPkg.join(tmpDir, `code_run_${cryptoPkg.randomBytes(6).toString('hex')}.${safeExt}`);
      if (!pathPkg.resolve(tmpFile).startsWith(tmpDir + pathPkg.sep)) {
        throw new HttpError(400, 'Invalid extension', 'INVALID_EXTENSION');
      }
      await fsPkg.writeFile(tmpFile, code, 'utf-8');
      targetPath = tmpFile;
    }

    if (!targetPath) {
      return res.status(400).json({ error: 'No file path or code provided.' });
    }

    const cwd = filePath ? pathPkg.dirname(filePath) : process.cwd();

    const safeEnv = getSafeEnv();

    const maxOutputSize = serverConfig.maxCommandOutputSize || 10 * 1024 * 1024;

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let killed = false;

      const child = spawn(runner, [targetPath], {
        cwd,
        env: safeEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      trackActiveProcess(child);

      const timeoutId = setTimeout(() => {
        timedOut = true;
        killed = true;
        killProcessTree(child, true);
      }, serverConfig.commandTimeoutMs || 30000);

      if (child.stdout) {
        child.stdout.on('data', (data) => {
          const text = data.toString();
          if (stdoutBytes < maxOutputSize) {
            if (stdoutBytes + text.length > maxOutputSize) {
              const allowedLen = maxOutputSize - stdoutBytes;
              stdout += text.slice(0, allowedLen) + '\n...[output truncated]';
              stdoutBytes = maxOutputSize;
              stdoutTruncated = true;
            } else {
              stdout += text;
              stdoutBytes += text.length;
            }
          } else if (!stdoutTruncated) {
            stdoutTruncated = true;
            stdout += '\n...[output truncated]';
          }
        });
      }
      if (child.stderr) {
        child.stderr.on('data', (data) => {
          const text = data.toString();
          if (stderrBytes < maxOutputSize) {
            if (stderrBytes + text.length > maxOutputSize) {
              const allowedLen = maxOutputSize - stderrBytes;
              stderr += text.slice(0, allowedLen) + '\n...[output truncated]';
              stderrBytes = maxOutputSize;
              stderrTruncated = true;
            } else {
              stderr += text;
              stderrBytes += text.length;
            }
          } else if (!stderrTruncated) {
            stderrTruncated = true;
            stderr += '\n...[output truncated]';
          }
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
          stdoutTruncated,
          stderrTruncated,
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
      stdoutTruncated: output.stdoutTruncated,
      stderrTruncated: output.stderrTruncated,
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
