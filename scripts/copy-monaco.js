/**
 * Copy Monaco Editor assets from node_modules to public/vs/
 * This avoids CDN loading issues with Firefox Tracking Prevention.
 *
 * The copy is skipped only when public/vs/ already holds assets for the
 * currently installed monaco-editor version. The version is recorded in
 * public/vs/.monaco-version, so upgrading the dependency (or a previously
 * interrupted copy) always triggers a fresh copy instead of serving stale
 * assets.
 */
import { cpSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

const packageJsonPath = join(projectRoot, 'node_modules', 'monaco-editor', 'package.json');
const src = join(projectRoot, 'node_modules', 'monaco-editor', 'min', 'vs');
const dest = join(projectRoot, 'public', 'vs');

const VERSION_MARKER_FILE = '.monaco-version';

if (!existsSync(src)) {
  console.error('Monaco Editor source not found at:', src);
  console.error('Run "npm install" before starting the app.');
  process.exit(1);
}

let monacoVersion = '';
try {
  monacoVersion = String(JSON.parse(readFileSync(packageJsonPath, 'utf8')).version || '').trim();
} catch {
  // Unknown version: never treat a previous copy as current.
}

function dirExists(dirPath) {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function hasCurrentCopy() {
  if (!monacoVersion || !dirExists(dest) || !existsSync(join(dest, 'loader.js'))) {
    return false;
  }
  try {
    return readFileSync(join(dest, VERSION_MARKER_FILE), 'utf8').trim() === monacoVersion;
  } catch {
    return false;
  }
}

if (hasCurrentCopy()) {
  console.log(`Monaco Editor ${monacoVersion} assets already present at ${dest}, skipping copy.`);
  process.exit(0);
}

// Copy from scratch: a stale or partially copied directory must never survive,
// otherwise the app serves hash-mismatched Monaco chunks after an upgrade.
// The copy is built in a process-private staging directory and swapped in at
// the end, so a concurrently starting dev server can never interleave with
// this copy and leave a truncated public/vs behind its version marker.
const staging = join(projectRoot, 'public', `.vs-staging-${process.pid}`);

function discard(dirPath) {
  rmSync(dirPath, { recursive: true, force: true });
}

try {
  discard(staging);
  cpSync(src, staging, { recursive: true });
  writeFileSync(join(staging, VERSION_MARKER_FILE), `${monacoVersion}\n`, 'utf8');
  discard(dest);
  renameSync(staging, dest);
} catch (err) {
  discard(staging);
  if (hasCurrentCopy()) {
    // Another process finished a valid copy while this one was staging.
    console.log(`Monaco Editor ${monacoVersion} assets were installed concurrently, skipping copy.`);
    process.exit(0);
  }
  discard(dest);
  console.error(`Failed to copy Monaco Editor assets from ${src} to ${dest}:`, err.message);
  console.error(
    `Verify that you have write permissions to ${join(projectRoot, 'public')} and that node_modules is properly installed (npm install).`,
  );
  process.exit(1);
}

console.log(`Copied Monaco Editor assets (${monacoVersion || 'unknown version'}) to ${dest}`);
