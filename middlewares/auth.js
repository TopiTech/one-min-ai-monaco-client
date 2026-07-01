import crypto from 'crypto';
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
      list[name] = value;
    }
  });
  return list;
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
    const cookieToken = cookies['__bff_session'];

    const isCookieOk = cookieToken && compareAuthToken(cookieToken, authToken);
    const isHeaderOk = headerToken && compareAuthToken(headerToken, authToken);
    const tokenOk = isCookieOk && isHeaderOk;

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
      if (!secFetchSite && !origin && !referer) return true;
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
