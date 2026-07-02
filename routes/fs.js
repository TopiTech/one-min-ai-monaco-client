import express from 'express';
import fs from 'fs/promises';
import { spawn, exec, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { z } from 'zod';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
import {
  validatePath,
  revalidateRealPath,
  PROJECT_ROOT,
  getAllowedRoots,
  getDefaultRoot,
  assertNotProtectedPath,
  assertNotWriteProtectedPath,
  isProtectedPathForListing,
} from '../utils/fs-guard.js';
import { serverConfig } from '../config/server.js';
import { detectBinaryContent } from '../utils/mime-guard.js';

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LIST_ENTRIES = 5000;
// L-9: Use the server-configured JSON body limit as the upper bound on
// editable file size so ops can tune it without code changes.
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.mp4',
  '.exe',
  '.dll',
  '.bin',
  '.db',
]);

const router = express.Router();

const workspaceSelectSchema = z.object({ dir: z.string().min(1, 'dir is required') });
const listSchema = z.object({ dir: z.string().optional() });
const readSchema = z
  .object({
    path: z.string().min(1, 'path is required'),
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
const writeSchema = z.object({
  path: z.string().min(1, 'path is required'),
  content: z.string({ required_error: 'content is required' }),
});
const createSchema = z.object({
  path: z.string().min(1, 'path is required'),
  type: z.enum(['file', 'directory']).default('file'),
  content: z.string().default(''),
});
const deleteSchema = z.object({ path: z.string().min(1, 'path is required') });
const renameSchema = z.object({
  oldPath: z.string().min(1, 'oldPath is required'),
  newPath: z.string().min(1, 'newPath is required'),
});

/**
 * Internal helper to safely resolve the real path of an existing target
 * to mitigate TOCTOU (Time-of-Check to Time-of-Use) attacks.
 */
async function getSafeRealPath(resolvedPath) {
  let realPath = resolvedPath;
  try {
    const stat = await fs.lstat(resolvedPath);
    if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
      realPath = revalidateRealPath(resolvedPath);
      assertNotWriteProtectedPath(realPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return realPath;
}

/**
 * Get allowed roots from environment and resolve them.
 */
router.get('/config', (_req, res) => {
  const allowedRoots = getAllowedRoots();
  const defaultRoot = getDefaultRoot();
  res.json({
    root: PROJECT_ROOT,
    defaultRoot,
    allowedRoots,
    enableCommandExecution: String(process.env.ENABLE_COMMAND_EXECUTION || 'false').toLowerCase() === 'true',
  });
});

/**
 * Get list of allowed root directories.
 */
router.get('/roots', (_req, res) => {
  const allowedRoots = getAllowedRoots();
  res.json({ roots: allowedRoots });
});

/**
 * Get available drives on Windows.
 */
let cachedDrives = null;
let lastDrivesLookupTime = 0;
const DRIVES_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

router.get('/drives', async (_req, res) => {
  const now = Date.now();
  if (cachedDrives && now - lastDrivesLookupTime < DRIVES_CACHE_TTL_MS) {
    return res.json({ drives: cachedDrives });
  }

  const drives = [];

  if (process.platform === 'win32') {
    let success = false;

    // 1. Try using PowerShell to get Ready drives quickly and without blocking I/O threads
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          '[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | Select-Object -ExpandProperty Name',
        ],
        { timeout: 5000 },
      );

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length > 0) {
        for (const drive of lines) {
          const driveLetter = drive.slice(0, 2).toUpperCase();
          drives.push({
            name: driveLetter,
            path: driveLetter + '\\',
            type: 'local',
          });
        }
        success = true;
      }
    } catch {
      // PowerShell failed or timed out, fall through
    }

    // 2. Fallback: Try using fsutil safely with execFile (not exec)
    if (!success) {
      try {
        const { stdout } = await execFileAsync('fsutil', ['fsinfo', 'drives']);
        const matches = stdout.match(/[A-Za-z]:\\/g);
        if (matches && matches.length > 0) {
          // As a fallback we do NOT check drive readiness via fs.access to prevent thread pool starvation.
          for (const drive of matches) {
            const driveLetter = drive.slice(0, 2).toUpperCase();
            drives.push({
              name: driveLetter,
              path: driveLetter + '\\',
              type: 'local',
            });
          }
          success = true;
        }
      } catch {
        // fsutil failed, fall through
      }
    }

    // Sort drives alphabetically
    drives.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // Unix-like: return root and home
    drives.push({ name: '/', path: '/', type: 'root' });
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      drives.push({ name: 'Home', path: homeDir, type: 'home' });
    }
  }

  cachedDrives = drives;
  lastDrivesLookupTime = now;

  res.json({ drives });
});

/**
 * Select a workspace directory.
 * Validates that the directory exists and is within allowed roots.
 */
router.post('/workspace/select', async (req, res, next) => {
  try {
    const result = workspaceSelectSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { dir } = result.data;

    const resolvedDir = validatePath(dir);
    if (isProtectedPathForListing(resolvedDir)) {
      const relativePath = path.relative(PROJECT_ROOT, resolvedDir).replace(/\\/g, '/');
      return res.status(403).json({ error: `Access denied: Cannot select protected path: ${relativePath}` });
    }

    const stat = await fs.stat(resolvedDir);

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is not a directory' });
    }

    res.json({
      ok: true,
      dir: resolvedDir,
      isDirectory: true,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * List directory contents.
 */
router.get('/list', async (req, res, next) => {
  try {
    const result = listSchema.safeParse(req.query);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const dirPath = result.data.dir ? validatePath(String(result.data.dir)) : getDefaultRoot();
    if (isProtectedPathForListing(dirPath)) {
      return res.status(403).json({ error: 'Access denied: Path is protected' });
    }
    const dir = await fs.opendir(dirPath);

    const items = [];
    let entry;
    let truncated = false;

    try {
      while ((entry = await dir.read()) !== null) {
        const fullPath = path.join(dirPath, entry.name);
        if (isProtectedPathForListing(fullPath)) {
          continue;
        }
        items.push({
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
        });
        if (items.length >= MAX_LIST_ENTRIES) {
          // Peek at the next entry to determine if truncation occurred.
          // We intentionally discard this entry — the contract is that
          // `truncated: true` signals the client to refine the query rather
          // than to page through all entries.
          const peeked = await dir.read();
          if (peeked !== null) {
            truncated = true;
          }
          break;
        }
      }
    } finally {
      await dir.close();
    }

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ dir: dirPath, items, truncated });
  } catch (err) {
    next(err);
  }
});

/**
 * Read file contents.
 */
router.get('/read', async (req, res, next) => {
  try {
    const result = readSchema.safeParse(req.query);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { path: filePath, startLine, endLine } = result.data;
    const resolvedPath = validatePath(String(filePath));
    assertNotProtectedPath(resolvedPath);

    // Hardened path validation: follow symlinks and re-verify boundaries to prevent TOCTOU
    const realPath = revalidateRealPath(resolvedPath);
    assertNotProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is a directory' });
    }
    if (stat.size > MAX_READ_SIZE) {
      return res.status(413).json({
        error: `File size (${stat.size} bytes) exceeds maximum read size (${MAX_READ_SIZE} bytes)`,
      });
    }

    const ext = path.extname(realPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: 'Cannot read binary files as text in the editor.' });
    }

    // M-9: Even when the extension is text-like, perform a content-based
    // binary check. Files renamed (e.g. exe.txt) should still be refused
    // from the text editor to avoid corrupting the Monaco buffer.
    // Optimization: Only load the first 8KB to check binary status to avoid OOM
    // on large binaries before reject.
    const fd = await fs.open(realPath, 'r');
    let isBinary = false;
    try {
      const headBuf = Buffer.alloc(8192);
      const { bytesRead } = await fd.read(headBuf, 0, 8192, 0);
      if (detectBinaryContent(headBuf.subarray(0, bytesRead))) {
        isBinary = true;
      }
    } finally {
      await fd.close();
    }

    if (isBinary) {
      return res.status(400).json({ error: 'Cannot read binary files as text in the editor.' });
    }

    const buffer = await fs.readFile(realPath);
    let content = buffer.toString('utf-8');
    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split(/\r?\n/);
      const start = startLine !== undefined ? startLine - 1 : 0;
      const end = endLine !== undefined ? endLine : lines.length;
      content = lines.slice(start, end).join('\n');
    }
    res.json({ path: realPath, content });
  } catch (err) {
    next(err);
  }
});

/**
 * Write file contents.
 */
router.post('/write', async (req, res, next) => {
  try {
    const result = writeSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { path: filePath, content } = result.data;

    const resolvedPath = validatePath(String(filePath));
    assertNotWriteProtectedPath(resolvedPath);

    // TOCTOU mitigation
    const realPath = await getSafeRealPath(resolvedPath);

    const dir = path.dirname(realPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(realPath, content, 'utf-8');
    res.json({ ok: true, path: realPath });
  } catch (err) {
    next(err);
  }
});

/**
 * Create a new file or directory.
 */
router.post('/create', async (req, res, next) => {
  try {
    const result = createSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { path: targetPath, type, content } = result.data;

    const resolvedPath = validatePath(String(targetPath));
    assertNotWriteProtectedPath(resolvedPath);

    // TOCTOU mitigation
    const realPath = await getSafeRealPath(resolvedPath);

    if (type === 'directory') {
      await fs.mkdir(realPath, { recursive: true });
    } else {
      const dir = path.dirname(realPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(realPath, content, 'utf-8');
    }

    res.json({ ok: true, path: realPath, type });
  } catch (err) {
    next(err);
  }
});

/**
 * Recursively check that no protected paths exist within a directory.
 * This prevents accidentally deleting protected files when a parent
 * directory is removed with recursive: true.
 */
async function assertNoProtectedChildren(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    assertNotWriteProtectedPath(fullPath);
    if (entry.isDirectory()) {
      await assertNoProtectedChildren(fullPath);
    }
  }
}

/**
 * Delete a file or directory.
 */
router.post('/delete', async (req, res, next) => {
  try {
    const result = deleteSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { path: targetPath } = result.data;

    const resolvedPath = validatePath(String(targetPath));
    assertNotWriteProtectedPath(resolvedPath);

    // Target must exist to be deleted, resolve symlinks
    const realPath = revalidateRealPath(resolvedPath);
    assertNotWriteProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      // Recursively verify no protected paths exist within before deleting
      await assertNoProtectedChildren(realPath);
      await fs.rm(realPath, { recursive: true });
    } else {
      await fs.unlink(realPath);
    }

    res.json({ ok: true, path: realPath });
  } catch (err) {
    next(err);
  }
});

/**
 * Rename/move a file or directory.
 */
router.post('/rename', async (req, res, next) => {
  try {
    const result = renameSchema.safeParse(req.body);
    if (!result.success)
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Validation error' });
    const { oldPath, newPath } = result.data;

    const resolvedOld = validatePath(String(oldPath));
    const resolvedNew = validatePath(String(newPath));
    assertNotWriteProtectedPath(resolvedOld);
    assertNotWriteProtectedPath(resolvedNew);

    // Old path must exist, resolve symlinks
    const realOld = revalidateRealPath(resolvedOld);
    assertNotWriteProtectedPath(realOld);

    // New path may or may not exist (TOCTOU mitigation)
    const realNew = await getSafeRealPath(resolvedNew);

    await fs.rename(realOld, realNew);
    res.json({ ok: true, oldPath: realOld, newPath: realNew });
  } catch (err) {
    next(err);
  }
});

export default router;
