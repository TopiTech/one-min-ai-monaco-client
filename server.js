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

  const hashA = crypto.createHash("sha256").update(a).digest();
  const hashB = crypto.createHash("sha256").update(b).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(`;`).forEach(function (cookie) {
    let [name, ...rest] = cookie.split(`=`);
    name = name?.trim();
    if (!name) return;
    const value = rest.join(`=`).trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

function localBffAuth({ requireToken = true, authToken } = {}) {
  // B-1: Require explicit authToken to prevent accidental re-evaluation of createLocalAuthToken()
  if (requireToken && !authToken) {
    throw new Error("localBffAuth: authToken must be provided explicitly when requireToken=true");
  }

  if (!requireToken) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = req.get("x-local-bff-token");
    const cookieToken = cookies["__bff_session"];
    const tokenOk =
      headerToken &&
      compareAuthToken(headerToken, authToken) &&
      cookieToken &&
      compareAuthToken(cookieToken, authToken);

    if (!tokenOk) {
      const err = new Error("Local BFF authentication required or invalid token");
      err.status = 403;
      return next(err);
    }

    // Require explicit same-origin/request-from-host signal to mitigate CSRF.
    // We deliberately do NOT trust the Origin header alone; combine it with
    // either the Host header or the sec-fetch-site marker sent by browsers.
    const origin = req.get("origin");
    const host = req.get("host");
    const secFetchSite = req.get("sec-fetch-site");
    const referer = req.get("referer");

    const isSameOrigin = (() => {
      if (origin) {
        try {
          const parsed = new URL(origin);
          if (host && parsed.host === host) return true;
        } catch {
          // fall through
        }
      }
      if (secFetchSite === "same-origin") return true;
      if (referer) {
        try {
          const parsedReferer = new URL(referer);
          if (host && parsedReferer.host === host) return true;
        } catch {
          // fall through
        }
      }
      return false;
    })();

    if (!isSameOrigin) {
      const err = new Error("Cross-origin requests are not allowed without a valid token");
      err.status = 403;
      return next(err);
    }

    return next();
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

// L-1: Higher limit for autocomplete and streaming as they are triggered frequently
const autocompleteRateLimit = buildRateLimit({ max: 600, windowMs: 1 * 60 * 1000 });
const aiChatRateLimit = buildRateLimit({ max: 300, windowMs: 1 * 60 * 1000 });

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

    const safeName = path
      .basename(req.file.originalname || "upload.bin")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .substring(0, 255);
    formData.append("asset", blob, safeName);

    const data = await callOneMin("/api/assets", { method: "POST", body: formData });
    const { raw: _raw, ...normalized } = normalizeAssetResponse(data);

    logger.info("Asset upload successful", { filename: req.file.originalname });
    res.json(normalized);
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
        } else if (sensitiveKeys.some((sk) => key.toLowerCase().includes(sk))) {
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

  // Apply specific rate limits for high-frequency API endpoints
  app.use("/api/chat", aiChatRateLimit);
  app.use("/api/code", autocompleteRateLimit);

  app.get(["/", "/index.html"], (req, res) => {
    try {
      const htmlPath = path.join(__dirname, "public", "index.html");
      const html = fs.readFileSync(htmlPath, "utf8");

      // Set the token as HttpOnly cookie (CSRF mitigation) AND inject a
      // data attribute on <body> so client-side JS can read it for the
      // x-local-bff-token header. The body attribute is only ever
      // readable from same-origin JS.
      if (requireLocalAuth) {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        res.cookie("__bff_session", localAuthToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "Strict", // M-3: Strict prevents cross-site request forgery
          maxAge: ONE_DAY_MS, // B-2: Expire after 24h to limit session persistence
        });

        const injected = html.replace(
          /<body(\s*[^>]*)>/i,
          (match, attrs) => `<body${attrs} data-bff-token="${localAuthToken}">`,
        );
        return res.send(injected);
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
  // B-5: Health endpoint does not require auth but minimizes info exposure
  app.use("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "one-min-ai-monaco-client",
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

  // B-5: Single auth layer at /api level. Sub-routes are mounted inside one protected router
  // to avoid double invocation of protectedApiAuth.
  const protectedRouter = express.Router();
  protectedRouter.use("/", aiRoutes);
  protectedRouter.use("/fs", fsRoutes);
  protectedRouter.use("/agent", agentRoutes);
  app.use("/api", protectedApiAuth, protectedRouter);

  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === "development";

    logger.error(`API Error: ${status}`, {
      error: err.message,
      status,
      method: req.method,
      url: req.originalUrl,
      stack: isDev ? err.stack : undefined,
    });

    res.status(status).json({
      error: normalizePayloadError(err) || err.message || "Internal Server Error",
      code: err.code || "UNKNOWN_ERROR",
      details: isDev ? sanitizePayload(err.payload) || null : null,
      stack: isDev ? err.stack : undefined,
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
