import express from "express";
import crypto from "crypto";
import { executeCommand, checkCommandSafety } from "../services/command-runner.js";
import {
  validatePath,
  revalidateRealPath,
  assertNotProtectedPath,
  assertNotWriteProtectedPath,
  getAllowedRoots,
} from "../utils/fs-guard.js";
import { serverConfig } from "../config/server.js";
import fs from "fs/promises";
import path from "path";
import logger from "../utils/logger.js";

const MAX_AGENT_READ_SIZE = 10 * 1024 * 1024;
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".venv"]);

function resolveAgentPath(targetPath, sessionCwd = process.cwd()) {
  return path.isAbsolute(targetPath) ? targetPath : path.join(sessionCwd, targetPath);
}

function getSession(req, res) {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  session.lastAccessedAt = Date.now();
  return session;
}

const router = express.Router();

// Persistent session storage
const DATA_DIR = path.join(process.cwd(), ".mimocode", "data");
const SESSIONS_FILE = path.join(DATA_DIR, "agent_sessions.json");
const isTestMode = process.env.NODE_ENV === "test";

let sessions = new Map();
const pendingCommands = new Map();

// Cache the mkdir promise so it only runs once across concurrent calls.
let _dirReady = null;
async function ensureDataDir() {
  if (isTestMode) return;
  if (_dirReady) return _dirReady;
  _dirReady = fs.mkdir(DATA_DIR, { recursive: true }).catch((err) => {
    // Reset so a future call can retry (e.g. after a transient fs error).
    _dirReady = null;
    logger.error("Failed to create data directory", { error: err.message });
  });
  return _dirReady;
}

async function loadSessions() {
  if (isTestMode) return;
  try {
    await ensureDataDir();
    const data = await fs.readFile(SESSIONS_FILE, "utf-8");
    const parsed = JSON.parse(data);
    for (const [id, session] of Object.entries(parsed)) {
      if (!sessions.has(id)) {
        session.status = "idle"; // Ensure status is idle on load
        sessions.set(id, session);
      }
    }
    logger.info(`Loaded ${Object.keys(parsed).length} agent sessions from persistence`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      logger.error("Failed to load sessions from file", { error: err.message });
    }
  }
}

let _saveTimer = null;
let _isWriting = false;
let _needsSave = false;

async function flushSave() {
  if (_isWriting) {
    _needsSave = true;
    return;
  }
  _isWriting = true;
  _needsSave = false;
  try {
    await ensureDataDir();
    if (isTestMode) return;
    try {
      await fs.access(DATA_DIR);
    } catch {
      return;
    }
    const data = JSON.stringify(Object.fromEntries(sessions), null, 2);
    const tmpFile = SESSIONS_FILE + ".tmp";
    await fs.writeFile(tmpFile, data, "utf-8");
    await fs.rename(tmpFile, SESSIONS_FILE);
  } catch (err) {
    logger.error("Failed to save sessions to file", { error: err.message });
  } finally {
    _isWriting = false;
    if (_needsSave) {
      saveSessions();
    }
  }
}

/**
 * Debounced session persistence. Coalesces rapid calls (e.g. from
 * concurrent addHistoryEntry) into a single write after a short delay.
 */
function saveSessions() {
  if (isTestMode) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(flushSave, 50);
  _saveTimer.unref();
}

// Load sessions on startup
loadSessions();

const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_RESULT_SIZE = 10000; // chars

function addHistoryEntry(session, entry) {
  if (entry.result) {
    const stdoutRaw = entry.result.stdout || "";
    const stderrRaw = entry.result.stderr || "";
    const stdoutTruncated = stdoutRaw.length > MAX_HISTORY_RESULT_SIZE;
    const stderrTruncated = stderrRaw.length > MAX_HISTORY_RESULT_SIZE;
    entry.result = {
      ...entry.result,
      stdout: stdoutRaw ? stdoutRaw.slice(0, MAX_HISTORY_RESULT_SIZE) : "",
      stderr: stderrRaw ? stderrRaw.slice(0, MAX_HISTORY_RESULT_SIZE) : "",
      truncated: stdoutTruncated || stderrTruncated,
      stdoutTruncated,
      stderrTruncated,
    };
  }
  session.history.push(entry);
  if (session.history.length > MAX_HISTORY_ENTRIES) {
    session.history.shift();
  }
  saveSessions(); // Persist after change
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredSessions() {
  const now = Date.now();
  let changed = false;
  for (const [id, session] of sessions) {
    // M-5: Never reap a session that is actively executing a command —
    // doing so would orphan the spawned child process and confuse the
    // client waiting on the response.
    if (session.status === "running") continue;
    if (now - session.lastAccessedAt > SESSION_TTL_MS) {
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
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Create a new agent session.
 */
router.post("/sessions", async (req, res, next) => {
  try {
    const { id, cwd, task } = req.body;
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
      task: task || "",
      history: [],
      status: "idle",
      createdAt: new Date().toISOString(),
      lastAccessedAt: Date.now(),
    };

    if (sessions.size >= 1000) {
      const oldestId = Array.from(sessions.entries()).reduce((a, b) =>
        a[1].lastAccessedAt < b[1].lastAccessedAt ? a : b,
      )[0];
      sessions.delete(oldestId);
    }

    sessions.set(sessionId, session);
    saveSessions();
    res.json({ session });
  } catch (err) {
    next(err);
  }
});

/**
 * Get session info.
 */
router.get("/sessions/:id", (req, res) => {
  const session = getSession(req, res);
  if (!session) return;
  res.json({ session });
});

/**
 * List all sessions.
 */
router.get("/sessions", (_req, res) => {
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
router.post("/sessions/:id/commands", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    // Check if command execution is enabled
    if (!serverConfig.enableCommandExecution) {
      return res.status(403).json({
        error: "Command execution is disabled. Set ENABLE_COMMAND_EXECUTION=true to enable.",
      });
    }

    const { command, cwd, timeoutMs } = req.body;
    if (!command) {
      return res.status(400).json({ error: "command is required" });
    }

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
        approvalToken,
      });

      return res.json({
        requiresApproval: true,
        approvalToken,
        command,
        cwd: workingDir,
        message: "このコマンドを実行しますか？",
      });
    }

    // Execute command
    session.status = "running";
    logger.info(`Executing command (auto-approved or bypass-auth)`, {
      sessionId: req.params.id,
      command: command.split(/\s+/)[0],
      cwd: workingDir,
    });
    const result = await executeCommand(command, {
      cwd: workingDir,
      timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
    });

    session.status = "idle";
    logger.info(`Command execution finished`, {
      sessionId: req.params.id,
      command: command.split(/\s+/)[0],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    addHistoryEntry(session, {
      type: "command",
      command,
      cwd: workingDir,
      result,
      timestamp: new Date().toISOString(),
    });

    res.json({
      executed: true,
      command,
      cwd: workingDir,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Approve and execute a pending command.
 */
router.post("/sessions/:id/approve", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const { approvalToken, timeoutMs } = req.body;
    if (!approvalToken || !pendingCommands.has(approvalToken)) {
      return res.status(400).json({ error: "Invalid or expired approval token" });
    }

    const pending = pendingCommands.get(approvalToken);
    pendingCommands.delete(approvalToken);

    // Verify session ID matches
    if (pending.sessionId !== req.params.id) {
      return res.status(403).json({ error: "Session ID mismatch" });
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

    session.status = "running";
    logger.info(`Executing approved command`, {
      sessionId: req.params.id,
      command: pending.command.split(/\s+/)[0],
      cwd: workingDir,
    });
    const result = await executeCommand(pending.command, {
      cwd: workingDir,
      timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
    });

    session.status = "idle";
    logger.info(`Approved command finished`, {
      sessionId: req.params.id,
      command: pending.command.split(/\s+/)[0],
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });
    addHistoryEntry(session, {
      type: "command",
      command: pending.command,
      cwd: workingDir,
      result,
      approved: true,
      timestamp: new Date().toISOString(),
    });

    res.json({
      executed: true,
      command: pending.command,
      cwd: workingDir,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Read file within session context.
 */
router.get("/sessions/:id/files", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const filePath = req.query.path;
    if (!filePath) {
      return res.status(400).json({ error: "path is required" });
    }

    const resolvedPath = validatePath(resolveAgentPath(filePath, session.cwd));
    assertNotProtectedPath(resolvedPath);
    const realPath = revalidateRealPath(resolvedPath);
    assertNotProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Specified path is a directory" });
    }
    if (stat.size > MAX_AGENT_READ_SIZE) {
      return res.status(413).json({
        error: `File size (${stat.size} bytes) exceeds maximum read size (${MAX_AGENT_READ_SIZE} bytes)`,
      });
    }

    const content = await fs.readFile(realPath, "utf-8");

    res.json({
      path: realPath,
      content,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Write file within session context.
 */
router.post("/sessions/:id/files", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const { path: filePath, content } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "path is required" });
    }
    if (content !== undefined && typeof content !== "string") {
      return res.status(400).json({ error: "content must be a string" });
    }

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
      if (err.code !== "ENOENT") throw err;
    }

    const dir = path.dirname(realPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(realPath, content || "", "utf-8");

    addHistoryEntry(session, {
      type: "write",
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
router.get("/sessions/:id/search", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const { query, dir, maxResults = 20 } = req.query;
    if (!query) {
      return res.status(400).json({ error: "query is required" });
    }

    const searchDir = dir || session.cwd;
    const resolvedSearchDir = validatePath(resolveAgentPath(searchDir, session.cwd));
    assertNotProtectedPath(resolvedSearchDir);

    const limit = Math.max(1, Math.min(parseInt(maxResults) || 20, 100));

    // Simple recursive search (for production, use ripgrep or similar)
    const results = [];
    await searchInDirectory(resolvedSearchDir, query, results, limit);

    res.json({
      query,
      results,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Simple file content search with parallel processing.
 */
async function searchInDirectory(dir, query, results, maxResults, depth = 0) {
  if (results.length >= maxResults || depth > 8) return;

  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lowerQuery = query.toLowerCase();

    // Process entries in parallel batches to optimize I/O
    await Promise.all(
      entries.map(async (entry) => {
        if (results.length >= maxResults) return;

        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          return;
        }

        const fullPath = path.join(dir, entry.name);

        try {
          validatePath(fullPath);
        } catch {
          return;
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
            if (stat.size > 256 * 1024) return;

            const content = await fs.readFile(revalidated, "utf-8");
            const lines = content.split(/\r?\n/);

            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(lowerQuery)) {
                results.push({
                  file: revalidated,
                  line: i + 1,
                  content: lines[i].trim(),
                });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // Skip binary or unreadable files, or paths that fail re-validation
          }
        }
      }),
    );
    if (results.length > maxResults) {
      results.splice(maxResults);
    }
  } catch {
    // Skip inaccessible directories
  }
}

/**
 * List directory contents within session context.
 */
router.get("/sessions/:id/dir", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const dirPath = req.query.path || session.cwd;
    const resolvedPath = validatePath(dirPath);
    assertNotProtectedPath(resolvedPath);

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const items = entries
      .filter(
        (entry) => entry.name !== ".git" && entry.name !== "node_modules" && entry.name !== ".venv",
      )
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
router.post("/sessions/:id/diff", async (req, res, next) => {
  try {
    const session = getSession(req, res);
    if (!session) return;

    const { path: filePath, diff, dryRun = false } = req.body;
    if (!filePath) {
      return res.status(400).json({ error: "path is required" });
    }
    if (diff === undefined) {
      return res.status(400).json({ error: "diff is required" });
    }

    const agentPath = resolveAgentPath(filePath, session.cwd);
    const resolvedPath = validatePath(agentPath);
    assertNotWriteProtectedPath(resolvedPath);
    const realPath = revalidateRealPath(resolvedPath);
    assertNotWriteProtectedPath(realPath);

    const content = await fs.readFile(realPath, "utf-8");

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
          "有効な SEARCH/REPLACE ブロックが見つかりませんでした。フォーマット（<<<<<<< SEARCH、=======、>>>>>>> REPLACE）を確認してください。",
      });
    }

    // Determine the original EOL format to preserve it
    const hasCarriageReturn = content.includes("\r\n");
    const eol = hasCarriageReturn ? "\r\n" : "\n";
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
        const normFileLines = fileLines.map((l) => l.replace(/[ \t]+$/g, ""));
        const normSearchLines = searchLines.map((l) => l.replace(/[ \t]+$/g, ""));

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
        const cleanSearch = searchLines.map((l) => l.trim()).join("");
        const cleanFile = fileLines.map((l) => l.trim()).join("");
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
        logger.warn(
          `SEARCH block matched ${matchCount} times in ${resolvedPath}; requiring disambiguation`,
          { searchLines: searchLines.length },
        );
        return res.status(400).json({
          error: `置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません。前後の行も含めて指定してください：\n${block.search}`,
        });
      }

      // Determine indentation mapping from the first non-empty matched line
      let fileIndent = "";
      let searchIndent = "";
      let foundIndentLine = false;

      for (let j = 0; j < searchLines.length; j++) {
        if (searchLines[j].trim() !== "") {
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
        if (line.trim() === "") return "";
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
      await fs.writeFile(realPath, newContent, "utf-8");

      addHistoryEntry(session, {
        type: "diff",
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
      message: dryRun
        ? "プレビューを生成しました。"
        : `${blocks.length}個のブロックの置換に成功しました。`,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Get allowed roots.
 */
router.get("/config", (_req, res) => {
  res.json({
    enableCommandExecution: serverConfig.enableCommandExecution,
    commandTimeoutMs: serverConfig.commandTimeoutMs,
    agentAutoApprove: serverConfig.agentAutoApprove,
    allowedRoots: getAllowedRoots(),
  });
});

export default router;
