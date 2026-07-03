import { serverConfig } from '../config/server.js';

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
      // Path-style S3 URL: https://s3.us-east-1.amazonaws.com/<bucket>/images/...
      if (/^s3(?:\.[\w-]+)?\.amazonaws\.com$/i.test(parsed.hostname)) {
        if (parsed.pathname.startsWith(`/${s3Bucket}/`)) {
          return parsed.pathname.substring(`/${s3Bucket}/`.length);
        }
      }
      // Virtual-host S3 URL or direct domain
      const escapedBucket = s3Bucket.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      const isAllowedS3OrDomain =
        parsed.hostname === s3Bucket ||
        new RegExp(`^${escapedBucket}\\.s3(?:\\.[\\w-]+)?\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
        new RegExp(`^${escapedBucket}\\.s3-accelerate\\.amazonaws\\.com$`, 'i').test(parsed.hostname) ||
        new RegExp(`^${escapedBucket}\\.s3\\.dualstack\\.[\\w-]+\\.amazonaws\\.com$`, 'i').test(
          parsed.hostname,
        );

      if (isAllowedS3OrDomain) {
        return parsed.pathname.replace(/^\//, '');
      }
    } catch {
      // ignore
    }
  }

  return decoded.replace(/^\//, '');
}
