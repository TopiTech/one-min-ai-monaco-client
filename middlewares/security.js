import helmet from 'helmet';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { isAndroidPlatform } from '../config/server.js';

const customOrigins = (process.env.ALLOWED_CORS_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOWED_CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOWED_CORS_HEADERS = 'Content-Type, x-local-bff-token';

// Parse custom origins into normalized origin strings for reliable comparison.
// Supports both full URLs (http://myapp.local:8080) and bare hosts (myapp.local).
const normalizedCustomOrigins = customOrigins
  .map((o) => {
    try {
      const u = new URL(o.includes('://') ? o : `http://${o}`);
      return u.origin;
    } catch {
      return null;
    }
  })
  .filter(Boolean);

export function isAllowedHostHeader(hostStr) {
  if (/^127\.0\.0\.1(?::\d+)?$/i.test(hostStr) || /^localhost(?::\d+)?$/i.test(hostStr)) return true;
  const normalizedHost = String(hostStr).toLowerCase();
  for (const o of customOrigins) {
    try {
      if (new URL(o.includes('://') ? o : `http://${o}`).host.toLowerCase() === normalizedHost) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function isAllowedOriginStr(originStr) {
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(originStr)) return true;
  let normalized = originStr;
  try {
    if (/^https?:\/\//i.test(originStr)) {
      normalized = new URL(originStr).origin;
    }
  } catch {
    // keep raw originStr
  }
  if (normalizedCustomOrigins.includes(normalized)) return true;
  // Fallback: exact match against raw custom origins
  return customOrigins.includes(originStr);
}

// Host header validation to prevent DNS Rebinding
export function hostHeaderValidation(req, res, next) {
  const host = req.get('host');
  if (!host) {
    return res.status(400).json({ error: 'Host header is required' });
  }
  if (!isAllowedHostHeader(host)) {
    logger.warn('Blocked request with suspicious Host header', { host });
    return res.status(403).json({ error: 'Access denied: Invalid Host header' });
  }
  next();
}

// Per-request nonce middleware
export function generateNonce(req, res, next) {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
}

// CSP configuration middleware
// SEC: script-src uses nonce-based policy. When a nonce is present,
// 'unsafe-inline' is ignored by browsers, blocking inline scripts without the nonce.
// style-src requires 'unsafe-inline' for Monaco's CSSOM insertRule operations.
// style-src-attr uses nonce for inline style attribute protection.
export function configureCSP() {
  const isAndroid = isAndroidPlatform();
  return helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", (_req, /** @type {any} */ res) => `'nonce-${res.locals.nonce}'`, 'blob:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'style-src-attr': ["'unsafe-inline'"],
        // Android WebView loads the local BFF over plain HTTP loopback (127.0.0.1);
        // null deletes helmet's default upgrade-insecure-requests directive.
        'upgrade-insecure-requests': isAndroid ? null : [],
        'img-src': ["'self'", 'data:', 'https:', 'blob:'],
        'connect-src': ["'self'"],
        'font-src': ["'self'", 'data:', 'https://fonts.gstatic.com'],
        'object-src': ["'none'"],
        'media-src': ["'self'"],
        'frame-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'worker-src': ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: 'deny' },
    ...(isAndroid ? { hsts: false } : {}),
  });
}

// CORS middleware
export function corsHeaders(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    if (isAllowedOriginStr(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      const existingVary = res.getHeader?.('Vary');
      if (!existingVary) {
        res.setHeader('Vary', 'Origin');
      } else {
        const varyStr = Array.isArray(existingVary) ? existingVary.join(', ') : String(existingVary);
        if (!varyStr.toLowerCase().split(',').map((s) => s.trim()).includes('origin')) {
          res.setHeader('Vary', `${varyStr}, Origin`);
        }
      }
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_CORS_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_CORS_HEADERS);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Max-Age', '86400');
    } else {
      logger.warn('CORS request blocked from origin', { origin });
      return res.status(403).json({ error: 'CORS request blocked: Origin not allowed' });
    }
  }
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
}

// Security headers middleware (Additional headers)
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');

  // Apply Strict-Transport-Security (HSTS) only in non-development/test environments
  // to avoid breaking local HTTP environments (including Android local BFF loopback).
  if (process.env.NODE_ENV === 'production' && !isAndroidPlatform()) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
