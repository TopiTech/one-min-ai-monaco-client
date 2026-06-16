import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { callOneMin, normalizeAssetResponse } from "./utils/api-client.js";
import { serverConfig } from "./config/server.js";
import logger from "./utils/logger.js";
import { validateBufferMimeType } from "./utils/mime-guard.js";
import fs from "fs";

import aiRoutes from "./routes/ai.js";
import fsRoutes from "./routes/fs.js";
import agentRoutes from "./routes/agent.js";
import { initModels } from "./config/models.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MIME_TYPES = [
  "image/",
  "video/",
  "audio/",
  "application/pdf",
  "text/",
  "application/json",
  "application/xml",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: serverConfig.maxFileSize },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_MIME_TYPES.some((t) => file.mimetype.startsWith(t));
    if (!allowed) {
      const err = new Error(
        `Unsupported file type: ${file.mimetype}. Allowed types: ${ALLOWED_MIME_TYPES.join(", ")}`,
      );
      err.status = 415;
      return cb(err, false);
    }
    cb(null, true);
  },
});

function createLocalAuthToken() {
  return crypto.randomBytes(24).toString("hex");
}

function compareAuthToken(a, b) {
  if (!a || !b || typeof a !== "string" || typeof b !== "string") return false;

  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(`;`).forEach(function(cookie) {
    let [name, ...rest] = cookie.split(`=`);
    name = name?.trim();
    if (!name) return;
    const value = rest.join(`=`).trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function localBffAuth({
  requireToken = true,
  authToken = process.env.LOCAL_BFF_AUTH_TOKEN || createLocalAuthToken(),
} = {}) {
  return (req, res, next) => {
    if (!requireToken) return next();

    const cookies = parseCookies(req.headers.cookie);
    const headerToken = req.get("x-local-bff-token") || cookies["__bff_session"];
    if (headerToken && compareAuthToken(headerToken, authToken)) {
      return next();
    }

    const err = new Error("Local BFF authentication required or invalid token");
    err.status = 403;
    next(err);
  };
}

function buildRateLimit(config) {
  return rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 180,
    message: { error: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
    ...config,
  });
}

function normalizePayloadError(err) {
  if (!err?.payload) return null;
  if (typeof err.payload === "string") return err.payload;
  if (typeof err.payload === "object") {
    return err.payload.error || err.payload.message || JSON.stringify(err.payload);
  }
  return null;
}

function buildCspDirectives() {
  // NOTE: 'unsafe-inline' in scriptSrc is required for Monaco Editor's AMD loader.
  // For production, consider using nonces or self-hosting Monaco to remove this.
  // styleSrc 'unsafe-inline' is needed for dynamic theme toggling.
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'", "blob:"],
    styleSrc: [
      "'self'",
      "'unsafe-inline'",
      "https://cdn.jsdelivr.net",
      "https://fonts.googleapis.com",
    ],
    imgSrc: ["'self'", "data:", "https:", "blob:"],
    connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
    fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net", "https://fonts.gstatic.com"],
    objectSrc: ["'none'"],
    mediaSrc: ["'self'"],
    frameSrc: ["'none'"],
    workerSrc: ["'self'", "blob:"],
  };
}

async function handleAssetUpload(req, res, next) {
  try {
    if (!req.file) return res.status(400).json({ error: "asset file is required" });

    // Validate real mime type using magic bytes check
    if (!validateBufferMimeType(req.file.buffer, req.file.mimetype)) {
      logger.warn("Asset upload rejected: MIME type signature mismatch", {
        filename: req.file.originalname,
        mimetype: req.file.mimetype,
      });
      return res.status(415).json({
        error: `Unsupported file type or signature mismatch: ${req.file.mimetype}`,
      });
    }

    logger.info("Processing asset upload", {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });

    const formData = new FormData();
    const blob = new Blob([req.file.buffer], {
      type: req.file.mimetype || "application/octet-stream",
    });

    const safeName = path.basename(req.file.originalname || 'upload.bin')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .substring(0, 255);
    formData.append("asset", blob, safeName);

    const data = await callOneMin("/api/assets", { method: "POST", body: formData });
    const normalized = normalizeAssetResponse(data);

    logger.info("Asset upload successful", { filename: req.file.originalname });
    res.json({
      ...normalized,
      raw: data,
    });
  } catch (err) {
    logger.error("Asset upload failed", { error: err.message });
    next(err);
  }
}

function sanitizePayload(payload) {
  if (!payload) return null;
  if (typeof payload !== "object") return payload;
  try {
    const sanitized = JSON.parse(JSON.stringify(payload));
    const sensitiveKeys = ["api_key", "apikey", "key", "token", "auth", "authorization", "secret"];
    const walk = (obj) => {
      if (!obj || typeof obj !== "object") return;
      for (const key in obj) {
        if (typeof obj[key] === "object" && obj[key] !== null) {
          walk(obj[key]);
        } else if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
          obj[key] = "[MASKED]";
        }
      }
    };
    walk(sanitized);
    return sanitized;
  } catch (e) {
    return "[Unable to sanitize details]";
  }
}

export function createApp(options = {}) {
  const {
    requireLocalAuth = process.env.NODE_ENV !== "test",
    authToken,
    localAuthToken: localAuthTokenOption,
    enableRateLimit = process.env.NODE_ENV !== "test",
  } = options;
  const localAuthToken =
    localAuthTokenOption ?? authToken ?? process.env.LOCAL_BFF_AUTH_TOKEN ?? createLocalAuthToken();

  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: buildCspDirectives(),
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  if (enableRateLimit) {
    app.use(buildRateLimit());
  }

  app.use(logger.requestLogger());
  app.use(express.json({ limit: serverConfig.maxJsonBodySize }));

  app.get(["/", "/index.html"], (req, res) => {
    try {
      const htmlPath = path.join(__dirname, "public", "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");
      
      // Set the token as HttpOnly cookie instead of embedding in HTML meta tag
      if (requireLocalAuth) {
        res.cookie('__bff_session', localAuthToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: 'Lax'
        });
      }
      
      res.send(html);
    } catch (e) {
      res.status(500).send("Error loading index.html");
    }
  });

  app.use(express.static(path.join(__dirname, "public")));

  const protectedApiAuth = localBffAuth({
    requireToken: requireLocalAuth,
    authToken: localAuthToken,
  });
  app.use("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "one-min-ai-monaco-client",
      localAuthEnabled: requireLocalAuth,
      hasApiKey: !!process.env.ONE_MIN_AI_API_KEY,
    });
  });

  app.post(
    "/api/assets/upload",
    protectedApiAuth,
    (req, res, next) => {
      upload.single("asset")(req, res, (err) => {
        if (err) return next(err);
        handleAssetUpload(req, res, next);
      });
    },
    (err, _req, res, next) => {
      next(err);
    },
  );

  app.use("/api", protectedApiAuth, aiRoutes);
  app.use("/api/fs", protectedApiAuth, fsRoutes);
  app.use("/api/agent", protectedApiAuth, agentRoutes);

  app.use((err, req, res, _next) => {
    logger.error("Unhandled error", {
      error: err.message,
      status: err.status,
      method: req.method,
      url: req.originalUrl,
      stack: err.stack,
    });

    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === "development";
    res.status(status).json({
      error: normalizePayloadError(err) || err.message || "Internal Server Error",
      details: isDev ? sanitizePayload(err.payload) || null : null,
    });
  });

  return app;
}

if (process.env.NODE_ENV !== "test") {
  initModels().then(() => {
    createApp().listen(serverConfig.port, "127.0.0.1", () => {
      logger.info(`1min.ai Monaco client running: http://127.0.0.1:${serverConfig.port}`);
      logger.info("Server configuration", {
        port: serverConfig.port,
        maxFileSize: serverConfig.maxFileSize,
        apiTimeout: serverConfig.apiTimeout,
        apiRetryAttempts: serverConfig.apiRetryAttempts,
      });
    });
  });
}
