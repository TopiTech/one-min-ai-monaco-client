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
  ".gitignore",
  ".env.example",
];

const WRITE_PROTECTED_PATH_PREFIXES = [
  ...PROTECTED_PATH_PREFIXES,
  "server.js",
  "utils/",
  "routes/",
  "config/",
  "public/",
  "tests/",
  "docs/",
  "README.md",
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
 * Otherwise, PROJECT_ROOT is allowed.
 */
export function getAllowedRoots() {
  const raw = (process.env.ALLOWED_ROOTS || "").trim();
  if (!raw) {
    return getDefaultAllowedRoots();
  }
  const roots = raw
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((r) => path.resolve(r));
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

  // Prevent null byte injection and other common attack patterns
  if (targetPath.includes("\0")) {
    const err = new Error("Access denied: Invalid path (null byte detected)");
    err.status = 403;
    throw err;
  }

  const isAbsolute = path.isAbsolute(targetPath);
  const resolvedPath = isAbsolute
    ? path.resolve(targetPath)
    : path.resolve(PROJECT_ROOT, targetPath);
  const allowedRoots = getAllowedRoots();

  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch {
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

function isProtectedByPrefixes(relativePath, prefixes) {
  const normalizedRelativePath = normalizePathForMatching(relativePath);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizePathForMatching(prefix).replace(/\/$/, "");
    return (
      normalizedRelativePath === normalizedPrefix ||
      normalizedRelativePath.startsWith(`${normalizedPrefix}/`)
    );
  });
}

function isPathProtectedByRoot(resolvedPath, root, prefixes) {
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

  return isProtectedByPrefixes(relativePath, prefixes);
}

/**
 * Checks whether a validated path is protected from all filesystem operations.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected.
 */
export function isProtectedPath(resolvedPath) {
  return getAllowedRoots().some((root) =>
    isPathProtectedByRoot(resolvedPath, root, PROTECTED_PATH_PREFIXES),
  );
}

/**
 * Checks whether a validated path is protected from destructive filesystem operations.
 * Write/create/delete/rename operations use this stricter policy.
 * This also protects allowed roots themselves.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected from destructive operations.
 */
export function isWriteProtectedPath(resolvedPath) {
  if (getAllowedRoots().some((root) => {
    try {
      return fs.realpathSync(root) === resolvedPath;
    } catch {
      return path.resolve(root) === resolvedPath;
    }
  })) {
    return true;
  }
  return getAllowedRoots().some((root) =>
    isPathProtectedByRoot(resolvedPath, root, WRITE_PROTECTED_PATH_PREFIXES),
  );
}

/**
 * Checks whether a validated path is protected from listing operations.
 * Allowed roots themselves are listable; protected prefixes inside them are not.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected from listing.
 */
export function isProtectedPathForListing(resolvedPath) {
  return isProtectedPath(resolvedPath);
}

/**
 * Ensures a validated path is not protected from all filesystem operations.
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
 * Ensures a validated path is not protected from destructive filesystem operations.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @throws {Error} If the path is protected from write/create/delete/rename operations.
 */
export function assertNotWriteProtectedPath(resolvedPath) {
  if (isWriteProtectedPath(resolvedPath)) {
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath).replace(/\\/g, "/");
    const err = new Error(
      `Access denied: Path is protected from write operations: ${relativePath}`,
    );
    err.status = 403;
    throw err;
  }
}

/**
 * Returns the default workspace root.
 */
export function getDefaultRoot() {
  const raw = (process.env.ALLOWED_ROOTS || "").trim();
  if (!raw) {
    return PROJECT_ROOT;
  }

  const roots = getAllowedRoots();
  const customRoots = roots.filter((r) => r !== PROJECT_ROOT);
  return customRoots.length > 0 ? customRoots[0] : PROJECT_ROOT;
}

export { PROJECT_ROOT };
