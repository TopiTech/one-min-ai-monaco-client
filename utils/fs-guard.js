import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const PROTECTED_PATH_PREFIXES = [
  ".env",
  ".env.",
  ".git",
  ".git/",
  ".venv",
  ".venv/",
  "node_modules",
  "node_modules/",
  "package.json",
  "package-lock.json",
  "server.js",
  "utils/",
  "routes/",
  "config/",
  "public/",
  "tests/",
  "docs/",
  "README.md",
  ".gitignore",
  ".env.example",
];

function uniquePaths(paths) {
  return [...new Set(paths.map((p) => path.resolve(p)).filter(Boolean))];
}

function getDefaultAllowedRoots() {
  return uniquePaths([PROJECT_ROOT]);
}

/**
 * Returns the list of allowed root directories.
 * If ALLOWED_ROOTS env var is set, it is split by comma and resolved.
 * Otherwise, PROJECT_ROOT, its parent directory, and the user home directory are allowed.
 */
export function getAllowedRoots() {
  const raw = (process.env.ALLOWED_ROOTS || "").trim();
  if (!raw) {
    return getDefaultAllowedRoots();
  }
  const roots = raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "")) // Remove quotes if present
    .filter(Boolean)
    .map((r) => path.resolve(r));
  // Always include PROJECT_ROOT as a fallback
  if (!roots.includes(PROJECT_ROOT)) {
    roots.unshift(PROJECT_ROOT);
  }
  return roots;
}

/**
 * Validates that the provided path is within one of the allowed roots.
 * @param {string} targetPath The path to validate.
 * @returns {string} The resolved absolute path if valid.
 * @throws {Error} If the path is outside all allowed roots.
 */
export function validatePath(targetPath) {
  if (!targetPath) {
    throw new Error("Path is required");
  }

  // Resolve relative paths against PROJECT_ROOT (not process.cwd())
  // This ensures consistent behavior regardless of where the server is started from
  const isAbsolute = path.isAbsolute(targetPath);
  const resolvedPath = isAbsolute
    ? path.resolve(targetPath)
    : path.resolve(PROJECT_ROOT, targetPath);
  const allowedRoots = getAllowedRoots();

  // Resolve symlinks for both target and allowed roots to prevent traversal
  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    // File doesn't exist yet, walk up to find the first existing ancestor and resolve that
    let current = resolvedPath;
    let existingAncestor = null;
    while (current !== path.dirname(current)) {
      try {
        existingAncestor = fs.realpathSync(current);
        break;
      } catch {
        current = path.dirname(current);
      }
    }
    // Reconstruct the path from the resolved ancestor + remaining relative parts
    if (existingAncestor) {
      const remaining = resolvedPath.substring(current.length);
      realPath = path.join(existingAncestor, remaining);
    } else {
      realPath = resolvedPath;
    }
  }

  const realRoots = allowedRoots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });

  const isAllowed = realRoots.some(
    (root) => realPath === root || realPath.startsWith(root + path.sep),
  );

  if (!isAllowed) {
    const err = new Error("Access denied: Path is outside the allowed directories");
    err.status = 403;
    throw err;
  }

  return realPath;
}

function normalizePathForMatching(targetPath) {
  return targetPath.replace(/\\/g, "/").toLowerCase();
}

/**
 * Checks whether a validated path is protected from destructive filesystem operations.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected.
 */
export function isProtectedPath(resolvedPath) {
  const allowedRoots = getAllowedRoots();

  return allowedRoots.some((root) => {
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
    } catch {
      realRoot = root;
    }

    const isSubPath = resolvedPath === realRoot || resolvedPath.startsWith(realRoot + path.sep);
    if (!isSubPath) {
      return false;
    }

    const relativePath = path.relative(realRoot, resolvedPath);
    if (!relativePath) {
      return false;
    }

    const normalizedRelativePath = normalizePathForMatching(relativePath);
    return PROTECTED_PATH_PREFIXES.some((prefix) => {
      const normalizedPrefix = normalizePathForMatching(prefix).replace(/\/$/, "");
      return (
        normalizedRelativePath === normalizedPrefix ||
        normalizedRelativePath.startsWith(`${normalizedPrefix}/`)
      );
    });
  });
}

/**
 * Ensures a validated path is not protected from destructive filesystem operations.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @throws {Error} If the path is protected.
 */
export function assertNotProtectedPath(resolvedPath) {
  if (isProtectedPath(resolvedPath)) {
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath).replace(/\\/g, "/");
    const err = new Error(`Access denied: Path is protected: ${relativePath}`);
    err.status = 403;
    throw err;
  }
}

/**
 * Returns the default workspace root.
 * If ALLOWED_ROOTS is set, returns the first custom root.
 * Otherwise, returns PROJECT_ROOT.
 */
export function getDefaultRoot() {
  const raw = (process.env.ALLOWED_ROOTS || "").trim();
  if (!raw) {
    return PROJECT_ROOT;
  }

  const roots = getAllowedRoots();
  // If user set custom roots, prefer the first non-project-root if available
  const customRoots = roots.filter((r) => r !== PROJECT_ROOT);
  return customRoots.length > 0 ? customRoots[0] : PROJECT_ROOT;
}

export { PROJECT_ROOT };
