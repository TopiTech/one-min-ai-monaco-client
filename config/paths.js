import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Root of the application checkout. App data lives in its own hidden
 * directory instead of a third-party tool folder (such as `.mimocode/` or
 * `.commandcode/`), which is owned by the coding agent that creates it.
 */
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const APP_DATA_DIR_NAME = '.onemin-ai';
export const APP_DATA_DIR = path.join(PROJECT_ROOT, APP_DATA_DIR_NAME);
export const DATA_DIR = path.join(APP_DATA_DIR, 'data');
export const TMP_DIR = path.join(APP_DATA_DIR, 'tmp');

/** Location used before the app had its own data directory. */
export const LEGACY_DATA_DIR = path.join(PROJECT_ROOT, '.mimocode', 'data');

// Only files created by this app are migrated. Anything else in the legacy
// directory belongs to the coding agent that owns `.mimocode/`.
const LEGACY_DATA_FILES = [
  'api_keys.json',
  'bff_session.token',
  'agent_sessions.json',
  'pending_commands.json',
];

let defaultMigrationDone = false;

/**
 * Copies this app's persisted files from the legacy `.mimocode/data`
 * directory into the app data directory. Existing destination files are
 * never overwritten, and failures are non-fatal so a missing or unreadable
 * legacy directory cannot block startup.
 *
 * @param {object} [options]
 * @param {string} [options.legacyDir] Source directory (defaults to `.mimocode/data`).
 * @param {string} [options.dataDir] Destination directory (defaults to `.onemin-ai/data`).
 */
export function migrateLegacyDataSync({ legacyDir = LEGACY_DATA_DIR, dataDir = DATA_DIR } = {}) {
  const isDefault = legacyDir === LEGACY_DATA_DIR && dataDir === DATA_DIR;
  if (isDefault && defaultMigrationDone) return;
  if (isDefault) defaultMigrationDone = true;

  try {
    if (!fs.existsSync(legacyDir)) return;
    for (const fileName of LEGACY_DATA_FILES) {
      const source = path.join(legacyDir, fileName);
      const destination = path.join(dataDir, fileName);
      try {
        if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
      } catch {
        // Best-effort: keep migrating the remaining files.
      }
    }
  } catch {
    // Best-effort: the app can start with a fresh data directory.
  }
}
