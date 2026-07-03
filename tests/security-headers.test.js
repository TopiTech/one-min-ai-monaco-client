import { jest } from '@jest/globals';
import request from 'supertest';

jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'mocked failure'),
  normalizeOneMinRawResponse: jest.fn(async (data) => data),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }),
}));

const { createApp } = await import('../server.js');

describe('security header regression', () => {
  test('CORS preflight advertises only the headers the browser client actually uses', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app)
      .options('/api/chat')
      .set('host', '127.0.0.1')
      .set('origin', 'http://127.0.0.1');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, x-local-bff-token');
  });

  test('uses Helmet default X-XSS-Protection=0 instead of legacy block mode', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/').set('host', '127.0.0.1');

    expect(res.status).toBe(200);
    expect(res.headers['x-xss-protection']).toBe('0');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });
});
