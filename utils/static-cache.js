/**
 * Cache/security headers for files served from `public/`.
 *
 * Kept as a plain function (instead of an inline `setHeaders` callback) so the
 * policy can be unit-tested without depending on generated asset directories
 * such as `public/vs` or `public/vendor`.
 */

/**
 * Applies per-file headers for static assets.
 *
 * Monaco (`public/vs`) and vendored libraries (`public/vendor`) are replaced
 * wholesale on dependency upgrades, so they are safe to cache immutably.
 * First-party files keep conditional caching to avoid serving stale code after
 * a restart.
 *
 * @param {{ setHeader: (name: string, value: string) => void }} res
 * @param {string} filePath Absolute path reported by express.static.
 */
export function setStaticCacheHeaders(res, filePath) {
  const normalized = String(filePath || '');
  if (normalized.endsWith('.js')) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (/(\/|\\)(vs|vendor)(\/|\\)/.test(normalized)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}
