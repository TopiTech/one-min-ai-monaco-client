import helmet from 'helmet';
import crypto from 'crypto';
import logger from '../utils/logger.js';

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
  for (const o of customOrigins) {
    try {
      if (new URL(o.includes('://') ? o : `http://${o}`).host === hostStr) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

export function isAllowedOriginStr(originStr) {
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/i.test(originStr)) return true;
  if (normalizedCustomOrigins.includes(originStr)) return true;
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
export function configureCSP() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", (_req, /** @type {any} */ res) => `'nonce-${res.locals.nonce}'`, 'blob:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'style-src-attr': ["'unsafe-inline'"],
        'upgrade-insecure-requests': [],
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
  });
}

// CORS middleware
export function corsHeaders(req, res, next) {
  const origin = req.get('origin');
  if (origin) {
    if (isAllowedOriginStr(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
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
    if (origin && !isAllowedOriginStr(origin)) {
      logger.warn('CORS preflight blocked from origin', { origin });
      return res.status(403).json({ error: 'CORS preflight blocked: Origin not allowed' });
    }
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
  // to avoid breaking local HTTP environments.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}
