import express from 'express';
import { spawn } from 'child_process';
import { z } from 'zod';
import { collectProcessOutput, trackActiveProcess } from '../../services/command-runner.js';
import { HttpError } from '../../utils/errors.js';
import { extractText } from '../../utils/api-client.js';
import { parseWebSearchParams } from '../../utils/web-search.js';
import { assertCapability, getProvider, resolveProviderId } from '../../providers/index.js';
import fsPkg from 'fs/promises';
import pathPkg from 'path';
import cryptoPkg from 'crypto';
import { validatePath, assertNotProtectedPath, PROJECT_ROOT } from '../../utils/fs-guard.js';
import { getSafeEnv } from '../../utils/env-guard.js';
import { serverConfig } from '../../config/server.js';
import { TMP_DIR } from '../../config/paths.js';
import { bindRequestAbortSignal, booleanFlagInput, optionalNumberInput } from './utils.js';

const router = express.Router();

const codeGenerateSchema = z.object({
  provider: z.enum(['1min', '1forall']).optional(),
  useOpenAiCompat: z.boolean().optional(),
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
  webSearch: booleanFlagInput(false),
  numOfSite: optionalNumberInput(z.number().int().optional()),
  maxWord: optionalNumberInput(z.number().int().optional()),
});

function lineColumnSchema() {
  return optionalNumberInput(
    z
      .number({ message: 'line and column must be finite numbers' })
      .int({ message: 'line and column must be integers' })
      .min(1, { message: 'line and column must be >= 1' })
      .max(1000000, { message: 'line and column must be <= 1000000' }),
  );
}

const codeAutocompleteSchema = z.object({
  provider: z.enum(['1min', '1forall']).optional(),
  useOpenAiCompat: z.boolean().optional(),
  code: z
    .string({ message: 'code, line, and column are required' })
    .min(1, { message: 'code, line, and column are required' })
    .refine((val) => val.length <= 100000, { message: 'code exceeds 100000 characters' }),
  line: lineColumnSchema(),
  column: lineColumnSchema(),
  fileName: z.string().optional(),
  language: z.string().optional(),
  model: z.string().optional(),
  webSearch: booleanFlagInput(false),
  numOfSite: optionalNumberInput(z.number().int().optional()),
  maxWord: optionalNumberInput(z.number().int().optional()),
});

const codeInlineChatSchema = z.object({
  provider: z.enum(['1min', '1forall']).optional(),
  useOpenAiCompat: z.boolean().optional(),
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
  webSearch: booleanFlagInput(false),
  numOfSite: optionalNumberInput(z.number().int().optional()),
  maxWord: optionalNumberInput(z.number().int().optional()),
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
  const match = text.match(/```[^\r\n`]*\r?\n([\s\S]*?)```/);
  return match ? match[1] : text.replace(/```/g, '');
}

router.post('/generate', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const result = codeGenerateSchema.safeParse(req.body);
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

    const provider = getProvider(providerId);
    const normalizedDataRes = await provider.codeComplete({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
      useOpenAiCompat: data.useOpenAiCompat,
      task: 'generate',
      context: 'Code Generator generate',
      signal: controller.signal,
      timeout: 600000,
    });
    res.json(normalizedDataRes);
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

router.post('/autocomplete', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const result = codeAutocompleteSchema.safeParse(req.body);
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

    const provider = getProvider(providerId);
    const normalizedDataRes = await provider.codeComplete({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
      useOpenAiCompat: data.useOpenAiCompat,
      task: 'autocomplete',
      context: 'Code Generator autocomplete',
      maxTokens: serverConfig.oneForAllMaxTokensAutocomplete,
      signal: controller.signal,
    });

    let suggestion = extractText(normalizedDataRes);
    suggestion = stripCodeFences(suggestion);

    res.json({ suggestion });
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
  }
});

router.post('/inline-chat', async (req, res, next) => {
  const { controller, cleanup } = bindRequestAbortSignal(res);
  try {
    const result = codeInlineChatSchema.safeParse(req.body);
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

    const provider = getProvider(providerId);
    const normalizedDataRes = await provider.codeComplete({
      prompt,
      model: data.model,
      webSearch: parsedWebSearch,
      parsedNumOfSite,
      parsedMaxWord,
      useOpenAiCompat: data.useOpenAiCompat,
      task: 'inline',
      context: 'Code Generator inline-chat',
      maxTokens: serverConfig.oneForAllMaxTokensInline,
      signal: controller.signal,
    });

    let codeResult = extractText(normalizedDataRes);
    codeResult = stripCodeFences(codeResult);

    res.json({ code: codeResult });
  } catch (err) {
    if (controller.signal.aborted && (res.writableEnded || res.destroyed)) return;
    next(err);
  } finally {
    cleanup();
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
  let temporaryTargetPath;
  let filePath;
  let resolvedFilePath;
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
      resolvedFilePath = validatePath(filePath);
      assertNotProtectedPath(resolvedFilePath);
    }
    const ext = extension || (resolvedFilePath ? pathPkg.extname(resolvedFilePath).replace('.', '') : '');

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

    // Always execute the validated absolute path. Passing the original
    // relative path to spawn made execution depend on the server's current
    // directory instead of the path that was actually authorized.
    targetPath = resolvedFilePath;

    if (code) {
      const tmpDir = pathPkg.resolve(TMP_DIR);
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
      temporaryTargetPath = tmpFile;
    }

    if (!targetPath) {
      return res.status(400).json({ error: 'No file path or code provided.' });
    }

    const cwd = resolvedFilePath ? pathPkg.dirname(resolvedFilePath) : PROJECT_ROOT;

    const safeEnv = getSafeEnv();

    const maxOutputSize =
      Number.isFinite(serverConfig.maxCommandOutputSize) && serverConfig.maxCommandOutputSize > 0
        ? Math.floor(serverConfig.maxCommandOutputSize)
        : 10 * 1024 * 1024;

    const child = spawn(runner, [targetPath], {
      cwd,
      env: safeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const cleanupProcess = trackActiveProcess(child);
    let output;
    try {
      output = await collectProcessOutput(child, {
        timeoutMs: serverConfig.commandTimeoutMs || 30000,
        maxOutputSize,
        nullExitCode: 0,
        rawError: true,
      });
    } finally {
      cleanupProcess();
    }

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
    if (temporaryTargetPath) {
      fsPkg.unlink(temporaryTargetPath).catch(() => {});
    }
  }
});

export default router;
