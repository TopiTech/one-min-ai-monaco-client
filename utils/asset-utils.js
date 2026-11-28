import { serverConfig } from '../config/server.js';

/**
 * Checks whether a parsed URL targets one of the given AWS S3 buckets via
 * virtual-hosted or path-style S3 endpoints (optionally exact bucket host).
 *
 * @param {URL} parsed
 * @param {string[]} buckets
 * @param {{ allowExactHost?: boolean, allowDashRegion?: boolean }} [options]
 * @returns {boolean}
 */
export function isS3BucketUrl(parsed, buckets, { allowExactHost = false, allowDashRegion = false } = {}) {
  if (!parsed || !Array.isArray(buckets) || buckets.length === 0) return false;
  const regionSep = allowDashRegion ? '[.-]' : '\\.';
  const pathStyleRe = new RegExp(`^s3(?:${regionSep}[\\w-]+)?\\.amazonaws\\.com$`, 'i');

  for (const bucket of buckets) {
    if (!bucket) continue;
    const escapedBucket = bucket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const isVirtualHostS3 =
      (allowExactHost && parsed.hostname === bucket) ||
      new RegExp(`^${escapedBucket}\\.s3(?:${regionSep}[\\w-]+)?\\.amazonaws\\.com$`, 'i').test(
        parsed.hostname,
      ) ||
      new RegExp(`^${escapedBucket}\\.s3-accelerate\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
      new RegExp(`^${escapedBucket}\\.s3\\.dualstack\\.[\\w-]+\\.amazonaws\\.com$`, 'i').test(
        parsed.hostname,
      );
    const isPathStyleS3 =
      pathStyleRe.test(parsed.hostname) &&
      (parsed.pathname === `/${bucket}` || parsed.pathname.startsWith(`/${bucket}/`));
    if (isVirtualHostS3 || isPathStyleS3) {
      return true;
    }
  }
  return false;
}

/**
 * Unwraps an internal `/api/assets/proxy?url=...` reference back to its decoded
 * upstream HTTPS/HTTP URL so external provider endpoints (e.g. 1forall.ai) receive
 * the public asset URL rather than an unresolvable localhost-relative proxy path.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function unwrapAssetProxyUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();
  if (!trimmed.startsWith('/api/assets/proxy')) return trimmed;
  try {
    const parsedProxy = new URL(trimmed, 'http://localhost');
    const urlParam = parsedProxy.searchParams.get('url');
    if (urlParam && /^https?:\/\//i.test(urlParam.trim())) {
      return urlParam.trim();
    }
    const keyParam = parsedProxy.searchParams.get('key');
    if (keyParam && keyParam.trim()) {
      return `${serverConfig.assetBaseUrl.replace(/\/$/, '')}/${keyParam.trim().replace(/^\//, '')}`;
    }
  } catch {
    // ignore malformed proxy URL and return original
  }
  return trimmed;
}

/**
 * Extracts a 1min.ai asset key from various URL formats.
 * Handles local proxy URLs, full HTTP/HTTPS URLs, and bare keys.
 *
 * @param {string} imageUrl - The image URL or asset key to extract from.
 * @returns {string} The extracted asset key.
 */
export function extractAssetKey(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') return imageUrl;

  let decoded = imageUrl;

  // Handle local proxy URLs
  if (decoded.startsWith('/api/assets/proxy')) {
    try {
      const parsedProxy = new URL(decoded, 'http://localhost');
      const keyParam = parsedProxy.searchParams.get('key');
      const urlParam = parsedProxy.searchParams.get('url');
      if (keyParam) {
        return extractAssetKey(keyParam);
      }
      if (urlParam) {
        return extractAssetKey(urlParam);
      }
    } catch {
      // ignore
    }
  }

  // Handle full HTTP/HTTPS URLs
  if (/^https?:\/\//i.test(decoded)) {
    try {
      const parsed = new URL(decoded);
      const s3Bucket = serverConfig.s3Bucket;
      if (
        isS3BucketUrl(parsed, [s3Bucket], { allowExactHost: true }) &&
        /^s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname) &&
        parsed.pathname.startsWith(`/${s3Bucket}/`)
      ) {
        return parsed.pathname.substring(`/${s3Bucket}/`.length);
      }
      if (isS3BucketUrl(parsed, [s3Bucket], { allowExactHost: true })) {
        return parsed.pathname.replace(/^\//, '');
      }
    } catch {
      // ignore
    }
  }

  return decoded.replace(/^\//, '');
}
