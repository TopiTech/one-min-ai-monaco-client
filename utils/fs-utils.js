import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { createReadStream } from 'fs';
import { validatePath, assertNotWriteProtectedPath } from './fs-guard.js';
import { BadRequestError, ForbiddenError } from './errors.js';

/**
 * Reads up to `maxBytes` from the start of a file.
 *
 * `FileHandle.read` is allowed to return fewer bytes than requested even
 * before EOF, so a single read can silently truncate the returned buffer.
 * This helper loops until the requested length is filled or EOF is reached.
 *
 * @param {string} filePath Absolute path of the file to read.
 * @param {number} maxBytes Upper bound on the number of bytes to read.
 * @returns {Promise<Buffer>} The bytes read (possibly fewer than `maxBytes` at EOF).
 */
export async function readHeadBytes(filePath, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 0;
  if (limit === 0) return Buffer.alloc(0);

  const fd = await fs.open(filePath, 'r');
  try {
    const stat = await fd.stat();
    const length = Math.min(limit, stat.size);
    if (length <= 0) return Buffer.alloc(0);

    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await fd.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset === length ? buffer : buffer.subarray(0, offset);
  } finally {
    await fd.close();
  }
}

/**
 * Atomically writes a text file by writing to a temporary file first and renaming it.
 * Uses 'wx' flag to prevent symlink hijacking and checks if the target path is a symlink.
 * Preserves existing file permissions on POSIX when overwriting unless `options.mode` is specified.
 *
 * @param {string} filePath Target file path.
 * @param {string} content Text content to write.
 * @param {{ mode?: number }} [options] Optional write options.
 */
export async function atomicWriteTextFile(filePath, content, options = {}) {
  const lexicalTarget = validatePath(filePath, { resolveSymlinks: false });
  assertNotWriteProtectedPath(lexicalTarget);

  const dir = path.dirname(lexicalTarget);
  const resolvedDir = validatePath(dir);

  const tmpPath = path.join(resolvedDir, `.${path.basename(lexicalTarget)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });

    let existingStat = null;
    try {
      existingStat = await fs.lstat(lexicalTarget);
      if (existingStat.isSymbolicLink()) {
        throw new ForbiddenError('Access denied: Target path is a symbolic link, writing blocked');
      }
      if (existingStat.isDirectory()) {
        throw new BadRequestError('Target path is a directory, cannot overwrite with file');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const resolvedTarget = validatePath(lexicalTarget);
    assertNotWriteProtectedPath(resolvedTarget);

    if (typeof options.mode === 'number') {
      await fs.chmod(tmpPath, options.mode);
    } else if (existingStat && process.platform !== 'win32') {
      const existingMode = existingStat.mode & 0o777;
      if (existingMode !== 0o600) {
        await fs.chmod(tmpPath, existingMode);
      }
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
  const normalizedStart =
    Number.isFinite(Number(startLine)) && Number(startLine) >= 1 ? Math.floor(Number(startLine)) : 1;
  const normalizedEnd =
    endLine !== undefined && endLine !== null && Number.isFinite(Number(endLine))
      ? Math.floor(Number(endLine))
      : undefined;
  if (normalizedEnd !== undefined && normalizedEnd < normalizedStart) {
    return '';
  }

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
      if (isClosed) return;
      currentLine++;
      if (currentLine >= normalizedStart) {
        if (normalizedEnd === undefined || currentLine <= normalizedEnd) {
          resultLines.push(line);
        }
        if (normalizedEnd !== undefined && currentLine >= normalizedEnd) {
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
