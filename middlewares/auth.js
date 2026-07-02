import crypto from 'crypto';
import cookie from 'cookie';
import logger from '../utils/logger.js';

export function createLocalAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

export function compareAuthToken(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string') return false;

  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

export function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  try {
    return cookie.parse(cookieHeader);
  } catch {
    return {};
  }
}

export function localBffAuth({ requireToken = true, authToken } = {}) {
  if (!requireToken) {
    return (_req, _res, next) => next();
  }

  if (!authToken) {
    throw new Error(
      'localBffAuth: authToken must be provided explicitly when requireToken=true. ' +
        'Set LOCAL_BFF_AUTH_TOKEN in .env or pass localAuthToken option to createApp().',
    );
  }

  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = req.get('x-local-bff-token');
    const cookieSessionToken = cookies['__bff_session'];
    const cookieCsrfToken = cookies['__bff_csrf'];

    const isSessionOk = cookieSessionToken && compareAuthToken(cookieSessionToken, authToken);
    
    // GET/HEAD requests are idempotent and do not need CSRF protection.
    // Standard HTML elements (e.g. <img> tags loading images from the proxy)
    // cannot attach custom HTTP headers.
    const isSafeMethod = req.method === 'GET' || req.method === 'HEAD';
    const isCsrfOk = isSafeMethod || (headerToken && cookieCsrfToken && compareAuthToken(headerToken, cookieCsrfToken));
    const tokenOk = isSessionOk && isCsrfOk;

    if (!tokenOk) {
      const err = new Error('Local BFF authentication required or invalid token');
      err.status = 403;
      return next(err);
    }

    const origin = req.get('origin');
    const host = req.get('host');
    const secFetchSite = req.get('sec-fetch-site');
    const referer = req.get('referer');

    if (secFetchSite === 'cross-site') {
      const err = new Error('Cross-origin requests are not allowed');
      err.status = 403;
      return next(err);
    }

    const isSameOrigin = (() => {
      if (secFetchSite === 'same-origin' || secFetchSite === 'none') return true;
      const checkUrl = (urlStr) => {
        try {
          return host && new URL(urlStr).host === host;
        } catch {
          return false;
        }
      };
      if (origin && checkUrl(origin)) return true;
      if (referer && checkUrl(referer)) return true;

      // S-3 Fix: If there is no sec-fetch-site and no same-origin header (Origin/Referer),
      // allow it ONLY in development/test environment to avoid CSRF on production where headers
      // might have been stripped.
      if (!secFetchSite && !origin && !referer) {
        return process.env.NODE_ENV !== 'production';
      }
      return false;
    })();

    if (!isSameOrigin) {
      const err = new Error('Cross-origin requests are not allowed without a valid token');
      err.status = 403;
      return next(err);
    }

    return next();
  };
}
