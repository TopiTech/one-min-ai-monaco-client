import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import crypto from "crypto";
import { callOneMin, normalizeAssetResponse } from "./utils/api-client.js";
import { serverConfig } from "./config/server.js";
import logger, { initLogger } from "./utils/logger.js";
import { validateBufferMimeType } from "./utils/mime-guard.js";
import fs from "fs";
import fsp from "fs/promises";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { sanitizePayload } from "./utils/sanitize.js";

// Replace the env-var-based default singleton with the validated serverConfig.
// This ensures LOG_LEVEL, LOG_TO_FILE, and LOG_FILE are all parsed and clamped
// consistently (e.g. LOG_LEVEL "info" → parseLogLevel, LOG_TO_FILE "true" →
// parseBoolean).
initLogger(serverConfig);

import aiRoutes from "./routes/ai.js";
import fsRoutes from "./routes/fs.js";
import agentRoutes from "./routes/agent.js";
import agentChatRoutes from "./routes/agent-chat.js";
import { initModels, getModelSyncStatus } from "./config/models.js";

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

// S-1: Switched from multer.memoryStorage() to diskStorage to avoid OOM
// when several large uploads arrive concurrently. Each file lands in
// os.tmpdir() with a random suffix and is unlinked after the upstream
// request finishes (success or failure).
const UPLOAD_TMP_DIR = path.join(os.tmpdir(), "one-min-ai-uploads");
fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });

// E-1: Startup cleanup to remove any orphaned temporary files from previous runs
// that may have been left behind due to sudden server crashes.
try {
  const files = fs.readdirSync(UPLOAD_TMP_DIR);
  for (const file of files) {
    fs.unlinkSync(path.join(UPLOAD_TMP_DIR, file));
  }
} catch (err) {
  // Best-effort cleanup, ignore errors
}

// B-6: Periodic cleanup for orphaned temporary files during runtime.
// Deletes files older than 1 hour, running every 1 hour.
setInterval(() => {
  try {
    const files = fs.readdirSync(UPLOAD_TMP_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    for (const file of files) {
      const filePath = path.join(UPLOAD_TMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > ONE_HOUR) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (err) {
    // Best-effort cleanup, ignore errors
  }
}, 60 * 60 * 1000).unref();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_TMP_DIR),
    filename: (_req, file, cb) => {
      const suffix = crypto.randomBytes(8).toString("hex");
      cb(null, `${Date.now()}-${suffix}-${file.fieldname}`);
    },
  }),
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

class ProxySizeLimitError extends Error {
  constructor(limitBytes) {
    super(`Asset proxy response exceeds maximum size of ${limitBytes} bytes`);
    this.name = "ProxySizeLimitError";
    this.status = 413;
    this.code = "ASSET_PROXY_RESPONSE_TOO_LARGE";
  }
}

function buildAssetProxyAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeoutId),
  };
}

function parseContentLength(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

function createByteLimitTransform(limitBytes) {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk?.byteLength ?? chunk?.length ?? 0;
      if (total > limitBytes) {
        throw new ProxySizeLimitError(limitBytes);
      }
      controller.enqueue(chunk);
    },
  });
}

// QUAL-4: We intentionally parse cookies manually rather than adding the
// `cookie-parser` package. This server only needs to read one HttpOnly cookie
// (the BFF auth token) from the raw `Cookie` header. Adding cookie-parser
// would pull in an extra dependency, expose signed-cookie parsing that we
// don't need, and run for every request — including static file serving.
// If signed cookies or complex cookie handling is ever required, switch to
// cookie-parser at that point.
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(`;`).forEach(function (cookie) {
    let [name, ...rest] = cookie.split(`=`);
    name = name?.trim();
    if (!name) return;
    const value = rest.join(`=`).trim();
    if (!value) return;
    try {
      list[name] = decodeURIComponent(value);
    } catch {
      // Malformed percent-encoding in cookie value — store raw and continue
      list[name] = value;
    }
  });
  return list;
}

function localBffAuth({ requireToken = true, authToken } = {}) {
  // L-1: When authentication is not required (e.g. tests), short-circuit
  // immediately so the rest of the helper does not have to branch.
  if (!requireToken) {
    return (_req, _res, next) => next();
  }

  // B-1: Require explicit authToken to prevent accidental re-evaluation of createLocalAuthToken()
  if (!authToken) {
    throw new Error(
      "localBffAuth: authToken must be provided explicitly when requireToken=true. " +
        "Set LOCAL_BFF_AUTH_TOKEN in .env or pass localAuthToken option to createApp().",
    );
  }

  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = req.get("x-local-bff-token");
    const cookieToken = cookies["__bff_session"];

    // Cookie またはカスタムヘッダーのいずれかが正しいトークンを含んでいれば認証成功とする。
    // クエリパラメータからの漏洩を防ぐため、req.query.__bff_token は廃止。
    let tokenOk = false;
    if (cookieToken) {
      tokenOk = compareAuthToken(cookieToken, authToken);
      // 両方存在する場合、ヘッダー側のトークンも一致していることを厳格に検証
      if (headerToken && !compareAuthToken(headerToken, authToken)) {
        tokenOk = false;
      }
    } else if (headerToken) {
      // テスト環境など Cookie が送信されない場合のフォールバック
      tokenOk = compareAuthToken(headerToken, authToken);
    }

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

    // B-1: Sec-Fetch-Site is a browser-enforced header that cannot be
    // forged by simple fetch() calls. When it is explicitly "cross-site",
    // reject immediately without falling through to the heuristic checks.
    if (secFetchSite === "cross-site") {
      const err = new Error("Cross-origin requests are not allowed");
      err.status = 403;
      return next(err);
    }

    const isSameOrigin = (() => {
      if (secFetchSite === "same-origin") return true;
      const checkUrl = (urlStr) => {
        try {
          return host && new URL(urlStr).host === host;
        } catch {
          return false;
        }
      };
      if (origin && checkUrl(origin)) return true;
      if (referer && checkUrl(referer)) return true;
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

/**
 * Map multer/multer-like errors to proper HTTP status codes.
 * - LIMIT_FILE_SIZE       -> 413 Payload Too Large
 * - LIMIT_UNEXPECTED_FILE -> 400 Bad Request
 * - LIMIT_FIELD_COUNT     -> 400 Bad Request
 * - other 4xx             -> pass through
 * - everything else       -> 500 (handled by global error handler)
 */
function mapMulterError(err) {
  if (!err) return err;
  const code = err.code;
  if (code === "LIMIT_FILE_SIZE") {
    const e = new Error(err.message || "File too large");
    e.status = 413;
    e.code = code;
    e.field = err.field;
    return e;
  }
  const badRequestCodes = [
    "LIMIT_UNEXPECTED_FILE",
    "LIMIT_FIELD_COUNT",
    "LIMIT_FIELD_KEY",
    "LIMIT_FIELD_VALUE",
    "LIMIT_PART_COUNT",
    "LIMIT_FILE_COUNT",
  ];

  if (badRequestCodes.includes(code)) {
    const e = new Error(err.message || "Invalid multipart payload");
    e.status = 400;
    e.code = code;
    e.field = err.field;
    return e;
  }
  return err;
}

// QUAL-1: Renamed parameter from "config" to "overrides" to avoid confusion
// with the module-level `serverConfig` object. This parameter carries per-route
// overrides (e.g. a tighter `max`) that are spread on top of the defaults.
function buildRateLimit(overrides = {}) {
  return rateLimit({
    windowMs: serverConfig.rateLimitWindowMs,
    max: serverConfig.rateLimitMax,
    message: { error: "Too many requests, please try again later." },
    standardHeaders: true,
    legacyHeaders: false,
    ...overrides,
  });
}

const autocompleteRateLimit = buildRateLimit({ max: serverConfig.rateLimitAutocompleteMax });
const aiChatRateLimit = buildRateLimit({ max: serverConfig.rateLimitChatMax });

function normalizePayloadError(err) {
  if (!err?.payload) return null;
  if (typeof err.payload === "string") return err.payload;
  if (typeof err.payload === "object") {
    // Extract a safe, short error description from known upstream error shapes.
    // This avoids leaking raw payload data while still giving the client a
    // human-readable failure reason.
    const msg =
      err.payload.error ||
      err.payload.message ||
      err.payload.aiRecord?.aiRecordDetail?.errorMessage ||
      err.payload.aiRecord?.errorMessage ||
      err.payload.errorMessage;
    if (msg && typeof msg === "string") return msg;
    return "Upstream request failed (see details for sanitized payload)";
  }
  return null;
}

async function handleAssetUpload(req, res, next) {
  const tmpFilePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: "asset file is required" });

    if (req.file.size > 0) {
      // S-1: with disk storage, validate the on-disk buffer to avoid
      // loading the whole file into memory again. Read just the first
      // 8KB which is enough to cover the magic byte checks.
      const headBuf = Buffer.alloc(8192);
      const fd = await fsp.open(tmpFilePath, "r");
      let bytesRead = 0;
      try {
        const result = await fd.read(headBuf, 0, 8192, 0);
        bytesRead = result.bytesRead;
      } finally {
        await fd.close();
      }
      const head = headBuf.subarray(0, bytesRead);
      if (!validateBufferMimeType(head, req.file.mimetype)) {
        logger.warn("Asset upload rejected: MIME type signature mismatch", {
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
        });
        return res.status(415).json({
          error: `Unsupported file type or signature mismatch: ${req.file.mimetype}`,
        });
      }
    }

    logger.info("Processing asset upload", {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });

    const safeName = path
      .basename(req.file.originalname || "upload.bin")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .substring(0, 255);

    // A-1: Stream the file directly from disk into FormData using openAsBlob
    // if available (Node 19.8+). This prevents OOM spikes when uploading
    // large files compared to reading the entire buffer into memory.
    let assetBlob;
    if (typeof fs.openAsBlob === "function") {
      assetBlob = await fs.openAsBlob(tmpFilePath);
    } else {
      // Streamable custom Blob-like wrapper for Node.js versions without fs.openAsBlob
      assetBlob = {
        size: req.file.size,
        type: req.file.mimetype || "application/octet-stream",
        slice: () => {
          throw new Error("Not implemented");
        },
        arrayBuffer: async () => {
          const buf = await fsp.readFile(tmpFilePath);
          return buf.buffer;
        },
        text: async () => {
          return fsp.readFile(tmpFilePath, "utf-8");
        },
        stream: () => {
          const stream = fs.createReadStream(tmpFilePath);
          return Readable.toWeb ? Readable.toWeb(stream) : stream;
        },
        [Symbol.toStringTag]: "Blob",
      };
    }

    const formData = new FormData();
    formData.append("asset", assetBlob, safeName);

    const data = await callOneMin("/api/assets", {
      method: "POST",
      body: formData,
      idempotent: false,
    });
    const { raw: _raw, ...normalized } = normalizeAssetResponse(data);
    if (!normalized.key) {
      logger.warn("Asset upload completed without a usable asset key", {
        filename: req.file.originalname,
        responseKeys: Object.keys(data || {}),
      });
    }

    logger.info("Asset upload successful", { filename: req.file.originalname });
    res.json(normalized);
  } catch (err) {
    logger.error("Asset upload failed", { error: err.message });
    next(err);
  } finally {
    // Always clean up the temporary file regardless of outcome to avoid
    // filling the temp directory over time.
    if (tmpFilePath) {
      fsp.unlink(tmpFilePath).catch(() => {
        // Best-effort: ignore unlink errors (e.g. already removed).
      });
    }
  }
}

// sanitizePayload has been extracted to utils/sanitize.js

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

  // Host header validation to prevent DNS Rebinding
  app.use((req, res, next) => {
    const host = req.get("host");
    if (!host) {
      return res.status(400).json({ error: "Host header is required" });
    }
    const isAllowedHost = /^127\.0\.0\.1(?::\d+)?$/i.test(host) || /^localhost(?::\d+)?$/i.test(host);
    if (!isAllowedHost) {
      logger.warn("Blocked request with suspicious Host header", { host });
      return res.status(403).json({ error: "Access denied: Invalid Host header" });
    }
    next();
  });

  // Per-request nonce for CSP
  app.use((_req, res, next) => {
    res.locals.nonce = crypto.randomBytes(16).toString("base64");
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", (_req, res) => `'nonce-${res.locals.nonce}'`, "blob:"],
          // style-src intentionally omits the per-request nonce. CSP
          // forbids mixing 'nonce-...' with 'unsafe-inline' in the same
          // directive: when both are present the nonce wins and
          // 'unsafe-inline' is ignored, which broke Monaco's runtime
          // style assignments. The script-src directive above still
          // requires a nonce, so genuine XSS surface is unchanged.
          "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          // Monaco assigns to element.style.* and setAttribute('style', ...)
          // internally; mirror the relaxation on style-src-attr.
          "style-src-attr": ["'unsafe-inline'"],
          "upgrade-insecure-requests": [],
          "img-src": ["'self'", "data:", "https:", "blob:"],
          "connect-src": ["'self'", "https://api.1min.ai"],
          "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
          "object-src": ["'none'"],
          "media-src": ["'self'"],
          "frame-src": ["'none'"],
          "worker-src": ["'self'", "blob:"],
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // CORS middleware: Restrict access exclusively to localhost/127.0.0.1 origins
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin) {
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin);
      if (isLocalhost) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, x-local-bff-token, Authorization, Cookie",
        );
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Max-Age", "86400");
      } else {
        logger.warn("CORS request blocked from origin", { origin });
        return res.status(403).json({ error: "CORS request blocked: Only localhost origins are allowed" });
      }
    }
    if (req.method === "OPTIONS") {
      // B-3: Even for preflight, verify the requested origin is localhost.
      if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(origin)) {
        logger.warn("CORS preflight blocked from origin", { origin });
        return res.status(403).json({ error: "CORS preflight blocked: Only localhost origins are allowed" });
      }
      return res.sendStatus(204);
    }
    next();
  });

  // Security headers for all responses
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  // A-6: Register health endpoint before rate-limit middleware so it's always accessible.
  app.use("/api/health", (_req, res) => {
    const status = getModelSyncStatus();
    res.json({
      ok: true,
      service: "one-min-ai-monaco-client",
      models: {
        // QUAL-2: `ok` is the single source of truth for model sync status.
        // `syncFailed: !ok` was redundant and could cause confusion if the two
        // fields ever got out of sync.
        ok: status.ok,
        lastSync: status.lastSync,
        error: status.error,
        source: status.source || "fallback",
      },
    });
  });

  if (enableRateLimit) {
    // Apply specific (higher) rate limits for high-frequency API endpoints first
    // so they take precedence over the global default limit.
    app.use("/api/chat", aiChatRateLimit);
    app.use("/api/code", autocompleteRateLimit);
    // Global default limit for all other routes (including non-API static)
    app.use(buildRateLimit());
  }

  app.use(logger.requestLogger());

  let cachedHtml = null;
  const loadCachedHtml = () => {
    if (cachedHtml && process.env.NODE_ENV === "production") return cachedHtml;
    const htmlPath = path.join(__dirname, "public", "index.html");
    cachedHtml = fs.readFileSync(htmlPath, "utf8");
    return cachedHtml;
  };

  // Provide local BFF token to authenticated clients
  app.get("/api/token", (req, res) => {
    // BFFトークンをレスポンス平文で返却することを廃止し、XSS攻撃による窃取を防ぎます。
    // セッション認証は完全に Cookie で完結します。
    res.json({ token: "" });
  });

  // Serve index.html (before express.json() since this is a GET)
  app.get(["/", "/index.html"], (req, res) => {
    try {
      let html = loadCachedHtml();

      const nonce = res.locals.nonce;

      // Inject nonce into all <script> tags
      html = html.replace(/<script\b/g, `<script nonce="${nonce}"`);

      // Expose nonce to client-side JS via meta tag (for dynamic <style> elements)
      html = html.replace(
        /<head(\s*[^>]*)>/i,
        (match, attrs) => `<head${attrs}><meta name="csp-nonce" content="${nonce}">`,
      );

      // Set the token as HttpOnly cookie (CSRF mitigation).
      // We no longer inject data-bff-token into the DOM to prevent exposure.
      if (requireLocalAuth) {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        res.cookie("__bff_session", localAuthToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "Strict",
          maxAge: ONE_DAY_MS,
        });
      }

      res.send(html);
    } catch (e) {
      res.status(500).send("Error loading index.html");
    }
  });

  // #1: Block source map files before they reach express.static
  app.use((req, _res, next) => {
    if (req.path.endsWith(".map")) {
      const err = new Error("Source map access denied");
      err.status = 403;
      return next(err);
    }
    next();
  });

  app.use(
    express.static(path.join(__dirname, "public"), {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js")) {
          res.setHeader("X-Content-Type-Options", "nosniff");
        }
      },
      fallthrough: true,
    }),
  );

  const protectedApiAuth = localBffAuth({
    requireToken: requireLocalAuth,
    authToken: localAuthToken,
  });

  app.post("/api/assets/upload", protectedApiAuth, (req, res, next) => {
    upload.single("asset")(req, res, (err) => {
      if (err) return next(mapMulterError(err));
      handleAssetUpload(req, res, next);
    });
  });

  // Apply express.json() after the asset upload route (which uses multer)
  // so it never consumes multipart body streams (Q-9).
  app.use(express.json({ limit: serverConfig.maxJsonBodySize }));

  // B-5: Single auth layer at /api level. Sub-routes are mounted inside one protected router
  // to avoid double invocation of protectedApiAuth.
  const protectedRouter = express.Router();
  protectedRouter.get("/assets/proxy", async (req, res, next) => {
    try {
      const { url, key } = req.query;
      if (!url && !key) {
        return res.status(400).json({ error: "url or key is required" });
      }

      let targetUrl = url;
      if (!targetUrl && key) {
        targetUrl = `https://asset.1min.ai/${key.replace(/^\//, "")}`;
      }

      const parsed = new URL(targetUrl);
      const allowedHosts = ["asset.1min.ai", "api.1min.ai"];
      const isVirtualHostS3 =
        /^asset\.1min\.ai\.s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) ||
        /^asset\.1min\.ai\.s3-accelerate\.amazonaws\.com$/i.test(parsed.hostname) ||
        /^asset\.1min\.ai\.s3\.dualstack\.[\w-]+\.amazonaws\.com$/i.test(parsed.hostname);

      const isPathStyleS3 =
        /^s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) &&
        parsed.pathname.startsWith("/asset.1min.ai/");

      const isAllowedHost =
        allowedHosts.some((h) => parsed.hostname === h) || isVirtualHostS3 || isPathStyleS3;
      if (!isAllowedHost) {
        return res.status(403).json({ error: "Access denied: Untrusted asset host" });
      }

      const abort = buildAssetProxyAbortSignal(serverConfig.assetProxyTimeoutMs);
      let response;
      try {
        response = await fetch(targetUrl, { signal: abort.signal });
      } catch (err) {
        abort.clear();
        if (err?.name === "AbortError") {
          return res.status(504).json({ error: "Asset proxy request timed out" });
        }
        throw err;
      }

      if (!response.ok) {
        abort.clear();
        return res.status(response.status).json({ error: `Failed to fetch asset: ${response.statusText}` });
      }

      const contentLength = parseContentLength(response.headers.get("content-length"));
      if (contentLength !== null && contentLength > serverConfig.assetProxyMaxSize) {
        abort.clear();
        return res.status(413).json({ error: "Asset proxy response too large" });
      }

      const contentType = response.headers.get("content-type") || "application/octet-stream";
      // HTMLおよびスクリプトタイプのレスポンスをブロックしてXSSを防止
      if (/text\/html|application\/javascript|text\/javascript/i.test(contentType)) {
        abort.clear();
        return res.status(403).json({ error: "Unsupported content type from upstream" });
      }
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Cache-Control は ETag 等との共存を想定し、マイルドなキャッシュに変更
      res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");

      try {
        if (response.body) {
          const limitedBody = response.body.pipeThrough(
            createByteLimitTransform(serverConfig.assetProxyMaxSize),
          );
          await pipeline(Readable.fromWeb(limitedBody), res);
        } else {
          res.end();
        }
      } finally {
        abort.clear();
      }
    } catch (err) {
      if (err?.name === "ProxySizeLimitError") {
        if (!res.headersSent) {
          return res.status(err.status).json({ error: "Asset proxy response too large" });
        }
        res.destroy(err);
        return;
      }
      next(err);
    }
  });

  protectedRouter.use("/", aiRoutes);
  protectedRouter.use("/fs", fsRoutes);
  protectedRouter.use("/agent", agentRoutes);
  // Mount the agent-chat route at /agent so the /chat sub-route is at /api/agent/chat
  protectedRouter.use("/agent", agentChatRoutes);
  app.use("/api", protectedApiAuth, protectedRouter);

  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === "development";

    logger.error(`API Error: ${status}`, {
      error: err.message,
      status,
      method: req.method,
      url: req.originalUrl,
      payload: isDev ? err.payload : undefined,
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

function validateEnvironment() {
  const required = ["ONE_MIN_AI_API_KEY"];
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key].includes("your_1min_ai_api_key_here"),
  );
  if (missing.length > 0) {
    logger.error("Missing required environment variables", { missing });
    process.exit(1);
  }

  // Warning for important but optional configs
  if (!process.env.ALLOWED_ROOTS) {
    logger.warn("ALLOWED_ROOTS is not set. Defaulting to project root only.");
  }
  if (!process.env.LOCAL_BFF_AUTH_TOKEN) {
    logger.warn(
      "LOCAL_BFF_AUTH_TOKEN not set. A random token will be generated on each restart. " +
        "Browser sessions will be invalidated when the server restarts. " +
        "Set LOCAL_BFF_AUTH_TOKEN in .env for persistent sessions.",
    );
  }
}

if (process.env.NODE_ENV !== "test") {
  validateEnvironment();
  initModels()
    .then(() => {
      const server = createApp().listen(serverConfig.port, "127.0.0.1", () => {
        logger.info(`1min.ai Monaco client running: http://127.0.0.1:${serverConfig.port}`);
        logger.info("Server configuration", {
          port: serverConfig.port,
          maxFileSize: serverConfig.maxFileSize,
          apiTimeout: serverConfig.apiTimeout,
          apiRetryAttempts: serverConfig.apiRetryAttempts,
        });
      });

      // Allow up to 10 minutes for slow coding/agent operations
      server.timeout = 600000;
      server.requestTimeout = 600000;

      // Graceful shutdown handling
      const shutdown = () => {
        logger.info("Shutdown signal received. Closing HTTP server...");
        server.close(() => {
          logger.info("HTTP server closed. Exiting process.");
          process.exit(0);
        });
        // 強制終了タイムアウトを設定 (10秒)
        setTimeout(() => {
          logger.warn("Forcing shutdown after timeout.");
          process.exit(1);
        }, 10000).unref();
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((err) => {
      logger.error("Failed to initialize models or start server", { error: err.message });
      process.exit(1);
    });
}
