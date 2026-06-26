import express from 'express';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { executeCommand, checkCommandSafety } from '../services/command-runner.js';
import { detectBinaryContent } from '../utils/mime-guard.js';
import {
  validatePath,
  revalidateRealPath,
  assertNotProtectedPath,
  assertNotWriteProtectedPath,
  getAllowedRoots,
} from '../utils/fs-guard.js';
import { serverConfig } from '../config/server.js';
import fs from 'fs/promises';
import path from 'path';
import { z } from 'zod';
import logger from '../utils/logger.js';

const sessionCreateSchema = z.object({
  id: z.string().optional(),
  cwd: z.string().optional(),
  task: z.string().optional(),
});

const commandExecuteSchema = z.object({
  command: z.string({ required_error: 'command is required' }).min(1, 'command is required'),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const approveSchema = z.object({
  approvalToken: z
    .string({ required_error: 'approvalToken is required' })
    .min(1, 'approvalToken is required'),
  timeoutMs: z.number().int().positive().optional(),
});

const fileReadSchema = z
  .object({
    path: z.string({ required_error: 'path is required' }).min(1, 'path is required'),
    startLine: z.preprocess(
      (val) => (val === undefined || val === null || val === '' ? undefined : Number(val)),
      z.number().int().min(1).optional(),
    ),
    endLine: z.preprocess(
      (val) => (val === undefined || val === null || val === '' ? undefined : Number(val)),
      z.number().int().min(1).optional(),
    ),
  })
  .refine(
    (data) => {
      if (data.startLine !== undefined && data.endLine !== undefined) {
        return data.startLine <= data.endLine;
      }
      return true;
    },
    {
      message: 'startLine must be less than or equal to endLine',
      path: ['startLine'],
    },
  );

const fileWriteSchema = z.object({
  path: z.string({ required_error: 'path is required' }).min(1, 'path is required'),
  content: z.string().optional(),
});

const searchSchema = z.object({
  query: z
    .string({ required_error: 'query is required', invalid_type_error: 'query is required' })
    .min(1, 'query is required'),
  dir: z.string().optional(),
  maxResults: z.preprocess(
    (val) => (val === undefined ? undefined : Number(val)),
    z.number().int().positive().max(100).optional().default(20),
  ),
});

const MAX_AGENT_READ_SIZE = 10 * 1024 * 1024;
const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv']);

function resolveAgentPath(targetPath, sessionCwd = process.cwd()) {
  return path.isAbsolute(targetPath) ? targetPath : path.join(sessionCwd, targetPath);
}

function getSession(req, res) {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  session.lastAccessedAt = Date.now();
  return session;
}

const router = express.Router();

// Persistent session storage
const DATA_DIR = path.join(process.cwd(), '.mimocode', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'agent_sessions.json');
// Pending commands also persist to disk so approval tokens survive a
// server restart (within their 5-minute expiry window).
const PENDING_COMMANDS_FILE = path.join(DATA_DIR, 'pending_commands.json');
const isTestMode = process.env.NODE_ENV === 'test';

let sessions = new Map();
const pendingCommands = new Map();

// --- Session Per-Key Lock ---

/**
 * Lightweight per-key async lock. Ensures that concurrent operations
 * targeting the same session key are serialized (non-reentrant).
 * Replaces direct read-modify-write on sessions Map entries.
 */
class SessionLock {
  #locks = new Map();

  /**
   * Run `fn` while holding the lock for `key`. The lock is automatically
   * released when `fn` settles (resolves or rejects).
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async acquire(key, fn) {
    let queue = this.#locks.get(key);
    if (!queue) {
      queue = [];
      this.#locks.set(key, queue);
    }
    while (queue.length > 0) {
      await queue[queue.length - 1];
    }
    let release;
    const holder = new Promise((resolve) => {
      release = resolve;
    });
    queue.push(holder);
    try {
      return await fn();
    } finally {
      queue.shift();
      if (queue.length === 0) this.#locks.delete(key);
      release();
    }
  }

  get size() {
    return this.#locks.size;
  }
}

const sessionLock = new SessionLock();

// --- Debounced File Writer ---

/**
 * Creates a debounced, atomic file writer that coalesces rapid calls
 * into a single write after a short delay. Uses .tmp + rename for
 * atomic writes and restricts file permissions to owner-only.
 *
 * @param {string} filePath - Target file path.
 * @param {() => string|Promise<string>} serialize - Returns the content to write.
 * @param {object} [opts]
 * @param {number} [opts.delayMs=50] - Debounce delay in milliseconds.
 * @param {string} [opts.label="data"] - Label for error logging.
 * @returns {{ save: () => void, flush: () => Promise<void> }}
 */
function createDebouncedFileWriter(filePath, serialize, { delayMs = 50, label = 'data' } = {}) {
  let timer = null;
  let isWriting = false;
  let needsSave = false;

  async function flush() {
    if (isWriting) {
      needsSave = true;
      return;
    }
    isWriting = true;
    needsSave = false;
    try {
      await ensureDataDir();
      if (isTestMode) return;
      try {
        await fs.access(DATA_DIR);
      } catch {
        return;
      }
      const data = await serialize();
      const tmpFile = filePath + '.tmp';
      await fs.writeFile(tmpFile, data, { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tmpFile, filePath);
    } catch (err) {
      logger.error(`Failed to save ${label} to file`, { error: err.message });
    } finally {
      isWriting = false;
      if (needsSave) {
        save();
      }
    }
  }

  function save() {
    if (isTestMode) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
    timer.unref();
  }

  return { save, flush };
}

// --- Pending Commands Persistence ---

// Cache the pending-commands-load promise so it runs exactly once.
let _pendingLoadReady = null;

async function loadPendingCommands() {
  if (isTestMode) return;
  if (_pendingLoadReady) return _pendingLoadReady;
  _pendingLoadReady = (async () => {
    try {
      await ensureDataDir();
      const data = await fs.readFile(PENDING_COMMANDS_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const now = Date.now();
      const FIVE_MIN = 5 * 60 * 1000;
      for (const [token, pending] of Object.entries(parsed)) {
        // Discard tokens that already expired while the server was down.
        if (now - pending.createdAt > FIVE_MIN) continue;
        pendingCommands.set(token, pending);
      }
      logger.info(`Loaded ${pendingCommands.size} pending commands from persistence`);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        logger.error('Failed to load pending commands from file', { error: err.message });
      }
    }
  })();
  return _pendingLoadReady;
}

const pendingWriter = createDebouncedFileWriter(
  PENDING_COMMANDS_FILE,
  () => JSON.stringify(Object.fromEntries(pendingCommands), null, 2),
  { label: 'pending commands' },
);

function savePendingCommands() {
  pendingWriter.save();
}

// Cache the mkdir promise so it only runs once across concurrent calls.
let _dirReady = null;
async function ensureDataDir() {
  if (isTestMode) return;
  if (_dirReady) return _dirReady;
  _dirReady = fs.mkdir(DATA_DIR, { recursive: true }).catch((err) => {
    // Reset so a future call can retry (e.g. after a transient fs error).
    _dirReady = null;
    logger.error('Failed to create data directory', { error: err.message });
  });
  return _dirReady;
}

// Load pending commands on startup alongside sessions
loadPendingCommands();

async function loadSessions() {
  if (isTestMode) return;
  try {
    await ensureDataDir();
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    for (const [id, session] of Object.entries(parsed)) {
      if (!sessions.has(id)) {
        session.status = 'idle'; // Ensure status is idle on load
        sessions.set(id, session);
      }
    }
    logger.info(`Loaded ${Object.keys(parsed).length} agent sessions from persistence`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error('Failed to load sessions from file', { error: err.message });
    }
  }
}

const sessionWriter = createDebouncedFileWriter(
  SESSIONS_FILE,
  () => {
    const rawSessions = Object.fromEntries(sessions);
    const apiKey = process.env.ONE_MIN_AI_API_KEY;
    // SEC-4: Mask sensitive keys if present in the data
    return JSON.stringify(
      rawSessions,
      (key, value) => {
        if (
          typeof value === 'string' &&
          apiKey &&
          apiKey !== 'your_1min_ai_api_key_here' &&
          value.includes(apiKey)
        ) {
          return value.split(apiKey).join('***MASKED***');
        }
        return value;
      },
      2,
    );
  },
  { label: 'sessions' },
);

/**
 * Debounced session persistence. Coalesces rapid calls (e.g. from
 * concurrent addHistoryEntry) into a single write after a short delay.
 */
function saveSessions() {
  sessionWriter.save();
}

// Load sessions on startup
loadSessions();

const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_RESULT_SIZE = 10000; // chars
const MAX_PENDING_COMMANDS = 100;

async function addHistoryEntry(session, entry) {
  if (entry.result) {
    const stdoutRaw = entry.result.stdout || '';
    const stderrRaw = entry.result.stderr || '';
    const stdoutTruncated = stdoutRaw.length > MAX_HISTORY_RESULT_SIZE;
    const stderrTruncated = stderrRaw.length > MAX_HISTORY_RESULT_SIZE;
    entry.result = {
      ...entry.result,
      stdout: stdoutRaw ? stdoutRaw.slice(0, MAX_HISTORY_RESULT_SIZE) : '',
      stderr: stderrRaw ? stderrRaw.slice(0, MAX_HISTORY_RESULT_SIZE) : '',
      truncated: stdoutTruncated || stderrTruncated,
      stdoutTruncated,
      stderrTruncated,
    };
  }
  await sessionLock.acquire(session.id, async () => {
    session.history.push(entry);
    if (session.history.length > MAX_HISTORY_ENTRIES) {
      session.history.shift();
    }
  });
  saveSessions();
}

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    // M-5: Never reap a session that is actively executing a command —
    // doing so would orphan the spawned child process and confuse the
    // client waiting on the response.
    if (session.status === 'running') continue;
    if (now - session.lastAccessedAt > serverConfig.sessionTtlMs) {
      sessions.delete(id);
      changed = true;
    }
  }
  for (const [token, pending] of pendingCommands) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pendingCommands.delete(token);
    }
  }
  if (changed) {
    saveSessions();
  }

  // Clean up isolated temporary files (.tmp) in DATA_DIR that are older than 30 minutes
  (async () => {
    try {
      const files = await fs.readdir(DATA_DIR);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          const filePath = path.join(DATA_DIR, file);
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > 30 * 60 * 1000) {
            await fs.unlink(filePath).catch(() => {});
          }
        }
      }
    } catch (err) {
      // Best-effort cleanup, ignore errors
    }
  })().catch(() => {});
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Create a new agent session.
 */
router.post('/sessions', async (req, res, next) => {
  try {
    const result = sessionCreateSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { id, cwd, task } = result.data;
    const sessionId = id || crypto.randomUUID();

    let validatedCwd;
    if (cwd) {
      try {
        validatedCwd = validatePath(path.resolve(cwd));
        assertNotProtectedPath(validatedCwd);
      } catch (err) {
        return res.status(400).json({ error: `Invalid working directory: ${err.message}` });
      }
    } else {
      validatedCwd = process.cwd();
    }

    const session = {
      id: sessionId,
      cwd: validatedCwd,
      task: task || '',
      history: [],
      status: 'idle',
      createdAt: new Date().toISOString(),
      lastAccessedAt: Date.now(),
    };

    const MAX_SESSIONS = parseInt(process.env.AGENT_MAX_SESSIONS, 10) || 50;
    if (sessions.size >= MAX_SESSIONS) {
      // M-5: Never evict a session that is actively running a command —
      // killing it would orphan the spawned child process. Prefer evicting
      // the oldest idle/non-running session instead.
      const evictableEntries = Array.from(sessions.entries()).filter(([, s]) => s.status !== 'running');
      if (evictableEntries.length === 0) {
        return res.status(503).json({
          error:
            'Maximum concurrent sessions reached and all sessions are currently running. Try again later.',
        });
      }
      const oldestId = evictableEntries.reduce((a, b) =>
        a[1].lastAccessedAt < b[1].lastAccessedAt ? a : b,
      )[0];
      sessions.delete(oldestId);
    }

    await sessionLock.acquire(sessionId, async () => {
      sessions.set(sessionId, session);
    });
    saveSessions();
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

/**
 * Get session info.
 */
router.get('/sessions/:id', (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ session });
});

/**
 * List all sessions.
 */
router.get('/sessions', (_req, res) => {
  const list = Array.from(sessions.values()).map((s) => ({
    id: s.id,
    task: s.task,
    status: s.status,
    createdAt: s.createdAt,
  }));
  res.json({ sessions: list });
});

/**
 * Execute a command within a session.
 */
router.post('/sessions/:id/commands', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    // Check if command execution is enabled
    if (!serverConfig.enableCommandExecution) {
      return res.status(403).json({
        error: 'Command execution is disabled. Set ENABLE_COMMAND_EXECUTION=true to enable.',
      });
    }

    const resultBody = commandExecuteSchema.safeParse(req.body);
    if (!resultBody.success)
      return res.status(400).json({ error: resultBody.error.issues[0]?.message || 'Validation error' });
    const { command, cwd, timeoutMs } = resultBody.data;

    const isStream = req.query.stream === 'true';

    // Validate working directory
    const workingDir = path.resolve(resolveAgentPath(cwd || session.cwd, session.cwd));
    try {
      validatePath(workingDir);
      assertNotProtectedPath(workingDir);
    } catch (err) {
      return res.status(403).json({ error: `Invalid working directory: ${err.message}` });
    }

    // Safety check
    const safety = checkCommandSafety(command);
    if (!safety.safe) {
      return res.status(400).json({
        error: `Command blocked: ${safety.reason}`,
        safety,
      });
    }

    // Security: Do not trust the client's requireApproval flag.
    // Use the server configuration as the source of truth.
    const effectiveRequireApproval = !serverConfig.agentAutoApprove;

    // If approval required, store command and return token for review
    if (effectiveRequireApproval) {
      // Enforce size cap to prevent unbounded memory growth from
      // a runaway LLM loop generating thousands of pending commands.
      if (pendingCommands.size >= MAX_PENDING_COMMANDS) {
        const oldestToken = pendingCommands.keys().next().value;
        pendingCommands.delete(oldestToken);
        savePendingCommands();
      }

      const approvalToken = crypto.randomUUID();
      pendingCommands.set(approvalToken, {
        command,
        cwd: workingDir,
        sessionId: req.params.id,
        createdAt: Date.now(),
      });

      logger.info(`Command execution paused, awaiting user approval`, {
        sessionId: req.params.id,
        command: command.split(/\s+/)[0],
        cwd: workingDir,
      });

      return res.json({
        requiresApproval: true,
        approvalToken,
        command,
        cwd: workingDir,
        message: 'このコマンドを実行しますか？',
      });
    }

    session.status = 'running';
    logger.info(`Executing command (auto-approved or bypass-auth)`, {
      sessionId: req.params.id,
      command: command.split(/\s+/)[0],
    });

    let result;
    try {
      let onOutput = null;
      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        onOutput = (type, text) => {
          res.write(`event: ${type}\n`);
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        };
      }

      result = await executeCommand(command, {
        cwd: workingDir,
        timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
        onOutput,
      });
    } finally {
      session.status = 'idle';
    }
    logger.info(`Command execution finished`, {
      sessionId: req.params.id,
      command: command.split(/\s+/)[0],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    await addHistoryEntry(session, {
      type: 'command',
      command,
      cwd: workingDir,
      result,
      timestamp: new Date().toISOString(),
    });

    if (isStream) {
      res.write(`event: done\n`);
      res.write(`data: ${JSON.stringify({ executed: true, command, cwd: workingDir, ...result })}\n\n`);
      res.end();
    } else {
      res.json({
        executed: true,
        command,
        cwd: workingDir,
        ...result,
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Approve and execute a pending command.
 */
router.post('/sessions/:id/approve', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const resultBody = approveSchema.safeParse(req.body);
    if (!resultBody.success)
      return res.status(400).json({ error: resultBody.error.issues[0]?.message || 'Validation error' });
    const { approvalToken, timeoutMs } = resultBody.data;

    const isStream = req.query.stream === 'true';
    if (!pendingCommands.has(approvalToken)) {
      return res.status(400).json({ error: 'Invalid or expired approval token' });
    }

    const pending = pendingCommands.get(approvalToken);
    pendingCommands.delete(approvalToken);
    savePendingCommands();

    // Verify session ID matches
    if (pending.sessionId !== req.params.id) {
      return res.status(403).json({ error: 'Session ID mismatch' });
    }

    // Re-verify safety before execution
    const safety = checkCommandSafety(pending.command);
    if (!safety.safe) {
      return res.status(400).json({
        error: `Command blocked: ${safety.reason}`,
        safety,
      });
    }

    const workingDir = path.resolve(resolveAgentPath(pending.cwd, session.cwd));
    validatePath(workingDir);
    assertNotProtectedPath(workingDir);

    session.status = 'running';
    logger.info(`Executing approved command`, {
      sessionId: req.params.id,
      command: pending.command.split(/\s+/)[0],
    });

    let result;
    try {
      let onOutput = null;
      if (isStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        onOutput = (type, text) => {
          res.write(`event: ${type}\n`);
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        };
      }

      result = await executeCommand(pending.command, {
        cwd: workingDir,
        timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
        onOutput,
      });
    } finally {
      session.status = 'idle';
    }
    logger.info(`Approved command finished`, {
      sessionId: req.params.id,
      command: pending.command.split(/\s+/)[0],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    await addHistoryEntry(session, {
      type: 'command',
      command: pending.command,
      cwd: workingDir,
      result,
      approved: true,
      timestamp: new Date().toISOString(),
    });

    if (isStream) {
      res.write(`event: done\n`);
      res.write(
        `data: ${JSON.stringify({ executed: true, command: pending.command, cwd: workingDir, ...result })}\n\n`,
      );
      res.end();
    } else {
      res.json({
        executed: true,
        command: pending.command,
        cwd: workingDir,
        ...result,
      });
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Read file within session context.
 */
router.get('/sessions/:id/files', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const resultQuery = fileReadSchema.safeParse(req.query);
    if (!resultQuery.success)
      return res.status(400).json({ error: resultQuery.error.issues[0]?.message || 'Validation error' });
    const { path: filePath, startLine, endLine } = resultQuery.data;

    const resolvedPath = validatePath(resolveAgentPath(filePath, session.cwd));
    assertNotProtectedPath(resolvedPath);
    const realPath = revalidateRealPath(resolvedPath);
    assertNotProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is a directory' });
    }
    if (stat.size > MAX_AGENT_READ_SIZE) {
      return res.status(413).json({
        error: `File size (${stat.size} bytes) exceeds maximum read size (${MAX_AGENT_READ_SIZE} bytes)`,
      });
    }

    const buffer = await fs.readFile(realPath);
    if (detectBinaryContent(buffer)) {
      return res.status(400).json({ error: 'Cannot read binary files as text in the agent.' });
    }

    const content = buffer.toString('utf-8');
    let finalContent = content;
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split(/\r?\n/);
      const start = startLine !== undefined ? startLine - 1 : 0;
      const end = endLine !== undefined ? endLine : lines.length;
      finalContent = lines.slice(start, end).join('\n');
    }

    res.json({
      path: realPath,
      content: finalContent,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Write file within session context.
 */
router.post('/sessions/:id/files', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const resultBody = fileWriteSchema.safeParse(req.body);
    if (!resultBody.success)
      return res.status(400).json({ error: resultBody.error.issues[0]?.message || 'Validation error' });
    const { path: filePath, content } = resultBody.data;

    const resolvedPath = validatePath(resolveAgentPath(filePath, session.cwd));
    assertNotWriteProtectedPath(resolvedPath);

    // TOCTOU mitigation: if file already exists, re-verify real path before overwrite
    let realPath = resolvedPath;
    try {
      const stat = await fs.stat(resolvedPath);
      if (stat.isFile()) {
        realPath = revalidateRealPath(resolvedPath);
        assertNotWriteProtectedPath(realPath);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const dir = path.dirname(realPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(realPath, content || '', 'utf-8');

    await addHistoryEntry(session, {
      type: 'write',
      path: realPath,
      timestamp: new Date().toISOString(),
    });

    res.json({
      ok: true,
      path: realPath,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Search files within session context.
 */
let _isRgAvailable = null;
async function checkRgAvailable() {
  if (_isRgAvailable !== null) return _isRgAvailable;
  return new Promise((resolve) => {
    const child = spawn('rg', ['--version'], { stdio: 'ignore' });
    child.on('close', (code) => {
      _isRgAvailable = code === 0;
      resolve(_isRgAvailable);
    });
    child.on('error', () => {
      _isRgAvailable = false;
      resolve(false);
    });
  });
}

async function searchWithRg(dir, query, maxResults) {
  return new Promise((resolve) => {
    const args = [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--fixed-strings',
      '--ignore-case',
      '--max-filesize',
      '256K',
      '--glob',
      '!.git',
      '--glob',
      '!node_modules',
      '--glob',
      '!.venv',
      '--',
      query,
      dir,
    ];

    const child = spawn('rg', args);
    let stdout = '';
    let resultCount = 0;
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Early exit: count lines to avoid buffering large outputs in memory.
      // rg outputs one result per line; stop accumulating once we have
      // roughly enough lines (with a safety margin of 2x).
      if (!resultCount) {
        resultCount = (stdout.match(/\r?\n/g) || []).length;
      } else {
        resultCount += (data.toString().match(/\r?\n/g) || []).length;
      }
      if (resultCount >= maxResults * 2) {
        child.kill();
      }
    });

    child.on('close', (code) => {
      if (code !== 0 && code !== 1) {
        resolve(null);
        return;
      }

      const results = [];
      const lines = stdout.split(/\r?\n/);
      for (const line of lines) {
        if (results.length >= maxResults) break;
        if (!line.trim()) continue;

        const parts = line.split(':');
        if (parts.length >= 3) {
          let file;
          let lineNumStr;
          let content;

          if (process.platform === 'win32' && parts[0].length === 1 && /^[a-zA-Z]$/.test(parts[0])) {
            file = parts[0] + ':' + parts[1];
            lineNumStr = parts[2];
            content = parts.slice(3).join(':');
          } else {
            file = parts[0];
            lineNumStr = parts[1];
            content = parts.slice(2).join(':');
          }

          const lineNum = parseInt(lineNumStr, 10);
          if (!isNaN(lineNum)) {
            try {
              const resolvedFile = validatePath(file);
              assertNotProtectedPath(resolvedFile);
              results.push({
                file: resolvedFile,
                line: lineNum,
                content: content.trim(),
              });
            } catch {
              // Ignore matches in files outside allowed roots or protected paths
            }
          }
        }
      }
      resolve(results);
    });

    child.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * Search files within session context.
 */
router.get('/sessions/:id/search', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const resultQuery = searchSchema.safeParse(req.query);
    if (!resultQuery.success)
      return res.status(400).json({ error: resultQuery.error.issues[0]?.message || 'Validation error' });
    const { query, dir, maxResults } = resultQuery.data;

    const searchDir = dir || session.cwd;
    const resolvedSearchDir = validatePath(resolveAgentPath(searchDir, session.cwd));
    assertNotProtectedPath(resolvedSearchDir);

    const limit = maxResults;

    let results = null;
    const rgAvailable = await checkRgAvailable();
    if (rgAvailable) {
      results = await searchWithRg(resolvedSearchDir, query, limit);
    }

    if (results === null) {
      results = [];
      await searchInDirectory(resolvedSearchDir, query, results, limit);
    }

    res.json({
      query,
      results,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Simple file content search with controlled sequential processing.
 * Sequential processing prevents race conditions on the shared `results` array
 * while still being fast enough for local filesystem searches.
 */
async function searchInDirectory(dir, query, results, maxResults, depth = 0) {
  if (results.length >= maxResults || depth > 8) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lowerQuery = query.toLowerCase();

    for (const entry of entries) {
      if (results.length >= maxResults) break;

      if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      try {
        validatePath(fullPath);
      } catch {
        continue;
      }

      if (entry.isDirectory()) {
        try {
          const revalidatedDir = revalidateRealPath(fullPath);
          assertNotProtectedPath(revalidatedDir);
          await searchInDirectory(revalidatedDir, query, results, maxResults, depth + 1);
        } catch {
          // Skip directories that fail re-validation or are protected
        }
      } else if (entry.isFile()) {
        try {
          const revalidated = revalidateRealPath(fullPath);
          const stat = await fs.stat(revalidated);
          if (stat.size > 256 * 1024) continue;

          const content = await fs.readFile(revalidated, 'utf-8');
          const lines = content.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            if (results.length >= maxResults) break;
            if (lines[i].toLowerCase().includes(lowerQuery)) {
              results.push({
                file: revalidated,
                line: i + 1,
                content: lines[i].trim(),
              });
            }
          }
        } catch {
          // Skip binary or unreadable files, or paths that fail re-validation
        }
      }
    }
  } catch {
    // Skip inaccessible directories
  }
}

/**
 * List directory contents within session context.
 */
router.get('/sessions/:id/dir', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const dirPath = req.query.path || session.cwd;
    const resolvedPath = validatePath(dirPath);
    assertNotProtectedPath(resolvedPath);

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const items = entries
      .filter((entry) => entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== '.venv')
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        path: path.join(resolvedPath, entry.name),
      }));

    res.json({
      path: resolvedPath,
      items,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Apply a SEARCH/REPLACE diff to a file within session context.
 */
router.post('/sessions/:id/diff', async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const { path: filePath, diff, dryRun = false } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: 'path is required' });
    }
    if (diff === undefined) {
      return res.status(400).json({ error: 'diff is required' });
    }

    const agentPath = resolveAgentPath(filePath, session.cwd);
    const resolvedPath = validatePath(agentPath);
    assertNotWriteProtectedPath(resolvedPath);
    const realPath = revalidateRealPath(resolvedPath);
    assertNotWriteProtectedPath(realPath);

    const content = await fs.readFile(realPath, 'utf-8');

    // M-13: Construct the regex inside the handler so its `lastIndex` is
    // reset on every call. Reusing a module-level /g regex would otherwise
    // resume from the previous invocation and silently drop blocks.
    const blockRegex =
      /<<<<<<< SEARCH[ \t]*\r?\n([\s\S]*?)\r?\n=======[ \t]*\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE[ \t]*/g;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(diff)) !== null) {
      blocks.push({
        search: match[1],
        replace: match[2],
      });
    }

    if (blocks.length === 0) {
      return res.status(400).json({
        error:
          '有効な SEARCH/REPLACE ブロックが見つかりませんでした。フォーマット（<<<<<<< SEARCH、=======、>>>>>>> REPLACE）を確認してください。',
      });
    }

    // Determine the original EOL format to preserve it
    const hasCarriageReturn = content.includes('\r\n');
    const eol = hasCarriageReturn ? '\r\n' : '\n';
    let fileLines = content.split(/\r?\n/);

    for (const block of blocks) {
      // Split search and replace blocks by line
      const searchLines = block.search.split(/\r?\n/);
      const replaceLines = block.replace.split(/\r?\n/);

      let matchedIndex = -1;
      let matchCount = 0;

      // 1. Try Exact Match (preserving exact indentation and trailing spaces)
      for (let i = 0; i <= fileLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (fileLines[i + j] !== searchLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          matchedIndex = i;
          matchCount++;
        }
      }

      // 2. Try Normalized Match (ignore trailing spaces) if exact match fails
      if (matchCount === 0) {
        const normFileLines = fileLines.map((l) => l.replace(/[ \t]+$/g, ''));
        const normSearchLines = searchLines.map((l) => l.replace(/[ \t]+$/g, ''));

        for (let i = 0; i <= normFileLines.length - normSearchLines.length; i++) {
          let match = true;
          for (let j = 0; j < normSearchLines.length; j++) {
            if (normFileLines[i + j] !== normSearchLines[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            matchedIndex = i;
            matchCount++;
          }
        }
      }

      // 3. Try Indentation-Insensitive Match (ignore leading and trailing spaces) if normalized match fails
      if (matchCount === 0) {
        const cleanFileLines = fileLines.map((l) => l.trim());
        const cleanSearchLines = searchLines.map((l) => l.trim());

        for (let i = 0; i <= cleanFileLines.length - cleanSearchLines.length; i++) {
          let match = true;
          for (let j = 0; j < cleanSearchLines.length; j++) {
            if (cleanFileLines[i + j] !== cleanSearchLines[j]) {
              match = false;
              break;
            }
          }
          if (match) {
            matchedIndex = i;
            matchCount++;
          }
        }
      }

      // Check results
      if (matchCount === 0) {
        // Try to find a "fuzzy" match to provide a better error hint
        const cleanSearch = searchLines.map((l) => l.trim()).join('');
        const cleanFile = fileLines.map((l) => l.trim()).join('');
        const isFuzzyMatch = cleanFile.includes(cleanSearch);

        let errorMsg = `置換対象の SEARCH ブロックのコードが見つかりません。インデントや改行が既存ファイルの内容と完全に一致している必要があります。`;
        if (isFuzzyMatch) {
          errorMsg += `\nヒント: コードの内容は似ていますが、インデントや不可視文字（タブ/スペース）が異なっている可能性があります。`;
        }
        errorMsg += `\n\n対象のコード:\n${block.search}`;

        return res.status(400).json({ error: errorMsg });
      }

      // H-2: Multiple matches always require explicit disambiguation by the
      // caller. Indentation-insensitive matching in particular frequently
      // produces false positives (a lone `}` or empty line), so silently
      // picking the first hit risks replacing the wrong section. The user
      // (or upstream agent) is expected to add surrounding context lines
      // until the match becomes unique.
      if (matchCount > 1) {
        logger.warn(`SEARCH block matched ${matchCount} times in ${resolvedPath}; requiring disambiguation`, {
          searchLines: searchLines.length,
        });
        return res.status(400).json({
          error: `置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません。前後の行も含めて指定してください：\n${block.search}`,
        });
      }

      // Determine indentation mapping from the first non-empty matched line
      let fileIndent = '';
      let searchIndent = '';
      let foundIndentLine = false;

      for (let j = 0; j < searchLines.length; j++) {
        if (searchLines[j].trim() !== '') {
          fileIndent = fileLines[matchedIndex + j].match(/^\s*/)[0];
          searchIndent = searchLines[j].match(/^\s*/)[0];
          foundIndentLine = true;
          break;
        }
      }

      if (!foundIndentLine) {
        fileIndent = fileLines[matchedIndex].match(/^\s*/)[0];
        searchIndent = searchLines[0].match(/^\s*/)[0];
      }

      // Adjust replacement lines to match the file's indentation level
      const adjustedReplaceLines = replaceLines.map((line) => {
        if (line.trim() === '') return '';
        if (searchIndent && line.startsWith(searchIndent)) {
          return fileIndent + line.slice(searchIndent.length);
        }
        if (!searchIndent && fileIndent) {
          return fileIndent + line;
        }
        return line;
      });

      // Apply replacement directly to the line array slice
      fileLines.splice(matchedIndex, searchLines.length, ...adjustedReplaceLines);
    }

    const newContent = fileLines.join(eol);

    if (!dryRun) {
      await fs.writeFile(realPath, newContent, 'utf-8');

      await addHistoryEntry(session, {
        type: 'diff',
        path: realPath,
        timestamp: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      path: realPath,
      // M-5: Only return newContent on dryRun to avoid sending large file contents
      // unnecessarily when the write has already been committed to disk.
      ...(dryRun ? { newContent } : {}),
      message: dryRun ? 'プレビューを生成しました。' : `${blocks.length}個のブロックの置換に成功しました。`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete all sessions and pending commands.
 */
router.delete('/sessions/all', (req, res, next) => {
  try {
    sessions.clear();
    pendingCommands.clear();
    saveSessions();
    savePendingCommands();
    res.json({ ok: true, message: 'All sessions and pending commands cleared' });
  } catch (err) {
    next(err);
  }
});

/**
 * Get allowed roots.
 */
router.get('/config', (_req, res) => {
  res.json({
    enableCommandExecution: serverConfig.enableCommandExecution,
    commandTimeoutMs: serverConfig.commandTimeoutMs,
    agentAutoApprove: serverConfig.agentAutoApprove,
    maxLoops: serverConfig.agentMaxLoops,
    allowedRoots: getAllowedRoots(),
  });
});

export default router;
