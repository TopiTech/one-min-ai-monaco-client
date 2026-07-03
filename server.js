import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { callOneMin, normalizeAssetResponse } from './utils/api-client.js';
import { serverConfig } from './config/server.js';
import logger, { initLogger, sanitizeUrlForLogging } from './utils/logger.js';
import { validateBufferMimeType, getExtensionFromMimeType } from './utils/mime-guard.js';
import fs from 'fs';
import fsp from 'fs/promises';
import { sanitizePayload } from './utils/sanitize.js';
import { createLocalAuthToken, localBffAuth } from './middlewares/auth.js';
import {
  hostHeaderValidation,
  generateNonce,
  configureCSP,
  corsHeaders,
  securityHeaders,
} from './middlewares/security.js';
import { assetProxyHandler } from './services/asset-proxy.js';
import { upload, mapMulterError, UPLOAD_TMP_DIR } from './middlewares/upload.js';
import { startupCleanup, startPeriodicCleanup } from './services/tmp-cleanup.js';

// Replace the env-var-based default singleton with the validated serverConfig.
// This ensures LOG_LEVEL, LOG_TO_FILE, and LOG_FILE are all parsed and clamped
// consistently (e.g. LOG_LEVEL "info" → parseLogLevel, LOG_TO_FILE "true" →
// parseBoolean).
initLogger(serverConfig);

import aiRoutes from './routes/ai.js';
import fsRoutes from './routes/fs.js';
import agentRoutes, { flushPendingWriters, initAgentState } from './routes/agent.js';
import agentChatRoutes from './routes/agent-chat.js';
import { initModels, getModelSyncStatus } from './config/models.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Authentication and proxy helpers have been modularized to middlewares/auth.js, middlewares/security.js, and services/asset-proxy.js.

// QUAL-1: Renamed parameter from "config" to "overrides" to avoid confusion
// with the module-level `serverConfig` object. This parameter carries per-route
// overrides (e.g. a tighter `max`) that are spread on top of the defaults.
function buildRateLimit(overrides = {}) {
  return rateLimit({
    windowMs: serverConfig.rateLimitWindowMs,
    max: serverConfig.rateLimitMax,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
    ...overrides,
  });
}

const autocompleteRateLimit = buildRateLimit({ max: serverConfig.rateLimitAutocompleteMax });
const aiChatRateLimit = buildRateLimit({ max: serverConfig.rateLimitChatMax });

function normalizePayloadError(err) {
  if (!err?.payload) return null;
  if (typeof err.payload === 'string') return err.payload;
  if (typeof err.payload === 'object') {
    // Extract a safe, short error description from known upstream error shapes.
    // This avoids leaking raw payload data while still giving the client a
    // human-readable failure reason.
    const msg =
      err.payload.error ||
      err.payload.message ||
      err.payload.aiRecord?.aiRecordDetail?.errorMessage ||
      err.payload.aiRecord?.errorMessage ||
      err.payload.errorMessage;
    if (msg && typeof msg === 'string') return msg;
    return 'Upstream request failed (see details for sanitized payload)';
  }
  return null;
}

async function handleAssetUpload(req, res, next) {
  const tmpFilePath = req.file?.path;
  try {
    if (!req.file) return res.status(400).json({ error: 'asset file is required' });

    if (req.file.size > 0) {
      // S-1: with disk storage, validate the on-disk buffer to avoid
      // loading the whole file into memory again. Read just the first
      // 8KB which is enough to cover the magic byte checks.
      const headBuf = Buffer.alloc(8192);
      const fd = await fsp.open(tmpFilePath, 'r');
      let bytesRead = 0;
      try {
        const result = await fd.read(headBuf, 0, 8192, 0);
        bytesRead = result.bytesRead;
      } finally {
        await fd.close();
      }
      const head = headBuf.subarray(0, bytesRead);
      if (!validateBufferMimeType(head, req.file.mimetype)) {
        logger.warn('Asset upload rejected: MIME type signature mismatch', {
          filename: req.file.originalname,
          mimetype: req.file.mimetype,
        });
        return res.status(415).json({
          error: `Unsupported file type or signature mismatch: ${req.file.mimetype}`,
        });
      }
    }

    logger.info('Processing asset upload', {
      filename: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
    });

    let safeName = path
      .basename(req.file.originalname || '')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .substring(0, 255);

    const ext = path.extname(safeName);
    if (!safeName || !ext) {
      const fallbackExt = getExtensionFromMimeType(req.file.mimetype);
      const base = safeName || 'upload';
      safeName = base + fallbackExt;
    }

    // A-1: Stream the file directly from disk into FormData using openAsBlob
    // if available (Node 19.8+). This prevents OOM spikes when uploading
    // large files compared to reading the entire buffer into memory.
    // Falls back to in-memory Blob if openAsBlob fails (e.g. on Windows).
    let assetBlob;
    if (typeof fs.openAsBlob === 'function') {
      try {
        assetBlob = await fs.openAsBlob(tmpFilePath);
      } catch {
        // openAsBlob may fail on certain OS/filesystem combinations;
        // fall through to the in-memory fallback below.
        assetBlob = null;
      }
    }
    if (!assetBlob) {
      const headFd = await fsp.open(tmpFilePath, 'r');
      try {
        const stat = await headFd.stat();
        const buf = Buffer.alloc(stat.size);
        await headFd.read(buf, 0, stat.size, 0);
        assetBlob = new Blob([buf], { type: req.file.mimetype || 'application/octet-stream' });
      } finally {
        await headFd.close();
      }
    }

    const formData = new FormData();
    formData.append('asset', assetBlob, safeName);

    const data = await callOneMin('/api/assets', {
      method: 'POST',
      body: formData,
      idempotent: false,
    });
    const normalized = normalizeAssetResponse(data);
    delete normalized.raw;
    if (!normalized.key) {
      logger.warn('Asset upload completed without a usable asset key', {
        filename: req.file.originalname,
        responseKeys: Object.keys(data || {}),
      });
    }

    logger.info('Asset upload successful', { filename: req.file.originalname });
    res.json(normalized);
  } catch (err) {
    logger.error('Asset upload failed', { error: err.message });
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
    requireLocalAuth = process.env.NODE_ENV !== 'test',
    authToken,
    localAuthToken: localAuthTokenOption,
    enableRateLimit = process.env.NODE_ENV !== 'test',
  } = options;
  const localAuthToken =
    localAuthTokenOption ?? authToken ?? process.env.LOCAL_BFF_AUTH_TOKEN ?? createLocalAuthToken();

  const app = express();

  // Host header validation to prevent DNS Rebinding
  app.use(hostHeaderValidation);

  // Per-request nonce for CSP
  app.use(generateNonce);

  app.use(configureCSP());

  // CORS middleware: Restrict access exclusively to allowed origins
  app.use(corsHeaders);

  // Security headers for all responses
  app.use(securityHeaders);

  // A-6: Register health endpoint before rate-limit middleware so it's always accessible.
  app.use('/api/health', (_req, res) => {
    const status = getModelSyncStatus();
    res.json({
      ok: true,
      service: 'one-min-ai-monaco-client',
      models: {
        // QUAL-2: `ok` is the single source of truth for model sync status.
        // `syncFailed: !ok` was redundant and could cause confusion if the two
        // fields ever got out of sync.
        ok: status.ok,
        lastSync: status.lastSync,
        error: status.error,
        source: status.source || 'fallback',
      },
    });
  });

  if (enableRateLimit) {
    // Apply specific (higher) rate limits for high-frequency API endpoints first
    // so they take precedence over the global default limit.
    app.use('/api/chat', aiChatRateLimit);
    app.use('/api/code', autocompleteRateLimit);
    // Global default limit for all other routes (including non-API static)
    app.use(buildRateLimit());
  }

  app.use(logger.requestLogger());

  let cachedHtml = null;
  const loadCachedHtml = () => {
    if (cachedHtml && process.env.NODE_ENV === 'production') return cachedHtml;
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    cachedHtml = fs.readFileSync(htmlPath, 'utf8');
    return cachedHtml;
  };

  // Serve index.html (before express.json() since this is a GET)
  app.get(['/', '/index.html'], (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
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
      // Restrict scope to /api using path parameter.
      if (requireLocalAuth) {
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;
        const csrfToken = crypto.randomBytes(24).toString('hex');
        res.cookie('__bff_session', localAuthToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'Strict',
          maxAge: ONE_DAY_MS,
          path: '/api',
        });
        res.cookie('__bff_csrf', csrfToken, {
          httpOnly: false,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'Strict',
          maxAge: ONE_DAY_MS,
          path: '/',
        });
      }

      res.send(html);
    } catch {
      res.status(500).send('Error loading index.html');
    }
  });

  // #1: Block source map files before they reach express.static
  app.use((req, _res, next) => {
    if (req.path.endsWith('.map')) {
      const err = new Error('Source map access denied');
      err.status = 403;
      return next(err);
    }
    next();
  });

  app.use(
    express.static(path.join(__dirname, 'public'), {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js')) {
          res.setHeader('X-Content-Type-Options', 'nosniff');
        }
        // Cache immutable assets aggressively: Monaco vendor files, marked, DOMPurify
        if (/(\/|\\)(vs|vendor)(\/|\\)/.test(filePath)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
      fallthrough: true,
    }),
  );

  const protectedApiAuth = localBffAuth({
    requireToken: requireLocalAuth,
    authToken: localAuthToken,
  });

  app.post('/api/assets/upload', protectedApiAuth, (req, res, next) => {
    upload.single('asset')(req, res, (err) => {
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
  protectedRouter.get('/assets/proxy', assetProxyHandler);

  protectedRouter.use('/', aiRoutes);
  protectedRouter.use('/fs', fsRoutes);
  protectedRouter.use('/agent', agentRoutes);
  // Mount the agent-chat route at /agent so the /chat sub-route is at /api/agent/chat
  protectedRouter.use('/agent', agentChatRoutes);
  app.use('/api', protectedApiAuth, protectedRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const isDev = process.env.NODE_ENV === 'development';
    const isLocalHost = isDev || /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get('host') || '');
    // In production (NODE_ENV=production) or when NODE_ENV is unset, never
    // expose stack traces or payloads to remote clients unless explicitly enabled
    // and requested from localhost.  Read NODE_ENV dynamically so test-time
    // overrides (process.env.NODE_ENV = 'production') take effect immediately
    // instead of relying on the module-load-time serverConfig snapshot.
    const dynamicExposeErrorDetails =
      process.env.EXPOSE_ERROR_DETAILS !== undefined
        ? String(process.env.EXPOSE_ERROR_DETAILS).toLowerCase() === 'true'
        : isDev;
    const exposeDetails = dynamicExposeErrorDetails && isLocalHost;

    const logLevel = status >= 500 ? 'error' : 'warn';
    logger[logLevel](`API Error: ${status}`, {
      error: err.message,
      status,
      method: req.method,
      url: sanitizeUrlForLogging(req.originalUrl),
      payload: exposeDetails ? err.payload : undefined,
      stack: exposeDetails ? err.stack : undefined,
    });

    const isProduction =
      process.env.NODE_ENV === 'production' ||
      (!process.env.NODE_ENV && process.env.EXPOSE_ERROR_DETAILS !== 'true');
    const exposeErrorText = status < 500 || !isProduction || isLocalHost;

    res.status(status).json({
      error: exposeErrorText
        ? normalizePayloadError(err) || err.message || 'Internal Server Error'
        : 'Internal Server Error',
      code: err.code || 'UNKNOWN_ERROR',
      details: exposeDetails ? sanitizePayload(err.payload) || null : null,
      stack: exposeDetails ? err.stack : undefined,
    });
  });

  return app;
}

function validateEnvironment() {
  const required = ['ONE_MIN_AI_API_KEY'];
  const missing = required.filter(
    (key) => !process.env[key] || process.env[key].includes('your_1min_ai_api_key_here'),
  );
  if (missing.length > 0) {
    logger.error('Missing required environment variables', { missing });
    process.exit(1);
  }

  if (process.env.NODE_ENV === 'production' && serverConfig.exposeErrorDetails) {
    logger.warn(
      'EXPOSE_ERROR_DETAILS is set to true in production mode. This may leak sensitive stack traces to localhost clients.',
    );
  }

  if (serverConfig.enableCommandExecution && serverConfig.agentAutoApprove) {
    const sandboxConfirmed =
      String(process.env.ALLOW_UNSAFE_AGENT_AUTO_APPROVE || '').toLowerCase() === 'true';
    if (!sandboxConfirmed) {
      logger.error(
        'Refusing to start: ENABLE_COMMAND_EXECUTION=true and AGENT_AUTO_APPROVE=true require a sandbox confirmation. ' +
          'Set ALLOW_UNSAFE_AGENT_AUTO_APPROVE=true only inside an isolated sandbox or Docker environment.',
      );
      process.exit(1);
    }
    logger.warn(
      'Unsafe agent auto-approve override enabled. Ensure this server is running only inside an isolated sandbox.',
    );
  }

  // Warning for important but optional configs
  if (!process.env.ALLOWED_ROOTS) {
    logger.warn('ALLOWED_ROOTS is not set. Defaulting to project root only.');
  }
  if (!process.env.LOCAL_BFF_AUTH_TOKEN) {
    logger.warn(
      'LOCAL_BFF_AUTH_TOKEN not set. A random token will be generated on each restart. ' +
        'Browser sessions will be invalidated when the server restarts. ' +
        'Set LOCAL_BFF_AUTH_TOKEN in .env for persistent sessions.',
    );
  }
}

if (process.env.NODE_ENV !== 'test') {
  validateEnvironment();
  // E-1: Startup cleanup to remove orphaned temporary files from previous runs
  startupCleanup(UPLOAD_TMP_DIR);
  // B-6: Periodic cleanup for orphaned temporary files during runtime
  const cleanupInterval = startPeriodicCleanup(UPLOAD_TMP_DIR);
  cleanupInterval.unref();
  Promise.all([initModels(), initAgentState()])
    .then(() => {
      const server = createApp().listen(serverConfig.port, '127.0.0.1', () => {
        logger.info(`1min.ai Monaco client running: http://127.0.0.1:${serverConfig.port}`);
        logger.info('Server configuration', {
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
        logger.info('Shutdown signal received. Closing HTTP server...');
        flushPendingWriters()
          .catch((err) => {
            logger.error('Failed to flush pending writers during shutdown', {
              error: err.message,
            });
          })
          .finally(() => {
            server.close(() => {
              logger.info('HTTP server closed. Exiting process.');
              process.exit(0);
            });
          });
        // 強制終了タイムアウトを設定 (10秒)
        setTimeout(() => {
          logger.warn('Forcing shutdown after timeout.');
          process.exit(1);
        }, 10000).unref();
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((err) => {
      logger.error('Failed to initialize models or start server', { error: err.message });
      process.exit(1);
    });
}
