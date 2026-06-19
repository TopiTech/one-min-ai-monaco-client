/**
 * Simple logging utility with file and console output.
 * Supports log levels: error, warn, info, debug
 */

import fs from "fs";
import { appendFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const LOG_COLORS = {
  error: "\x1b[31m", // Red
  warn: "\x1b[33m", // Yellow
  info: "\x1b[36m", // Cyan
  debug: "\x1b[90m", // Gray
  reset: "\x1b[0m",
};

function normalizeLogLevel(level) {
  const normalized = String(level || "info").toLowerCase();
  return Object.prototype.hasOwnProperty.call(LOG_LEVELS, normalized)
    ? LOG_LEVELS[normalized]
    : LOG_LEVELS.info;
}

class Logger {
  constructor(options = {}) {
    this.level = normalizeLogLevel(options.level);
    this.logToFile = options.logToFile ?? false;
    this.logDir = options.logDir || path.join(__dirname, "..", "logs");

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
    let metaStr = "";
    if (Object.keys(meta).length) {
      try {
        // L-3: Cap meta serialization at 8KB to avoid runaway logs from
        // accidentally logged payloads (e.g. full upstream error
        // responses). Truncated entries are tagged so the truncation
        // is visible downstream.
        let serialized = JSON.stringify(meta, (_k, v) => {
          if (typeof v === "string" && v.length > 1024) {
            // Q-5: Avoid splitting surrogate pairs when truncating
            let truncated = v.slice(0, 1024);
            const last = truncated.length - 1;
            if (last >= 0) {
              const code = truncated.charCodeAt(last);
              if (code >= 0xd800 && code <= 0xdbff) {
                truncated = truncated.slice(0, last);
              }
            }
            return truncated + "...[truncated]";
          }
          if (typeof v === "function" || typeof v === "undefined") return undefined;
          return v;
        }).replace(/\r?\n/g, "\\n");
        if (serialized && serialized.length > 8192) {
          serialized = serialized.slice(0, 8192) + "...[truncated]";
        }
        metaStr = ` ${serialized}`;
      } catch {
        metaStr = " [Invalid Meta]";
      }
    }
    const safeMessage = String(message).replace(/\r?\n/g, "\\n");
    return `[${timestamp}] [${level.toUpperCase()}] ${safeMessage}${metaStr}`;
  }

  _writeToFile(formattedMessage) {
    if (!this.logToFile) return;

    const date = new Date().toISOString().split("T")[0];
    const logFile = path.join(this.logDir, `app-${date}.log`);

    appendFile(logFile, formattedMessage + "\n").catch((err) => {
      console.error(`Failed to write to log file: ${err.message}`);
    });
  }

  _log(level, message, meta = {}) {
    if (LOG_LEVELS[level] > this.level) return;

    const formatted = this._formatMessage(level, message, meta);
    const color = LOG_COLORS[level] || "";
    const reset = LOG_COLORS.reset;

    // Console output with colors
    console.log(`${color}${formatted}${reset}`);

    // File output without colors
    this._writeToFile(formatted);
  }

  error(message, meta = {}) {
    this._log("error", message, meta);
  }

  warn(message, meta = {}) {
    this._log("warn", message, meta);
  }

  info(message, meta = {}) {
    this._log("info", message, meta);
  }

  debug(message, meta = {}) {
    this._log("debug", message, meta);
  }

  // Express middleware for request logging
  requestLogger() {
    return (req, res, next) => {
      const start = Date.now();

      res.on("finish", () => {
        const duration = Date.now() - start;
        this.info(`${req.method} ${req.originalUrl}`, {
          status: res.statusCode,
          duration: `${duration}ms`,
          ip: req.ip,
        });
      });

      next();
    };
  }
}

// Default logger instance
const logger = new Logger({
  level: process.env.LOG_LEVEL || "info",
  logToFile: process.env.LOG_TO_FILE === "true",
});

export { Logger, logger };
export default logger;
