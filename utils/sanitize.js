export function sanitizePayload(payload) {
  if (!payload) return null;
  if (typeof payload !== 'object') return payload;
  try {
    const sensitiveKeys = [
      'api_key',
      'apikey',
      'key',
      'token',
      'auth',
      'authorization',
      'secret',
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
    ];
    const sensitiveValueKeys = ['result', 'resultObject', 'result_object', 'raw'];
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
        if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
          result[key] = '[MASKED]';
        } else if (sensitiveValueKeys.some((sk) => lowerKey.includes(sk))) {
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
