import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { createReadStream } from 'fs';
import { validatePath, assertNotWriteProtectedPath } from './fs-guard.js';

/**
 * Atomically writes a text file by writing to a temporary file first and renaming it.
 * Uses 'wx' flag to prevent symlink hijacking and checks if the target path is a symlink.
 *
 * @param {string} filePath Target file path.
 * @param {string} content Text content to write.
 */
export async function atomicWriteTextFile(filePath, content) {
  const dir = path.dirname(filePath);
  const resolvedDir = validatePath(dir);

  const tmpPath = path.join(resolvedDir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });

    const resolvedTarget = validatePath(filePath);
    assertNotWriteProtectedPath(resolvedTarget);

    try {
      const stat = await fs.lstat(resolvedTarget);
      if (stat.isSymbolicLink()) {
        throw new Error('Target path is a symbolic link, writing blocked');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    await fs.rename(tmpPath, resolvedTarget);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Reads only specific lines of a file using a stream to conserve memory.
 *
 * @param {string} filePath Absolute path of the file to read.
 * @param {number} startLine 1-based index of the first line to read.
 * @param {number} [endLine] 1-based index of the last line to read.
 * @returns {Promise<string>} The requested lines joined by newlines.
 */
export async function readSpecificLines(filePath, startLine = 1, endLine) {
  return new Promise((resolve, reject) => {
    const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let currentLine = 0;
    const resultLines = [];
    let isClosed = false;

    const cleanup = () => {
      if (!isClosed) {
        isClosed = true;
        rl.close();
        fileStream.destroy();
      }
    };

    rl.on('line', (line) => {
      currentLine++;
      if (currentLine >= startLine) {
        if (endLine === undefined || currentLine <= endLine) {
          resultLines.push(line);
        } else {
          cleanup();
        }
      }
    });

    rl.on('close', () => {
      cleanup();
      resolve(resultLines.join('\n'));
    });

    rl.on('error', (err) => {
      cleanup();
      reject(err);
    });

    fileStream.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });
}
