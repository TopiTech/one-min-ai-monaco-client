import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// B-3: Replace the brittle prefix list with explicit glob patterns. The
// previous implementation matched `.env` as a prefix and so protected any
// file starting with that string (e.g. `.envproduction`), but missed other
// secrets files like `.npmrc` and `secrets.json`. Glob patterns let us
// express both "exact match" and "any file/folder below this directory"
// uniformly.
const PROTECTED_PATH_GLOBS = [
  '.env',
  '.env.*',
  '.git',
  '.git/**',
  '.venv',
  '.venv/**',
  'node_modules',
  'node_modules/**',
  '.mimocode',
  '.mimocode/**',
  '.commandcode',
  '.commandcode/**',
  'package.json',
  'package-lock.json',
  '.gitignore',
  '.env.example',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_rsa.pub',
  '.npmrc',
  'secrets.json',
  'credentials.json',
];

const WRITE_PROTECTED_PATH_GLOBS = [
  ...PROTECTED_PATH_GLOBS,
  'server.js',
  'scripts/**',
  'utils/**',
  'routes/**',
  'config/**',
  'public/**',
  'tests/**',
  'docs/**',
  'README.md',
];

/**
 * Convert a simple glob (`*`, `**`, `?`) to a RegExp anchored at the start
 * and end. The `**` segment matches any number of path segments including
 * `/`, while `*` matches any path segment WITHOUT `/`.
 *
 * @param {string} glob  glob pattern using `*`, `**`, and `?`
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    return /^$/;
  }

  // Guard against extremely long patterns to prevent ReDoS on compilation
  if (glob.length > 256) {
    throw new Error('Glob pattern is too long');
  }

  // Normalize excessive stars (e.g. *** -> **)
  const normalizedGlob = glob.replace(/\*{3,}/g, '**');

  let regex = '';
  for (let i = 0; i < normalizedGlob.length; i++) {
    const c = normalizedGlob[i];
    if (c === '*') {
      if (normalizedGlob[i + 1] === '*') {
        regex += '.*';
        i++; // skip the second *
        // Consume an optional trailing `/` so `**/` matches zero or more
        // directory levels.
        if (normalizedGlob[i + 1] === '/') i++;
      } else {
        regex += '[^/]*';
      }
    } else if (c === '?') {
      regex += '[^/]';
    } else if (/[.+^$(){}|[\]\\]/.test(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  return new RegExp('^' + regex + '$', 'i');
}

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
  const raw = (process.env.ALLOWED_ROOTS || '').trim();
  if (!raw) {
    return getDefaultAllowedRoots();
  }
  const roots = raw
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
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
// Windows reserved device names that must not be used as file/directory
// components.  Accessing e.g. "CON", "NUL", "AUX" on Windows can redirect
// to system devices (stdin/stdout/etc.) or cause unpredictable behaviour.
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function hasWindowsReservedName(targetPath) {
  if (process.platform !== 'win32') return false;
  const parts = targetPath.split(/[\\/]/);
  for (const part of parts) {
    // Strip extension (e.g. "CON.txt" → "CON")
    const base = part.replace(/\.[^.]+$/, '').toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(base)) return true;
  }
  return false;
}

export function validatePath(targetPath) {
  if (!targetPath) {
    throw new Error('Path is required');
  }

  // Prevent null byte injection and other common attack patterns
  if (targetPath.includes('\0')) {
    const err = new Error('Access denied: Invalid path (null byte detected)');
    err.status = 403;
    throw err;
  }

  // Block Windows reserved device names (CON, NUL, AUX, etc.) to prevent
  // redirection to system devices or OS-level errors.
  if (hasWindowsReservedName(targetPath)) {
    const err = new Error('Access denied: Path contains a Windows reserved device name');
    err.status = 403;
    throw err;
  }

  const isAbsolute = path.isAbsolute(targetPath);
  const resolvedPath = isAbsolute ? path.resolve(targetPath) : path.resolve(PROJECT_ROOT, targetPath);
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

  // Case-insensitive comparison for Windows drive letters (c: vs C:)
  const normalizedRealPath = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
  const isAllowed = realRoots.some((root) => {
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    return normalizedRealPath === normalizedRoot || normalizedRealPath.startsWith(normalizedRoot + path.sep);
  });

  if (!isAllowed) {
    const err = new Error('Access denied: Path is outside the allowed directories');
    err.status = 403;
    throw err;
  }

  return realPath;
}

function normalizePathForMatching(targetPath) {
  return targetPath.replace(/\\/g, '/').toLowerCase();
}

// B-3: Compile glob patterns to RegExp once at module load so the matcher
// is O(patterns * segments) instead of recompiling on every file check.
const PROTECTED_PATTERNS = PROTECTED_PATH_GLOBS.map(globToRegExp);
const WRITE_PROTECTED_PATTERNS = WRITE_PROTECTED_PATH_GLOBS.map(globToRegExp);

function isProtectedByPatterns(relativePath, patterns) {
  const normalized = normalizePathForMatching(relativePath);
  return patterns.some((re) => re.test(normalized));
}

function isPathProtectedByRoot(resolvedPath, root, patterns) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }

  const normalizedResolvedPath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  const normalizedRealRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
  const isSubPath =
    normalizedResolvedPath === normalizedRealRoot ||
    normalizedResolvedPath.startsWith(normalizedRealRoot + path.sep);
  if (!isSubPath) {
    return false;
  }

  const relativePath = path.relative(realRoot, resolvedPath);
  if (!relativePath) {
    return false;
  }

  return isProtectedByPatterns(relativePath, patterns);
}

/**
 * Checks whether a validated path is protected from all filesystem operations.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected.
 */
export function isProtectedPath(resolvedPath) {
  return getAllowedRoots().some((root) => isPathProtectedByRoot(resolvedPath, root, PROTECTED_PATTERNS));
}

/**
 * Checks whether a validated path is protected from destructive filesystem operations.
 * Write/create/delete/rename operations use this stricter policy.
 * This also protects allowed roots themselves.
 * @param {string} resolvedPath The resolved absolute path to check.
 * @returns {boolean} True if the path is protected from destructive operations.
 */
export function isWriteProtectedPath(resolvedPath) {
  const normalizedResolvedPath = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
  if (
    getAllowedRoots().some((root) => {
      try {
        const realRoot = fs.realpathSync(root);
        const normalizedRealRoot = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
        return normalizedRealRoot === normalizedResolvedPath;
      } catch {
        const resolvedRoot = path.resolve(root);
        const normalizedResolvedRoot =
          process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
        return normalizedResolvedRoot === normalizedResolvedPath;
      }
    })
  ) {
    return true;
  }
  return getAllowedRoots().some((root) =>
    isPathProtectedByRoot(resolvedPath, root, WRITE_PROTECTED_PATTERNS),
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
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath).replace(/\\/g, '/');
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
    const relativePath = path.relative(PROJECT_ROOT, resolvedPath).replace(/\\/g, '/');
    const err = new Error(`Access denied: Path is protected from write operations: ${relativePath}`);
    err.status = 403;
    throw err;
  }
}

/**
 * Re-validates an existing real path by following symlinks at the time
 * of the call. This is intended to be used between fs.stat and fs.readFile
 * to mitigate TOCTOU symlink swap attacks. Returns the real path if valid;
 * throws otherwise.
 */
export function revalidateRealPath(resolvedPath) {
  let real;
  try {
    real = fs.realpathSync(resolvedPath);
  } catch (err) {
    const e = new Error(`Path not found: ${resolvedPath}`);
    e.status = 404;
    e.cause = err;
    throw e;
  }
  // Re-run the allowed-roots check on the freshly resolved real path.
  const allowedRoots = getAllowedRoots();
  const realRoots = allowedRoots.map((root) => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });
  const normalizedReal = process.platform === 'win32' ? real.toLowerCase() : real;
  const isAllowed = realRoots.some((root) => {
    const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
    return normalizedReal === normalizedRoot || normalizedReal.startsWith(normalizedRoot + path.sep);
  });
  if (!isAllowed) {
    const err = new Error('Access denied: Path is outside the allowed directories');
    err.status = 403;
    throw err;
  }
  return real;
}

/**
 * Returns the default workspace root.
 */
export function getDefaultRoot() {
  const raw = (process.env.ALLOWED_ROOTS || '').trim();
  if (!raw) {
    return PROJECT_ROOT;
  }

  const roots = getAllowedRoots();
  const customRoots = roots.filter((r) => r !== PROJECT_ROOT);
  return customRoots.length > 0 ? customRoots[0] : PROJECT_ROOT;
}

export { PROJECT_ROOT };
