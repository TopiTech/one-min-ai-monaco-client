import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Startup cleanup: remove orphaned temporary files from previous runs
 * that may have been left behind due to sudden server crashes.
 */
export async function startupCleanup(tmpDir) {
  try {
    const entries = await fsp.readdir(tmpDir, { withFileTypes: true });
    await Promise.all(
      entries.filter((e) => e.isFile()).map((e) => fsp.unlink(path.join(tmpDir, e.name)).catch(() => {})),
    );
  } catch {
    // Best-effort cleanup, ignore errors
  }
}

/**
 * Periodic cleanup for orphaned temporary files during runtime.
 * Deletes files older than 1 hour, running every 1 hour.
 * Returns the interval handle so callers can unref() it.
 */
export function startPeriodicCleanup(tmpDir) {
  const intervalId = setInterval(() => {
    try {
      const files = fs.readdirSync(tmpDir);
      const now = Date.now();
      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > ONE_HOUR_MS) {
          fs.unlinkSync(filePath);
        }
      }
    } catch {
      // Best-effort cleanup, ignore errors
    }
  }, ONE_HOUR_MS);
  return intervalId;
}
