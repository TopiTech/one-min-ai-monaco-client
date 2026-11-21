import { serverConfig } from '../config/server.js';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export class ProxySizeLimitError extends Error {
  constructor(limitBytes) {
    super(`Asset proxy response exceeds maximum size of ${limitBytes} bytes`);
    this.name = 'ProxySizeLimitError';
    this.status = 413;
    this.code = 'ASSET_PROXY_RESPONSE_TOO_LARGE';
  }
}

export function buildAssetProxyAbortSignal(timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    isTimedOut: () => timedOut,
    clear: () => clearTimeout(timeoutId),
  };
}

export function parseContentLength(value) {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

export function createByteLimitTransform(limitBytes) {
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

export function isTrustedAssetUrl(parsed) {
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return false;
  }
  const apiHost = new URL(serverConfig.apiBaseUrl).hostname;
  const assetHost = new URL(serverConfig.assetBaseUrl).hostname;
  const oneForAllHost = new URL(serverConfig.oneForAllApiBaseUrl).hostname;
  const allowedHosts = [assetHost, apiHost, 'storage.1min.ai', oneForAllHost];

  if (allowedHosts.some((h) => parsed.hostname === h)) {
    return true;
  }

  const buckets = [
    serverConfig.s3Bucket,
    ...(Array.isArray(serverConfig.oneForAllS3Buckets) ? serverConfig.oneForAllS3Buckets : []),
  ].filter(Boolean);

  for (const bucket of buckets) {
    const escapedBucket = bucket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const isVirtualHostS3 =
      new RegExp(`^${escapedBucket}\\.s3(?:\\.[\\w-]+)?\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
      new RegExp(`^${escapedBucket}\\.s3-accelerate\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
      new RegExp(`^${escapedBucket}\\.s3\\.dualstack\\.[\\w-]+\\.amazonaws\\.com$`, 'i').test(
        parsed.hostname,
      );
    const isPathStyleS3 =
      /^s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) &&
      (parsed.pathname === `/${bucket}` || parsed.pathname.startsWith(`/${bucket}/`));
    if (isVirtualHostS3 || isPathStyleS3) {
      return true;
    }
  }

  return false;
}

export async function assetProxyHandler(req, res, next) {
  try {
    const { url: rawUrl, key: rawKey } = req.query;
    if (
      (rawUrl !== undefined && typeof rawUrl !== 'string') ||
      (rawKey !== undefined && typeof rawKey !== 'string')
    ) {
      return res.status(400).json({ error: 'url and key must be strings' });
    }
    const url = typeof rawUrl === 'string' ? rawUrl : '';
    const key = typeof rawKey === 'string' ? rawKey : '';
    if (!url && !key) {
      return res.status(400).json({ error: 'url or key is required' });
    }

    let targetUrl = url;
    if (!targetUrl && key) {
      targetUrl = `${serverConfig.assetBaseUrl}/${key.replace(/^\//, '')}`;
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only http and https protocols are supported' });
    }

    if (!isTrustedAssetUrl(parsed)) {
      return res.status(403).json({ error: 'Access denied: Untrusted asset host' });
    }

    const abort = buildAssetProxyAbortSignal(serverConfig.assetProxyTimeoutMs);
    let clientClosed = false;
    const onClose = () => {
      if (!res.writableEnded) {
        clientClosed = true;
        abort.abort();
      }
    };
    res.on?.('close', onClose);

    let response;
    let currentUrl = targetUrl;
    let redirectCount = 0;
    const MAX_REDIRECTS = 3;

    try {
      while (true) {
        try {
          /** @type {RequestInit} */
          const fetchOpts = { signal: abort.signal, redirect: 'manual' };
          if (req.headers?.range) {
            fetchOpts.headers = { Range: String(req.headers.range) };
          }
          response = await fetch(currentUrl, fetchOpts);
        } catch (err) {
          if (clientClosed || res.destroyed || res.writableEnded) {
            return;
          }
          if (err?.name === 'AbortError' || abort.isTimedOut()) {
            return res.status(504).json({ error: 'Asset proxy request timed out' });
          }
          throw err;
        }

        if ([301, 302, 307, 308].includes(response.status) && response.headers.has('location')) {
          const locationHeader = response.headers.get('location');
          await response.body?.cancel?.().catch(() => {});
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            return res.status(502).json({ error: 'Too many redirects from upstream asset host' });
          }
          let redirectTarget;
          try {
            redirectTarget = new URL(locationHeader, currentUrl);
          } catch {
            return res.status(502).json({ error: 'Invalid redirect location from upstream' });
          }
          if (!isTrustedAssetUrl(redirectTarget)) {
            return res.status(403).json({ error: 'Access denied: Untrusted redirect host' });
          }
          currentUrl = redirectTarget.toString();
          continue;
        }
        break;
      }

      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        return res.status(response.status).json({ error: `Failed to fetch asset: ${response.statusText}` });
      }

      const contentLength = parseContentLength(response.headers.get('content-length'));
      if (contentLength !== null && contentLength > serverConfig.assetProxyMaxSize) {
        await response.body?.cancel?.().catch(() => {});
        return res.status(413).json({ error: 'Asset proxy response too large' });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';
      if (/text\/html|application\/javascript|text\/javascript/i.test(contentType)) {
        await response.body?.cancel?.().catch(() => {});
        return res.status(403).json({ error: 'Unsupported content type from upstream' });
      }
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300, stale-while-revalidate=600');
      if (response.status === 206) {
        res.status(206);
        const contentRange = response.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);
        const acceptRanges = response.headers.get('accept-ranges');
        if (acceptRanges) res.setHeader('Accept-Ranges', acceptRanges);
      }

      if (response.body) {
        const limitedBody = response.body.pipeThrough(
          createByteLimitTransform(serverConfig.assetProxyMaxSize),
        );
        await pipeline(Readable.fromWeb(limitedBody), res);
      } else {
        res.end();
      }
    } finally {
      res.off?.('close', onClose);
      abort.clear();
    }
  } catch (err) {
    if (res.destroyed || res.writableEnded) {
      return;
    }
    if (err?.name === 'ProxySizeLimitError') {
      if (!res.headersSent) {
        return res.status(err.status).json({ error: 'Asset proxy response too large' });
      }
      res.destroy(err);
      return;
    }
    next(err);
  }
}
