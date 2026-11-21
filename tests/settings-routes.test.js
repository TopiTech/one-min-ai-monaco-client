import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { resetKeyStoreCache, setKeyStoreFilePath } from '../services/key-store.js';

const { createApp } = await import('../server.js');

describe('Settings API routes (/api/settings)', () => {
  let app;
  let tmpDir;
  let originalFetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-routes-'));
    setKeyStoreFilePath(path.join(tmpDir, 'api_keys.json'));
    delete process.env.ONE_MIN_AI_API_KEY;
    delete process.env.ONE_FOR_ALL_API_KEY;
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setKeyStoreFilePath(null);
    resetKeyStoreCache();
    process.env = { ...savedEnv };
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  test('GET /api/settings/providers returns masked status and capabilities', async () => {
    process.env.ONE_MIN_AI_API_KEY = 'secret_1min_abcdef1234';
    const res = await request(app).get('/api/settings/providers');

    expect(res.status).toBe(200);
    expect(res.body.defaultProvider).toBeDefined();
    expect(res.body.providers['1min']).toMatchObject({
      id: '1min',
      configured: true,
      source: 'env',
      masked: 'secr...1234',
      capabilities: expect.objectContaining({ webSearch: true, videoGeneration: true }),
    });
    expect(res.body.providers['1forall']).toMatchObject({
      id: '1forall',
      configured: false,
      source: 'none',
      masked: null,
      capabilities: expect.objectContaining({ webSearch: false, videoGeneration: true }),
    });
    expect(JSON.stringify(res.body)).not.toContain('secret_1min_abcdef1234');
  });

  test('POST /api/settings/keys verifies key and saves without returning plaintext', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      if (String(url).includes('/v1/external/llm/models/')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const saveRes = await request(app).post('/api/settings/keys').send({
      provider: '1forall',
      apiKey: 'Bearer sk_live_my_secret_token_9876',
      verify: true,
    });

    expect(saveRes.status).toBe(200);
    expect(saveRes.body.ok).toBe(true);
    expect(saveRes.body.provider).toEqual({
      provider: '1forall',
      configured: true,
      source: 'ui',
      masked: 'sk_l...9876',
    });
    expect(JSON.stringify(saveRes.body)).not.toContain('sk_live_my_secret_token_9876');

    const delRes = await request(app).delete('/api/settings/keys/1forall');
    expect(delRes.status).toBe(200);
    expect(delRes.body.provider.configured).toBe(false);
  });

  test('POST /api/settings/keys rejects 401 unauthorized key during verification', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(JSON.stringify({ error: { message: 'Invalid key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });

    const res = await request(app).post('/api/settings/keys').send({
      provider: '1forall',
      apiKey: 'sk_live_revoked_key_0000',
      verify: true,
    });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });

  test('POST /api/settings/keys supports verify: false when offline', async () => {
    globalThis.fetch = jest.fn(async () => new Response('[]', { status: 200 }));

    const res = await request(app).post('/api/settings/keys').send({
      provider: '1min',
      apiKey: 'onemin_offline_key_1234',
      verify: false,
    });

    expect(res.status).toBe(200);
    expect(res.body.verification).toEqual({ verified: false, skipped: true });
    expect(res.body.provider.masked).toBe('onem...1234');
  });
});
