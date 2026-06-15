import express from 'express';
import crypto from 'crypto';
import { executeCommand, checkCommandSafety } from '../services/command-runner.js';
import { validatePath, assertNotProtectedPath, assertNotWriteProtectedPath, getAllowedRoots } from '../utils/fs-guard.js';
import { serverConfig } from '../config/server.js';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

// In-memory session store (replace with persistent store in production)
const sessions = new Map();
const pendingCommands = new Map();

const MAX_HISTORY_ENTRIES = 100;
const MAX_HISTORY_RESULT_SIZE = 10000; // chars

function addHistoryEntry(session, entry) {
    if (entry.result) {
        entry.result = {
            ...entry.result,
            stdout: entry.result.stdout ? entry.result.stdout.slice(0, MAX_HISTORY_RESULT_SIZE) : '',
            stderr: entry.result.stderr ? entry.result.stderr.slice(0, MAX_HISTORY_RESULT_SIZE) : '',
        };
    }
    session.history.push(entry);
    if (session.history.length > MAX_HISTORY_ENTRIES) {
        session.history.shift();
    }
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of sessions) {
        const createdAt = new Date(session.createdAt).getTime();
        if (now - createdAt > SESSION_TTL_MS) {
            sessions.delete(id);
        }
    }
    for (const [token, pending] of pendingCommands) {
        if (now - pending.createdAt > 5 * 60 * 1000) {
            pendingCommands.delete(token);
        }
    }
}

const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

/**
 * Create a new agent session.
 */
router.post('/sessions', (req, res, next) => {
    try {
        const { id, cwd, task } = req.body;
        const sessionId = id || crypto.randomUUID();

        let validatedCwd = cwd || process.cwd();
        if (cwd) {
            try {
                validatedCwd = validatePath(cwd);
                assertNotProtectedPath(validatedCwd);
            } catch (e) {
                return res.status(400).json({ error: `Invalid cwd: ${e.message}` });
            }
        }

        const session = {
            id: sessionId,
            cwd: validatedCwd,
            task: task || '',
            history: [],
            status: 'idle',
            createdAt: new Date().toISOString(),
        };

        sessions.set(sessionId, session);
        res.json({ session });
    } catch (err) {
        next(err);
    }
});

/**
 * Get session info.
 */
router.get('/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    res.json({ session });
});

/**
 * List all sessions.
 */
router.get('/sessions', (_req, res) => {
    const list = Array.from(sessions.values()).map(s => ({
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
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        // Check if command execution is enabled
        if (!serverConfig.enableCommandExecution) {
            return res.status(403).json({
                error: 'Command execution is disabled. Set ENABLE_COMMAND_EXECUTION=true to enable.'
            });
        }

        const { command, cwd, timeoutMs, requireApproval = true } = req.body;
        if (!command) {
            return res.status(400).json({ error: 'command is required' });
        }

        // Validate working directory
        const workingDir = cwd || session.cwd;
        try {
            validatePath(workingDir);
        } catch (err) {
            return res.status(403).json({ error: `Invalid working directory: ${err.message}` });
        }

        // Safety check
        const safety = checkCommandSafety(command);
        if (!safety.safe) {
            return res.status(400).json({
                error: `Command blocked: ${safety.reason}`,
                safety
            });
        }

        // If approval required, store command and return token for review
        if (requireApproval && !serverConfig.agentAutoApprove) {
            const approvalToken = crypto.randomUUID();
            pendingCommands.set(approvalToken, {
                command,
                cwd: workingDir,
                sessionId: req.params.id,
                createdAt: Date.now(),
            });

            return res.json({
                requiresApproval: true,
                approvalToken,
                command,
                cwd: workingDir,
                message: 'このコマンドを実行しますか？'
            });
        }

        // Execute command
        session.status = 'running';
        const result = await executeCommand(command, {
            cwd: workingDir,
            timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
        });

        session.status = 'idle';
        addHistoryEntry(session, {
            type: 'command',
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
router.post('/sessions/:id/approve', async (req, res, next) => {
    try {
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const { approvalToken, timeoutMs } = req.body;
        if (!approvalToken || !pendingCommands.has(approvalToken)) {
            return res.status(400).json({ error: 'Invalid or expired approval token' });
        }

        const pending = pendingCommands.get(approvalToken);
        pendingCommands.delete(approvalToken);

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

        const workingDir = pending.cwd;
        validatePath(workingDir);

        session.status = 'running';
        const result = await executeCommand(pending.command, {
            cwd: workingDir,
            timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
        });

        session.status = 'idle';
        addHistoryEntry(session, {
            type: 'command',
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
router.get('/sessions/:id/files', async (req, res, next) => {
    try {
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const filePath = req.query.path;
        if (!filePath) {
            return res.status(400).json({ error: 'path is required' });
        }

        const resolvedPath = validatePath(filePath);
        assertNotProtectedPath(resolvedPath);
        const content = await fs.readFile(resolvedPath, 'utf-8');

        res.json({
            path: resolvedPath,
            content,
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
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const { path: filePath, content } = req.body;
        if (!filePath) {
            return res.status(400).json({ error: 'path is required' });
        }
        if (content !== undefined && typeof content !== 'string') {
            return res.status(400).json({ error: 'content must be a string' });
        }

        const resolvedPath = validatePath(filePath);
        assertNotWriteProtectedPath(resolvedPath);
        const dir = path.dirname(resolvedPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(resolvedPath, content || '', 'utf-8');

        addHistoryEntry(session, {
            type: 'write',
            path: resolvedPath,
            timestamp: new Date().toISOString(),
        });

        res.json({
            ok: true,
            path: resolvedPath,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Search files within session context.
 */
router.get('/sessions/:id/search', async (req, res, next) => {
    try {
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const { query, dir, maxResults = 20 } = req.query;
        if (!query) {
            return res.status(400).json({ error: 'query is required' });
        }

        const searchDir = dir || session.cwd;
        validatePath(searchDir);

        // Simple recursive search (for production, use ripgrep or similar)
        const results = [];
        await searchInDirectory(searchDir, query, results, parseInt(maxResults));

        res.json({
            query,
            results,
        });
    } catch (err) {
        next(err);
    }
});

/**
 * Simple file content search.
 */
async function searchInDirectory(dir, query, results, maxResults, depth = 0) {
    if (results.length >= maxResults || depth > 5) return;

    try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (results.length >= maxResults) break;

            // Skip common directories
            if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.venv') {
                continue;
            }

            const fullPath = path.join(dir, entry.name);

            try {
                validatePath(fullPath);
            } catch {
                continue; // Skip paths outside allowed directories
            }

            if (entry.isDirectory()) {
                await searchInDirectory(fullPath, query, results, maxResults, depth + 1);
            } else if (entry.isFile()) {
                try {
                    const content = await fs.readFile(fullPath, 'utf-8');
                    const lines = content.split('\n');

                    for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                            results.push({
                                file: fullPath,
                                line: i + 1,
                                content: lines[i].trim(),
                            });
                            if (results.length >= maxResults) break;
                        }
                    }
                } catch {
                    // Skip binary files
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
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const dirPath = req.query.path || session.cwd;
        const resolvedPath = validatePath(dirPath);
        assertNotProtectedPath(resolvedPath);

        const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
        const items = entries
            .filter(entry => entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== '.venv')
            .map(entry => ({
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
        const session = sessions.get(req.params.id);
        if (!session) {
            return res.status(404).json({ error: 'Session not found' });
        }

        const { path: filePath, diff } = req.body;
        if (!filePath) {
            return res.status(400).json({ error: 'path is required' });
        }
        if (diff === undefined) {
            return res.status(400).json({ error: 'diff is required' });
        }

        const resolvedPath = validatePath(filePath);
        assertNotWriteProtectedPath(resolvedPath);

        const content = await fs.readFile(resolvedPath, 'utf-8');

        // Parse SEARCH/REPLACE blocks
        const blockRegex = /<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE/g;
        const blocks = [];
        let match;
        while ((match = blockRegex.exec(diff)) !== null) {
            blocks.push({
                search: match[1],
                replace: match[2]
            });
        }

        if (blocks.length === 0) {
            return res.status(400).json({
                error: '有効な SEARCH/REPLACE ブロックが見つかりませんでした。フォーマット（<<<<<<< SEARCH、=======、>>>>>>> REPLACE）を確認してください。'
            });
        }

        let newContent = content;

        for (const block of blocks) {
            // Normalize CRLF to LF for robust search
            const searchNorm = block.search.replace(/\r\n/g, '\n');
            const replaceNorm = block.replace.replace(/\r\n/g, '\n');
            const currentNormContent = newContent.replace(/\r\n/g, '\n');

            const index = currentNormContent.indexOf(searchNorm);
            if (index === -1) {
                return res.status(400).json({
                    error: `置換対象の SEARCH ブロックのコードが見つかりません。インデントや改行が既存ファイルの内容と完全に一致している必要があります：\n${block.search}`
                });
            }

            if (currentNormContent.indexOf(searchNorm, index + 1) !== -1) {
                return res.status(400).json({
                    error: `置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません。前後の行も含めて指定してください：\n${block.search}`
                });
            }

            newContent = currentNormContent.replace(searchNorm, replaceNorm);
        }

        await fs.writeFile(resolvedPath, newContent, 'utf-8');

        addHistoryEntry(session, {
            type: 'diff',
            path: resolvedPath,
            timestamp: new Date().toISOString(),
        });

        res.json({
            ok: true,
            path: resolvedPath,
            message: `${blocks.length}個のブロックの置換に成功しました。`
        });
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
        allowedRoots: getAllowedRoots(),
    });
});

export default router;
