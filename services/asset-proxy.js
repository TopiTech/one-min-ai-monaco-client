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
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
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
  const allowedHosts = [assetHost, apiHost];

  const escapedBucket = serverConfig.s3Bucket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const isVirtualHostS3 =
    new RegExp(`^${escapedBucket}\\.s3(?:\\.[\\w-]+)?\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
    new RegExp(`^${escapedBucket}\\.s3-accelerate\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
    new RegExp(`^${escapedBucket}\\.s3\\.dualstack\\.[\\w-]+\\.amazonaws\\.com$`, 'i').test(parsed.hostname);

  const isPathStyleS3 =
    /^s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) &&
    (parsed.pathname === `/${serverConfig.s3Bucket}` ||
      parsed.pathname.startsWith(`/${serverConfig.s3Bucket}/`));

  return allowedHosts.some((h) => parsed.hostname === h) || isVirtualHostS3 || isPathStyleS3;
}

export async function assetProxyHandler(req, res, next) {
  try {
    const { url, key } = req.query;
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
    let response;
    let currentUrl = targetUrl;
    let redirectCount = 0;
    const MAX_REDIRECTS = 3;

    while (true) {
      try {
        response = await fetch(currentUrl, { signal: abort.signal, redirect: 'manual' });
      } catch (err) {
        abort.clear();
        if (err?.name === 'AbortError') {
          return res.status(504).json({ error: 'Asset proxy request timed out' });
        }
        throw err;
      }

      if ([301, 302, 307, 308].includes(response.status) && response.headers.has('location')) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          abort.clear();
          return res.status(502).json({ error: 'Too many redirects from upstream asset host' });
        }
        const locationHeader = response.headers.get('location');
        let redirectTarget;
        try {
          redirectTarget = new URL(locationHeader, currentUrl);
        } catch {
          abort.clear();
          return res.status(502).json({ error: 'Invalid redirect location from upstream' });
        }
        if (!isTrustedAssetUrl(redirectTarget)) {
          abort.clear();
          return res.status(403).json({ error: 'Access denied: Untrusted redirect host' });
        }
        currentUrl = redirectTarget.toString();
        continue;
      }
      break;
    }

    if (!response.ok) {
      abort.clear();
      return res.status(response.status).json({ error: `Failed to fetch asset: ${response.statusText}` });
    }

    const contentLength = parseContentLength(response.headers.get('content-length'));
    if (contentLength !== null && contentLength > serverConfig.assetProxyMaxSize) {
      abort.clear();
      return res.status(413).json({ error: 'Asset proxy response too large' });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (/text\/html|application\/javascript|text\/javascript/i.test(contentType)) {
      abort.clear();
      return res.status(403).json({ error: 'Unsupported content type from upstream' });
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300, stale-while-revalidate=600');

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
