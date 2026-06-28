// Pre-set environment variables before dynamic imports to configure customOrigins in security middleware
process.env.ALLOWED_CORS_ORIGINS = 'https://example.com';

import { jest } from '@jest/globals';
import request from 'supertest';
import path from 'path';

// Mock the API client to prevent calling actual 1min.ai APIs
jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'Logical error'),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
  parseResponsePayload: jest.fn(async () => ({})),
}));

const { createApp } = await import('../server.js');
const { isProtectedPath, isWriteProtectedPath } = await import('../utils/fs-guard.js');

describe('Hardening Improvements Tests', () => {
  beforeEach(() => {
    process.env.ONE_MIN_AI_API_KEY = 'test-key';
  });

  describe('globToRegExp Directory Matching Fix', () => {
    test('scripts/** matches parent directory and its children', () => {
      // Resolve path to scripts dir and scripts file
      const currentFile = new URL(import.meta.url).pathname;
      // Normalize Windows absolute path format if needed (e.g. /C:/... -> C:/...)
      const cleanFile =
        process.platform === 'win32' && currentFile.startsWith('/') ? currentFile.substring(1) : currentFile;
      const projectRoot = path.resolve(cleanFile, '../../');
      const scriptsDir = path.join(projectRoot, 'scripts');
      const scriptsFile = path.join(projectRoot, 'scripts', 'copy-monaco.js');

      expect(isWriteProtectedPath(scriptsDir)).toBe(true);
      expect(isWriteProtectedPath(scriptsFile)).toBe(true);
    });
  });

  describe('/api/code/run filePath Validation', () => {
    test('rejects filePath containing shell metacharacters', async () => {
      const app = createApp({
        requireLocalAuth: false,
        enableRateLimit: false,
      });

      const res = await request(app).post('/api/code/run').send({
        filePath: 'somefile.js" && echo "injected',
        code: 'console.log("hello")',
        language: 'javascript',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('filePath contains invalid shell characters');
    });

    test('rejects filePath outside allowed roots', async () => {
      const prevVal = process.env.ENABLE_COMMAND_EXECUTION;
      process.env.ENABLE_COMMAND_EXECUTION = 'true';

      const app = createApp({
        requireLocalAuth: false,
        enableRateLimit: false,
      });

      // Target path outside allowed roots (e.g. System32 or other root directories)
      const res = await request(app).post('/api/code/run').send({
        filePath: 'C:\\Windows\\System32\\cmd.exe',
        code: 'print("hello")',
        language: 'python',
      });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied');

      process.env.ENABLE_COMMAND_EXECUTION = prevVal;
    });
  });

  describe('Production 500 error leak prevention', () => {
    test('hides internal error messages in production mode', async () => {
      const prevCors = process.env.ALLOWED_CORS_ORIGINS;
      process.env.ALLOWED_CORS_ORIGINS = 'https://example.com';
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      const app = createApp({
        requireLocalAuth: false,
        enableRateLimit: false,
      });

      // Trigger a network resolution failure through asset proxy.
      // Set host to example.com to simulate non-localhost access, making isLocalHost=false.
      const resProxyFail = await request(app)
        .get('/api/assets/proxy')
        .query({
          url: 'https://asset.1min.ai.s3.amazonaws.com/nonexistent_path_dns_should_fail',
        })
        .set('host', 'example.com');

      // Expect a 500 Internal error or similar.
      // Crucially, the error string should be filtered out to 'Internal Server Error' in production.
      expect(resProxyFail.status).toBe(500);
      expect(resProxyFail.body.error).toBe('Internal Server Error');

      process.env.NODE_ENV = prevEnv;
      process.env.ALLOWED_CORS_ORIGINS = prevCors;
    });
  });
});
