import { sanitizeLogText, sanitizePayload } from '../utils/sanitize.js';

describe('sanitize helpers', () => {
  test('does not let a __proto__ field alter the sanitized object prototype', () => {
    const payload = JSON.parse('{"__proto__":{"polluted":true},"safe":"value"}');
    const sanitized = sanitizePayload(payload);

    expect({}.polluted).toBeUndefined();
    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(sanitized, '__proto__')).toBe(true);
    expect(sanitized.safe).toBe('value');
  });

  test('redacts credentials and bounds arbitrary log text', () => {
    const text = sanitizeLogText('Authorization: Bearer secret-token\n' + 'x'.repeat(3000), 100);

    expect(text).toContain('Authorization: Bearer [REDACTED]');
    expect(text).not.toContain('secret-token');
    expect(text).toContain('...[truncated]');
    expect(text).not.toContain('\n');
  });

  test('redacts quoted credentials in upstream JSON text', () => {
    const text = sanitizeLogText('{"api_key":"secret-value","message":"failed"}');

    expect(text).not.toContain('secret-value');
    expect(text).toContain('[REDACTED]');
  });
});
