export function sanitizePayload(payload) {
  if (!payload) return null;
  if (typeof payload !== 'object') return payload;
  try {
    const sensitiveKeys = new Set([
      'api_key',
      'apikey',
      'key',
      'token',
      'auth',
      'authorization',
      'secret',
      'password',
      'credential',
      'prompt',
      'messages',
      'query',
      'input',
      'content',
      'cwd',
      'path',
      'dir',
      'file',
      'filepath',
      'filename',
      'url',
      'origin',
      'referer',
      'location',
    ]);
    const sensitiveValueKeys = new Set(['result', 'resultobject', 'result_object', 'raw']);
    const seen = new WeakSet();
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);
      if (Array.isArray(obj)) {
        return obj.map((item) => walk(item));
      }
      const result = {};
      // Use own enumerable keys only. Apart from avoiding inherited data in
      // logs, defining the property explicitly prevents a JSON field named
      // `__proto__` from changing the prototype of the sanitized object.
      for (const key of Object.keys(obj)) {
        const lowerKey = key.toLowerCase();
        const assign = (value) => {
          Object.defineProperty(result, key, {
            value,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        };
        if (sensitiveKeys.has(lowerKey)) {
          assign('[MASKED]');
        } else if (sensitiveValueKeys.has(lowerKey)) {
          assign('[REDACTED]');
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          assign(walk(obj[key]));
        } else {
          assign(obj[key]);
        }
      }
      return result;
    };
    return walk(payload);
  } catch {
    return '[Unable to sanitize details]';
  }
}

/**
 * Keep arbitrary upstream text out of log messages where it could expose a
 * credential, forge log lines, or create an unbounded log entry. This is
 * intentionally separate from sanitizePayload because callers still need to
 * return the original response body to the API consumer.
 */
export function sanitizeLogText(value, maxLength = 2048) {
  if (typeof value !== 'string') return '';

  let text = value.replace(/[\r\n]/g, '\\n');
  text = text
    .replace(/(["']?authorization["']?\s*[:=]\s*["']?)Bearer\s+[^\s,;"'<>\\]+/gi, '$1Bearer [REDACTED]')
    .replace(
      /(["']?(?:api[-_ ]?key|authorization|token|password|secret|credential)["']?\s*[:=]\s*["']?)(?!Bearer\b)([^\s,;"'<>}\\]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;"'<>\\]+/gi, 'Bearer [REDACTED]');

  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : 2048;
  return text.length > limit ? text.slice(0, limit) + '...[truncated]' : text;
}
