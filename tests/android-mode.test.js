/**
 * Tests for Android platform mode (APP_PLATFORM=android)
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../server.js';
import { serverConfig } from '../config/server.js';
import { assertNoSecretsInStagedDir } from '../scripts/android-prepare.js';

describe('Android platform mode (APP_PLATFORM=android)', () => {
  const originalEnv = {
    APP_PLATFORM: process.env.APP_PLATFORM,
    NODE_ENV: process.env.NODE_ENV,
  };
  const originalConfig = {
    enableCommandExecution: serverConfig.enableCommandExecution,
    enableCodeRun: serverConfig.enableCodeRun,
  };

  afterEach(() => {
    if (originalEnv.APP_PLATFORM === undefined) {
      delete process.env.APP_PLATFORM;
    } else {
      process.env.APP_PLATFORM = originalEnv.APP_PLATFORM;
    }

    if (originalEnv.NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalEnv.NODE_ENV;
    }

    serverConfig.enableCommandExecution = originalConfig.enableCommandExecution;
    serverConfig.enableCodeRun = originalConfig.enableCodeRun;
  });

  test('injects data-platform="android" and strips /vs/loader.js when APP_PLATFORM=android', async () => {
    process.env.APP_PLATFORM = 'android';
    process.env.NODE_ENV = 'test';

    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('<html data-platform="android"');
    expect(res.text).not.toContain('/vs/loader.js');
    expect(serverConfig.enableCommandExecution).toBe(false);
    expect(serverConfig.enableCodeRun).toBe(false);
  });

  test('disables Secure cookie flag, HSTS, and upgrade-insecure-requests in production Android loopback mode', async () => {
    process.env.APP_PLATFORM = 'android';
    process.env.NODE_ENV = 'production';

    const app = createApp({
      requireLocalAuth: true,
      authToken: 'a'.repeat(48),
      enableRateLimit: false,
    });
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.headers['strict-transport-security']).toBeUndefined();
    expect(res.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');

    const cookies = res.headers['set-cookie'] || [];
    const sessionCookie = cookies.find((c) => c.startsWith('__bff_session='));
    const csrfCookie = cookies.find((c) => c.startsWith('__bff_csrf='));
    expect(sessionCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();
    expect(sessionCookie.toLowerCase()).not.toContain('; secure');
    expect(csrfCookie.toLowerCase()).not.toContain('; secure');
  });

  test('preserves desktop behavior (/vs/loader.js and no data-platform="android") when unset', async () => {
    delete process.env.APP_PLATFORM;
    process.env.NODE_ENV = 'test';

    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('data-platform="android"');
    expect(res.text).toContain('/vs/loader.js');
  });

  describe('Android asset staging secret guard', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'android-stage-test-'));
    });

    afterEach(async () => {
      if (tmpDir) {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    test('passes for clean staged bundle without secrets or public/vs', async () => {
      await fs.mkdir(path.join(tmpDir, 'public', 'js'), { recursive: true });
      await fs.writeFile(path.join(tmpDir, 'server.js'), '');
      await fs.writeFile(path.join(tmpDir, 'public', 'index.html'), '');

      await expect(assertNoSecretsInStagedDir(tmpDir)).resolves.toBeUndefined();
    });

    test('rejects .env, .onemin-ai, and public/vs in staged directory', async () => {
      await fs.writeFile(path.join(tmpDir, '.env'), 'ONE_MIN_AI_API_KEY=secret');
      await fs.mkdir(path.join(tmpDir, '.onemin-ai', 'data'), { recursive: true });
      await fs.mkdir(path.join(tmpDir, 'public', 'vs'), { recursive: true });

      await expect(assertNoSecretsInStagedDir(tmpDir)).rejects.toThrow(
        /Forbidden files\/directories found in Android bundle: .*\.env.*\.onemin-ai.*public\/vs/s,
      );
    });
  });
});
