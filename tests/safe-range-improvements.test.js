import { serverConfig } from '../config/server.js';
import { flushPendingWriters } from '../routes/agent.js';
import { createApp } from '../server.js';
import request from 'supertest';

describe('Safe-range Improvements Unit Tests', () => {
  test('flushPendingWriters should be exported and callable', async () => {
    expect(typeof flushPendingWriters).toBe('function');
    // Test that calling it resolves without throwing
    await expect(flushPendingWriters()).resolves.not.toThrow();
  });

  test('serverConfig contains exposeErrorDetails, apiStreamTimeoutMs, and agentChatTimeoutMs', () => {
    expect(serverConfig.exposeErrorDetails).toBeDefined();
    expect(typeof serverConfig.exposeErrorDetails).toBe('boolean');
    expect(serverConfig.apiStreamTimeoutMs).toBe(300000);
    expect(serverConfig.agentChatTimeoutMs).toBe(600000);
  });

  test('global error handler respects exposeErrorDetails config', async () => {
    const originalEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // Trigger error handler via a route that throws an actual Error (status 403)
      const response = await request(app).get('/api/fs/read?path=.env').set('host', '127.0.0.1');

      expect(response.status).toBe(403);
      // Since NODE_ENV=test (not development), exposeErrorDetails is false
      expect(response.body.stack).toBeUndefined();
      expect(response.body.details).toBeNull();
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
