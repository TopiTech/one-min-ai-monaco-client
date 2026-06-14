import express from 'express';
import fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { validatePath, PROJECT_ROOT, getAllowedRoots, getDefaultRoot, assertNotProtectedPath } from '../utils/fs-guard.js';

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LIST_ENTRIES = 5000;

const router = express.Router();
const execAsync = promisify(exec);

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
router.get('/drives', async (_req, res) => {
  const drives = [];

  if (process.platform === 'win32') {
    try {
      // Use wmic to get logical drives
      const { stdout } = await execAsync('wmic logicaldisk get name 2>nul', { timeout: 5000 });
      const lines = stdout.split('\n').map(l => l.trim()).filter(l => l && l !== 'Name');
      for (const line of lines) {
        const driveLetter = line.replace(':', '').trim();
        if (driveLetter) {
          drives.push({
            name: driveLetter + ':',
            path: driveLetter + ':\\',
            type: 'local'
          });
        }
      }
    } catch {
      // Fallback: check common drive letters
      const commonDrives = ['C:', 'D:', 'E:', 'F:', 'G:'];
      for (const drive of commonDrives) {
        try {
          await fs.access(drive + '\\');
          drives.push({
            name: drive,
            path: drive + '\\',
            type: 'local'
          });
        } catch {
          // Drive not accessible
        }
      }
    }
  } else {
    // Unix-like: return root and home
    drives.push({ name: '/', path: '/', type: 'root' });
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      drives.push({ name: 'Home', path: homeDir, type: 'home' });
    }
  }

  res.json({ drives });
});

/**
 * Select a workspace directory.
 * Validates that the directory exists and is within allowed roots.
 */
router.post('/workspace/select', async (req, res, next) => {
  try {
    const { dir } = req.body;
    if (!dir) {
      return res.status(400).json({ error: 'dir is required' });
    }

    const resolvedDir = validatePath(dir);
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
    const dir = req.query.dir ? validatePath(String(req.query.dir)) : getDefaultRoot();
    const entries = await fs.readdir(dir, { withFileTypes: true });

    const items = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory()
      });
      if (items.length >= MAX_LIST_ENTRIES) break;
    }

    items.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ dir, items, truncated: entries.length > MAX_LIST_ENTRIES + 5 });
  } catch (err) {
    next(err);
  }
});

/**
 * Read file contents.
 */
router.get('/read', async (req, res, next) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    const resolvedPath = validatePath(String(filePath));

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: 'Specified path is a directory' });
    }
    if (stat.size > MAX_READ_SIZE) {
      return res.status(413).json({ error: `File size (${stat.size} bytes) exceeds maximum read size (${MAX_READ_SIZE} bytes)` });
    }

    const content = await fs.readFile(resolvedPath, 'utf-8');
    res.json({ path: resolvedPath, content });
  } catch (err) {
    next(err);
  }
});

/**
 * Write file contents.
 */
router.post('/write', async (req, res, next) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: 'path is required' });
    if (content === undefined) return res.status(400).json({ error: 'content is required' });

    const resolvedPath = validatePath(String(filePath));
    assertNotProtectedPath(resolvedPath);

    const dir = path.dirname(resolvedPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(resolvedPath, content, 'utf-8');
    res.json({ ok: true, path: resolvedPath });
  } catch (err) {
    next(err);
  }
});

/**
 * Create a new file or directory.
 */
router.post('/create', async (req, res, next) => {
  try {
    const { path: targetPath, type = 'file', content = '' } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path is required' });

    const resolvedPath = validatePath(String(targetPath));
    assertNotProtectedPath(resolvedPath);

    if (type === 'directory') {
      await fs.mkdir(resolvedPath, { recursive: true });
    } else {
      const dir = path.dirname(resolvedPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(resolvedPath, content, 'utf-8');
    }

    res.json({ ok: true, path: resolvedPath, type });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete a file or directory.
 */
router.post('/delete', async (req, res, next) => {
  try {
    const { path: targetPath } = req.body;
    if (!targetPath) return res.status(400).json({ error: 'path is required' });

    const resolvedPath = validatePath(String(targetPath));
    assertNotProtectedPath(resolvedPath);

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      await fs.rm(resolvedPath, { recursive: true, force: true });
    } else {
      await fs.unlink(resolvedPath);
    }

    res.json({ ok: true, path: resolvedPath });
  } catch (err) {
    next(err);
  }
});

/**
 * Rename/move a file or directory.
 */
router.post('/rename', async (req, res, next) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'oldPath and newPath are required' });
    }

    const resolvedOld = validatePath(String(oldPath));
    const resolvedNew = validatePath(String(newPath));
    assertNotProtectedPath(resolvedOld);
    assertNotProtectedPath(resolvedNew);

    await fs.rename(resolvedOld, resolvedNew);
    res.json({ ok: true, oldPath: resolvedOld, newPath: resolvedNew });
  } catch (err) {
    next(err);
  }
});

export default router;
