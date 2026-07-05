/**
 * Simple logging utility with file and console output.
 * Supports log levels: error, warn, info, debug
 */

import fs from 'fs';
import { appendFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { sanitizePayload } from './sanitize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const LOG_COLORS = {
  error: '\x1b[31m', // Red
  warn: '\x1b[33m', // Yellow
  info: '\x1b[36m', // Cyan
  debug: '\x1b[90m', // Gray
  reset: '\x1b[0m',
};

function normalizeLogLevel(level) {
  const normalized = String(level || 'info').toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)
    ? LOG_LEVELS[normalized]
    : LOG_LEVELS.info;
}

const DEFAULT_LOG_DIR = path.join(__dirname, '..', 'logs');
const MAX_LOG_PATH_LENGTH = 240;

function sanitizeUrlForLogging(urlLike) {
  if (!urlLike) return '/';
  const raw = String(urlLike);
  let pathOnly;
  try {
    pathOnly = new URL(raw, 'http://localhost').pathname || '/';
  } catch {
    const qIndex = raw.indexOf('?');
    pathOnly = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  }
  if (pathOnly.length > MAX_LOG_PATH_LENGTH) {
    return pathOnly.slice(0, MAX_LOG_PATH_LENGTH) + '...[truncated]';
  }
  return pathOnly;
}

class Logger {
  constructor(options = {}) {
    this.level = normalizeLogLevel(options.level);
    this.logToFile = options.logToFile ?? false;
    this.logDir = options.logDir || DEFAULT_LOG_DIR;
    this.logFilePrefix = 'app-';

    // If logFilePath is provided (e.g. "logs/app.log"), extract the directory
    // and derive a file prefix so the date-rotation naming is preserved.
    // "logs/my-custom.log" → logDir = resolved("logs"), prefix = "my-custom-".
    if (options.logFilePath) {
      const p = path.resolve(options.logFilePath);
      this.logDir = path.dirname(p);
      const basename = path.basename(p, path.extname(p)); // "my-custom"
      this.logFilePrefix = basename + '-';
    }

    if (this.logToFile) {
      this._ensureLogDir();
    }
  }

  _ensureLogDir() {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      console.error(`Failed to create log directory: ${err.message}`);
    }
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    let metaStr = '';
    if (Object.keys(meta).length) {
      try {
        // D-1: Globally sanitize log metadata to prevent accidental leakage
        // of sensitive credentials or payloads to log files.
        const sanitizedMeta = sanitizePayload(meta);

        // L-3: Cap meta serialization at 8KB to avoid runaway logs from
        // accidentally logged payloads (e.g. full upstream error
        // responses). Truncated entries are tagged so the truncation
        // is visible downstream.
        let serialized = JSON.stringify(sanitizedMeta, (_k, v) => {
          if (typeof v === 'string' && v.length > 1024) {
            // Q-5: Avoid splitting surrogate pairs when truncating
            let truncated = v.slice(0, 1024);
            const last = truncated.length - 1;
            if (last >= 0) {
              const code = truncated.charCodeAt(last);
              if (code >= 0xd800 && code <= 0xdbff) {
                truncated = truncated.slice(0, last);
              }
            }
            return truncated + '...[truncated]';
          }
          if (typeof v === 'function' || typeof v === 'undefined') return undefined;
          return v;
        }).replace(/\r?\n/g, '\\n');
        if (serialized && serialized.length > 8192) {
          serialized = serialized.slice(0, 8192) + '...[truncated]';
        }
        metaStr = ` ${serialized}`;
      } catch {
        metaStr = ' [Invalid Meta]';
      }
    }
    const safeMessage = String(message).replace(/\r?\n/g, '\\n');
    return `[${timestamp}] [${level.toUpperCase()}] ${safeMessage}${metaStr}`;
  }

  _writeToFile(formattedMessage) {
    if (!this.logToFile) return;

    const date = new Date().toISOString().split('T')[0];
    const logFile = path.join(this.logDir, `${this.logFilePrefix}${date}.log`);

    appendFile(logFile, formattedMessage + '\n').catch((err) => {
      console.error(`Failed to write to log file: ${err.message}`);
    });
  }

  /**
   * L-2: Remove log files older than `maxAgeDays` from the log directory.
   * Only files matching the configured prefix and `.log` extension are
   * considered; any other files are left untouched. Returns the count of
   * deleted files. Safe to call periodically (e.g. once per day).
   */
  async pruneOldLogs(maxAgeDays = 30) {
    if (!this.logToFile || !Number.isFinite(maxAgeDays) || maxAgeDays < 1) return 0;
    try {
      const files = await fs.promises.readdir(this.logDir);
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      let deleted = 0;
      for (const name of files) {
        if (!name.startsWith(this.logFilePrefix) || !name.endsWith('.log')) continue;
        const fullPath = path.join(this.logDir, name);
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtimeMs < cutoff) {
            await fs.promises.unlink(fullPath);
            deleted++;
          }
        } catch {
          // Ignore stat/unlink errors for individual files.
        }
      }
      return deleted;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error(`Failed to prune old log files: ${err.message}`);
      }
      return 0;
    }
  }

  _log(level, message, meta = {}) {
    if (LOG_LEVELS[level] > this.level) return;

    const formatted = this._formatMessage(level, message, meta);
    const color = LOG_COLORS[level] || '';
    const reset = LOG_COLORS.reset;

    // Console output with colors
    console.log(`${color}${formatted}${reset}`);

    // File output without colors
    this._writeToFile(formatted);
  }

  error(message, meta = {}) {
    this._log('error', message, meta);
  }

  warn(message, meta = {}) {
    this._log('warn', message, meta);
  }

  info(message, meta = {}) {
    this._log('info', message, meta);
  }

  debug(message, meta = {}) {
    this._log('debug', message, meta);
  }

  // Express middleware for request logging
  requestLogger() {
    return (req, res, next) => {
      const start = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - start;
        this.info(`${req.method} ${sanitizeUrlForLogging(req.originalUrl)}`, {
          status: res.statusCode,
          duration: `${duration}ms`,
          ip: req.ip,
        });
      });

      next();
    };
  }
}

// Default logger instance — reads env vars for safe fallback before server.js
// has a chance to call initLogger(). Once initLogger(config) is called the
// singleton is reconfigured with the validated serverConfig values.
const logger = new Logger({
  level: process.env.LOG_LEVEL || 'info',
  logToFile: process.env.LOG_TO_FILE === 'true',
  logFilePath: process.env.LOG_FILE || undefined,
});

/**
 * Reconfigure the default logger singleton with validated config values.
 * Called once from server.js after serverConfig is fully resolved.
 * This avoids circular imports and lets config/server.js own validation.
 */
export function initLogger(config = {}) {
  logger.level = normalizeLogLevel(config.logLevel);
  logger.logToFile = config.logToFile ?? false;
  if (config.logFilePath) {
    const p = path.resolve(config.logFilePath);
    logger.logDir = path.dirname(p);
    const basename = path.basename(p, path.extname(p));
    logger.logFilePrefix = basename + '-';
  }
  if (logger.logToFile) {
    logger._ensureLogDir();
  }
  return logger;
}

export { Logger, logger, sanitizeUrlForLogging };
export default logger;
