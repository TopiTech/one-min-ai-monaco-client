import { jest } from '@jest/globals';
import request from 'supertest';
import path from 'path';
import fs from 'fs/promises';
import { isSubPath, getSafeRealPath, PROJECT_ROOT, clearAllowedRootsCache } from '../utils/fs-guard.js';
import { ForbiddenError } from '../utils/errors.js';

// Mock API client for server testing
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

describe('Code Review Hardening: isSubPath & Root Path Validation', () => {
  test('isSubPath correctly matches identical paths', () => {
    expect(isSubPath('C:\\project', 'C:\\project')).toBe(true);
    expect(isSubPath('/var/app', '/var/app')).toBe(true);
  });

  test('isSubPath handles Windows drive roots with children without double separator bug', () => {
    // Both C:\ and C:\test.txt
    expect(isSubPath('C:\\test.txt', 'C:\\')).toBe(true);
    expect(isSubPath('c:\\test.txt', 'C:\\')).toBe(true);
    expect(isSubPath('C:\\dir\\sub.js', 'C:\\')).toBe(true);
    expect(isSubPath('C:\\', 'C:\\')).toBe(true);
  });

  test('isSubPath handles subdirectories correctly', () => {
    expect(isSubPath('C:\\project\\src\\index.js', 'C:\\project')).toBe(true);
    expect(isSubPath('C:\\project\\src\\index.js', 'C:\\project\\')).toBe(true);
  });

  test('isSubPath prevents prefix hijacking attacks', () => {
    // C:\project-evil should NOT be recognized as child of C:\project
    expect(isSubPath('C:\\project-evil\\index.js', 'C:\\project')).toBe(false);
    expect(isSubPath('/home/user-fake/file', '/home/user')).toBe(false);
  });

  test('isSubPath handles Unix root / correctly', () => {
    expect(isSubPath('/etc/hosts', '/')).toBe(true);
    expect(isSubPath('/app/server.js', '/')).toBe(true);
    expect(isSubPath('/', '/')).toBe(true);
  });

  test('isSubPath returns false for empty or unrelated paths', () => {
    expect(isSubPath('', 'C:\\project')).toBe(false);
    expect(isSubPath('C:\\project', '')).toBe(false);
    expect(isSubPath('D:\\other\\file', 'C:\\project')).toBe(false);
  });
});

describe('Code Review Hardening: getSafeRealPath', () => {
  const originalAllowedRoots = process.env.ALLOWED_ROOTS;

  beforeEach(() => {
    delete process.env.ALLOWED_ROOTS;
    clearAllowedRootsCache();
  });

  afterEach(() => {
    if (originalAllowedRoots === undefined) {
      delete process.env.ALLOWED_ROOTS;
    } else {
      process.env.ALLOWED_ROOTS = originalAllowedRoots;
    }
    clearAllowedRootsCache();
  });

  test('getSafeRealPath returns real path for valid existing file', async () => {
    const validFile = path.join(PROJECT_ROOT, 'package.json');
    // Note: package.json is protected from write operations
    await expect(getSafeRealPath(validFile)).rejects.toThrow(ForbiddenError);

    const tmpDir = path.join(PROJECT_ROOT, `test_tmp_${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, 'test_safe.txt');
    await fs.writeFile(tmpFile, 'test');
    try {
      const real = await getSafeRealPath(tmpFile);
      expect(real.toLowerCase()).toBe((await fs.realpath(tmpFile)).toLowerCase());
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('getSafeRealPath returns resolvedPath for non-existent path within allowed roots', async () => {
    const nonExistent = path.join(PROJECT_ROOT, 'test-non-existent-12345.txt');
    const safe = await getSafeRealPath(nonExistent);
    expect(safe).toBe(nonExistent);
  });

  test('getSafeRealPath rejects non-existent path outside allowed roots', async () => {
    const outsidePath = path.resolve(PROJECT_ROOT, '..', 'outside-file-12345.txt');
    await expect(getSafeRealPath(outsidePath)).rejects.toThrow(ForbiddenError);
  });
});

describe('Code Review Hardening: Agent Session Deletion', () => {
  let app;

  beforeEach(() => {
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  test('DELETE /api/agent/sessions/:id deletes idle session cleanly', async () => {
    // 1. Create a session
    const createRes = await request(app)
      .post('/api/agent/sessions')
      .send({ task: 'Idle session for deletion test' });
    expect(createRes.status).toBe(200);
    const sessionId = createRes.body.session.id;

    // 2. Delete the session
    const deleteRes = await request(app).delete(`/api/agent/sessions/${sessionId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.ok).toBe(true);

    // 3. Confirm session is gone
    const getRes = await request(app).get(`/api/agent/sessions/${sessionId}`);
    expect(getRes.status).toBe(404);
  });
});
