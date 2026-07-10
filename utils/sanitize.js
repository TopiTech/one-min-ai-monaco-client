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
      for (const key in obj) {
        const lowerKey = key.toLowerCase();
        if (sensitiveKeys.has(lowerKey)) {
          result[key] = '[MASKED]';
        } else if (sensitiveValueKeys.has(lowerKey)) {
          result[key] = '[REDACTED]';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          result[key] = walk(obj[key]);
        } else {
          result[key] = obj[key];
        }
      }
      return result;
    };
    return walk(payload);
  } catch {
    return '[Unable to sanitize details]';
  }
}
