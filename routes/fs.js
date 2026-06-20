import express from "express";
import fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import {
  validatePath,
  revalidateRealPath,
  PROJECT_ROOT,
  getAllowedRoots,
  getDefaultRoot,
  assertNotProtectedPath,
  assertNotWriteProtectedPath,
  isProtectedPathForListing,
} from "../utils/fs-guard.js";
import { serverConfig } from "../config/server.js";
import { detectBinaryContent } from "../utils/mime-guard.js";

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LIST_ENTRIES = 5000;
// L-9: Use the server-configured JSON body limit as the upper bound on
// editable file size so ops can tune it without code changes.
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".mp4",
  ".exe",
  ".dll",
  ".bin",
  ".db",
]);

const router = express.Router();
const execAsync = promisify(exec);

/**
 * Internal helper to safely resolve the real path of an existing target 
 * to mitigate TOCTOU (Time-of-Check to Time-of-Use) attacks.
 */
async function getSafeRealPath(resolvedPath) {
  let realPath = resolvedPath;
  try {
    const stat = await fs.stat(resolvedPath);
    if (stat.isFile() || stat.isDirectory()) {
      realPath = revalidateRealPath(resolvedPath);
      assertNotWriteProtectedPath(realPath);
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  return realPath;
}

/**
 * Get allowed roots from environment and resolve them.
 */
router.get("/config", (_req, res) => {
  const allowedRoots = getAllowedRoots();
  const defaultRoot = getDefaultRoot();
  res.json({
    root: PROJECT_ROOT,
    defaultRoot,
    allowedRoots,
    enableCommandExecution: String(process.env.ENABLE_COMMAND_EXECUTION || "false").toLowerCase() === "true",
  });
});

/**
 * Get list of allowed root directories.
 */
router.get("/roots", (_req, res) => {
  const allowedRoots = getAllowedRoots();
  res.json({ roots: allowedRoots });
});

/**
 * Get available drives on Windows.
 */
router.get("/drives", async (_req, res) => {
  const drives = [];

  if (process.platform === "win32") {
    let success = false;
    const allowShellLookup = serverConfig.enableDrivesShellLookup;
    // Method 1: PowerShell (Modern, reliable if not blocked). Independent
    // from ENABLE_COMMAND_EXECUTION — drive enumeration is read-only and not
    // an agent surface, so a separate env gate (defaulting on) is enough.
    if (allowShellLookup) {
      try {
        const { stdout } = await execAsync(
          'powershell -NoProfile -Command "[System.IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | Select-Object -ExpandProperty Name"',
          { timeout: 3000 },
        );
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l);
        for (const line of lines) {
          const driveRoot = line.endsWith("\\") ? line : line + "\\";
          drives.push({
            name: line.replace("\\", ""),
            path: driveRoot,
            type: "local",
          });
        }
        success = drives.length > 0;
      } catch {
        // Fallback to next method
      }
    }

    // Method 2: wmic (Legacy but often available)
    if (!success && allowShellLookup) {
      try {
        const { stdout } = await execAsync("wmic logicaldisk get name", { timeout: 3000 });
        const lines = stdout
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && l !== "Name");
        for (const line of lines) {
          drives.push({
            name: line,
            path: line + "\\",
            type: "local",
          });
        }
        success = drives.length > 0;
      } catch {
        // Fallback to manual check
      }
    }

    // Method 3: Fallback manual check of common drive letters (no shell)
    if (!success) {
      const commonDrives = ["C:", "D:", "E:", "F:", "G:", "H:", "I:", "Z:"];
      for (const drive of commonDrives) {
        try {
          await fs.access(drive + "\\");
          drives.push({
            name: drive,
            path: drive + "\\",
            type: "local",
          });
        } catch {
          // Drive not accessible
        }
      }
    }
  } else {
    // Unix-like: return root and home
    drives.push({ name: "/", path: "/", type: "root" });
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    if (homeDir) {
      drives.push({ name: "Home", path: homeDir, type: "home" });
    }
  }

  res.json({ drives });
});

/**
 * Select a workspace directory.
 * Validates that the directory exists and is within allowed roots.
 */
router.post("/workspace/select", async (req, res, next) => {
  try {
    const { dir } = req.body;
    if (!dir) {
      return res.status(400).json({ error: "dir is required" });
    }

    const resolvedDir = validatePath(dir);
    if (isProtectedPathForListing(resolvedDir)) {
      const relativePath = path.relative(PROJECT_ROOT, resolvedDir).replace(/\\/g, "/");
      return res.status(403).json({ error: `Access denied: Cannot select protected path: ${relativePath}` });
    }

    const stat = await fs.stat(resolvedDir);

    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Specified path is not a directory" });
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
router.get("/list", async (req, res, next) => {
  try {
    const dirPath = req.query.dir ? validatePath(String(req.query.dir)) : getDefaultRoot();
    if (isProtectedPathForListing(dirPath)) {
      return res.status(403).json({ error: "Access denied: Path is protected" });
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
          const nextEntry = await dir.read();
          if (nextEntry !== null) {
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
router.get("/read", async (req, res, next) => {
  try {
    const filePath = req.query.path;
    if (!filePath) return res.status(400).json({ error: "path is required" });
    const resolvedPath = validatePath(String(filePath));
    assertNotProtectedPath(resolvedPath);

    // Hardened path validation: follow symlinks and re-verify boundaries to prevent TOCTOU
    const realPath = revalidateRealPath(resolvedPath);
    assertNotProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      return res.status(400).json({ error: "Specified path is a directory" });
    }
    if (stat.size > MAX_READ_SIZE) {
      return res.status(413).json({
        error: `File size (${stat.size} bytes) exceeds maximum read size (${MAX_READ_SIZE} bytes)`,
      });
    }

    const ext = path.extname(realPath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) {
      return res.status(400).json({ error: "Cannot read binary files as text in the editor." });
    }

    // M-9: Even when the extension is text-like, perform a content-based
    // binary check. Files renamed (e.g. exe.txt) should still be refused
    // from the text editor to avoid corrupting the Monaco buffer.
    const buffer = await fs.readFile(realPath);
    if (detectBinaryContent(buffer)) {
      return res.status(400).json({ error: "Cannot read binary files as text in the editor." });
    }

    const content = buffer.toString("utf-8");
    res.json({ path: realPath, content });
  } catch (err) {
    next(err);
  }
});

/**
 * Write file contents.
 */
router.post("/write", async (req, res, next) => {
  try {
    const { path: filePath, content } = req.body;
    if (!filePath) return res.status(400).json({ error: "path is required" });
    if (content === undefined) return res.status(400).json({ error: "content is required" });

    const resolvedPath = validatePath(String(filePath));
    assertNotWriteProtectedPath(resolvedPath);

    // TOCTOU mitigation
    const realPath = await getSafeRealPath(resolvedPath);

    const dir = path.dirname(realPath);
    await fs.mkdir(dir, { recursive: true });

    await fs.writeFile(realPath, content, "utf-8");
    res.json({ ok: true, path: realPath });
  } catch (err) {
    next(err);
  }
});

/**
 * Create a new file or directory.
 */
router.post("/create", async (req, res, next) => {
  try {
    const { path: targetPath, type = "file", content = "" } = req.body;
    if (!targetPath) return res.status(400).json({ error: "path is required" });

    const resolvedPath = validatePath(String(targetPath));
    assertNotWriteProtectedPath(resolvedPath);

    // TOCTOU mitigation
    const realPath = await getSafeRealPath(resolvedPath);

    if (type === "directory") {
      await fs.mkdir(realPath, { recursive: true });
    } else {
      const dir = path.dirname(realPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(realPath, content, "utf-8");
    }

    res.json({ ok: true, path: realPath, type });
  } catch (err) {
    next(err);
  }
});

/**
 * Delete a file or directory.
 */
router.post("/delete", async (req, res, next) => {
  try {
    const { path: targetPath } = req.body;
    if (!targetPath) return res.status(400).json({ error: "path is required" });

    const resolvedPath = validatePath(String(targetPath));
    assertNotWriteProtectedPath(resolvedPath);

    // Target must exist to be deleted, resolve symlinks
    const realPath = revalidateRealPath(resolvedPath);
    assertNotWriteProtectedPath(realPath);

    const stat = await fs.stat(realPath);
    if (stat.isDirectory()) {
      await fs.rm(realPath, { recursive: true, force: true });
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
router.post("/rename", async (req, res, next) => {
  try {
    const { oldPath, newPath } = req.body;
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: "oldPath and newPath are required" });
    }

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
