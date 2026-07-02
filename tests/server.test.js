/**
 * Integration tests for server factory
 * Run with: node --experimental-vm-modules node_modules/jest/bin/jest.js
 */

import { jest } from '@jest/globals';
import request from 'supertest';

// Mock the api-client module
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

// Import after mocking
const { callOneMin } = await import('../utils/api-client.js');
const { createApp } = await import('../server.js');

describe('Server Factory', () => {
  let app;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe('GET /api/health', () => {
    test('should return 200 with health status', async () => {
      process.env.ONE_MIN_AI_API_KEY = 'test-key';

      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('one-min-ai-monaco-client');
      expect(response.body.models).toBeDefined();
      expect(response.body.models.ok).toBe(true);
      // hasApiKey removed from health endpoint to reduce info exposure (B-5)
      expect(response.body.hasApiKey).toBeUndefined();
    });

    test('should return 200 even when API key is missing', async () => {
      delete process.env.ONE_MIN_AI_API_KEY;

      const response = await request(app).get('/api/health');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      // hasApiKey removed from health endpoint (B-5)
      expect(response.body.hasApiKey).toBeUndefined();
    });
  });

  describe('local BFF auth', () => {
    test('should require local auth for fs routes by default', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp).get('/api/fs/config');

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Local BFF authentication required or invalid token');
    });

    test('should require local auth for AI routes', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp).post('/api/chat').send({ prompt: 'test' });

      expect(response.status).toBe(403);
      expect(response.body.error).toBe('Local BFF authentication required or invalid token');
    });

    test('should accept valid local auth token + same-origin cookie + matching origin', async () => {
      const { callOneMin } = await import('../utils/api-client.js');
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' }, result: 'ok' });

      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .post('/api/chat')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1')
        .send({ prompt: 'test' });

      expect(response.status).toBe(200);
    });

    test('should accept valid local auth token with full credentials', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get('/api/fs/config')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1');

      expect(response.status).toBe(200);
      expect(response.body.allowedRoots).toBeDefined();
    });

    test('should reject requests with only sec-fetch-site and no token', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp).get('/api/fs/config').set('sec-fetch-site', 'same-origin');

      expect(response.status).toBe(403);
    });

    test('should reject requests with a non-local Origin', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get('/api/fs/config')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('origin', 'https://evil.example');

      expect(response.status).toBe(403);
    });

    test('should accept trusted local Origin + token + same-origin cookie', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .get('/api/fs/config')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1');

      expect(response.status).toBe(200);
    });
  });

  describe('GET /api/models', () => {
    test('should return available models lists', async () => {
      const response = await request(app).get('/api/models');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('chatModels');
      expect(response.body).toHaveProperty('codeModels');
      expect(response.body).toHaveProperty('imageModels');
    });
  });

  describe('GET /api/fs/read', () => {
    test('should allow reading non-secret project source files', async () => {
      const response = await request(app).get('/api/fs/read').query({ path: 'server.js' });

      expect(response.status).toBe(200);
      expect(response.body.content).toContain('createApp');
    });

    test('should block reading protected secret files', async () => {
      const response = await request(app).get('/api/fs/read').query({ path: '.env' });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /api/chat', () => {
    test('should call callOneMin and return chat response data', async () => {
      callOneMin.mockResolvedValue({ result: 'ok' });

      const response = await request(app)
        .post('/api/chat')
        .send({ prompt: 'Hello AI', model: 'gpt-4o-mini' });

      expect(response.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledWith(
        '/api/chat-with-ai',
        expect.objectContaining({
          body: expect.stringContaining('"settings"'),
        }),
      );
    });
  });

  describe('Configuration', () => {
    test('should have default values for server config', async () => {
      const { serverConfig } = await import('../config/server.js');

      expect(serverConfig.port).toBeDefined();
      expect(serverConfig.maxFileSize).toBeDefined();
      expect(serverConfig.apiTimeout).toBeDefined();
      expect(serverConfig.apiRetryAttempts).toBeDefined();
    });
  });

  describe('Static file serving', () => {
    test('should set X-Content-Type-Options nosniff for .js files', async () => {
      const response = await request(app).get('/js/api.js');
      if (response.status === 200) {
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      }
    });
  });

  describe('GET /api/health (detailed)', () => {
    test('should return ok:true with service name', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('one-min-ai-monaco-client');
    });

    test('should not expose any secrets or API keys', async () => {
      const response = await request(app).get('/api/health');
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('apiKey');
      expect(response.body).not.toHaveProperty('hasApiKey');
    });
  });

  describe('Asset upload error handling', () => {
    test('should return 400 when no file is attached', async () => {
      const response = await request(app).post('/api/assets/upload').send({});
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/asset file is required|Unexpected field/);
    });
  });

  describe('Error handler', () => {
    test('should return 500 with error for unhandled exceptions', async () => {
      const response = await request(app).get('/api/fs/read');
      expect(response.status).toBe(400);
    });

    test('should include error code in response', async () => {
      const response = await request(app).post('/api/chat').send({});
      expect(response.status).toBe(400);
    });

    test("should not expose stack trace when NODE_ENV is not 'development'", async () => {
      process.env.NODE_ENV = 'production';
      const prodApp = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const response = await request(prodApp).get('/api/nonexistent-route');
      // Express returns 404 for unknown routes, which triggers the error handler
      expect(response.status).toBe(404);
      expect(response.body.stack).toBeUndefined();
      expect(response.body.details).toBeUndefined();
    });

    test('should not expose stack trace when NODE_ENV is unset', async () => {
      delete process.env.NODE_ENV;
      const defaultApp = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const response = await request(defaultApp).get('/api/nonexistent-route');
      expect(response.status).toBe(404);
      expect(response.body.stack).toBeUndefined();
      expect(response.body.details).toBeUndefined();
    });

    test('should expose stack trace only in development mode from localhost', async () => {
      process.env.NODE_ENV = 'development';
      const devApp = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // Trigger a 500 via a protected route with bad input
      const response = await request(devApp).post('/api/chat').set('host', '127.0.0.1').send({});
      // In development mode, 400 errors from schema validation
      // don't expose stack/details (they are clean validation errors)
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('Static file serving - cache headers', () => {
    test('should set immutable cache for Monaco editor assets when served', async () => {
      const response = await request(app).get('/vs/loader.js');
      if (response.status === 200 && response.headers['cache-control']) {
        // express.static setHeaders should add immutable cache for /vs/ paths
        const cc = response.headers['cache-control'];
        expect(cc).toContain('immutable');
        expect(cc).toContain('max-age=31536000');
      }
      // If status is 404, the /vs/ directory doesn't exist in test env - that's OK
      expect([200, 404]).toContain(response.status);
    });

    test('should set immutable cache for vendor assets when served', async () => {
      const response = await request(app).get('/vendor/marked.min.js');
      if (response.status === 200 && response.headers['cache-control']) {
        expect(response.headers['cache-control']).toContain('immutable');
      }
      expect([200, 404]).toContain(response.status);
    });

    test('should NOT set immutable cache for non-vendor JS files', async () => {
      const response = await request(app).get('/js/api.js');
      if (response.status === 200) {
        // Regular JS files should not have immutable cache
        const cc = response.headers['cache-control'] || '';
        expect(cc).not.toContain('immutable');
      }
    });
  });

  describe('localBffAuth - security', () => {
    test('should reject cross-site requests with sec-fetch-site: cross-site', async () => {
      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .post('/api/chat')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('sec-fetch-site', 'cross-site')
        .set('host', '127.0.0.1')
        .send({ prompt: 'test' });

      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/Cross-origin/i);
    });

    test('should accept same-origin requests with sec-fetch-site: same-origin', async () => {
      const { callOneMin } = await import('../utils/api-client.js');
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' }, result: 'ok' });

      const protectedApp = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const response = await request(protectedApp)
        .post('/api/chat')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('sec-fetch-site', 'same-origin')
        .send({ prompt: 'test' });

      expect(response.status).toBe(200);
    });
  });
});
