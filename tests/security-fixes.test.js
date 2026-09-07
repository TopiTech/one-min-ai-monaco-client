/**
 * Regression tests for security fixes applied after the initial review.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import path from 'path';
import fs from 'fs/promises';
import os from 'os';

jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn((data) => {
    if (!data || typeof data !== 'object') return false;
    const s = data?.aiRecord?.status ?? data?.status;
    if (!s) return false;
    return String(s).toUpperCase() !== 'SUCCESS' && String(s).toUpperCase() !== 'COMPLETED';
  }),
  extractFailureMessage: jest.fn(
    (data) =>
      data?.aiRecord?.aiRecordDetail?.errorMessage ||
      data?.aiRecord?.errorMessage ||
      data?.error?.message ||
      data?.error ||
      'Upstream returned a failure status',
  ),
  normalizeOneMinRawResponse: jest.fn(async (data) => data),
  normalizeAssetResponse: jest.fn((data) => ({
    key: data?.asset?.key || '',
    url: '',
    raw: data,
  })),
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

const { callOneMin } = await import('../utils/api-client.js');
const { createApp } = await import('../server.js');
const { checkCommandSafety } = await import('../services/command-runner.js');
const { isFailedResponse, extractFailureMessage } = await import('../utils/api-client.js');
const { validateBufferMimeType, getExtensionFromMimeType } = await import('../utils/mime-guard.js');
const { revalidateRealPath, clearAllowedRootsCache } = await import('../utils/fs-guard.js');

describe('Security fixes regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ONE_MIN_AI_API_KEY = 'test-key';
  });

  describe('localBffAuth origin / host enforcement', () => {
    test('accepts request with valid token + same-origin cookie + matching origin', async () => {
      const app = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const res = await request(app)
        .get('/api/fs/config')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1');

      expect(res.status).toBe(200);
    });

    test('rejects request with valid token + cross-origin', async () => {
      const app = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const res = await request(app)
        .get('/api/fs/config')
        .set('x-local-bff-token', 'secret-token')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'https://evil.example');

      expect(res.status).toBe(403);
    });

    test('rejects request with cookie only (no header)', async () => {
      const app = createApp({
        requireLocalAuth: true,
        authToken: 'secret-token',
        enableRateLimit: false,
      });

      const res = await request(app)
        .post('/api/chat')
        .set('Cookie', '__bff_session=secret-token; __bff_csrf=secret-token')
        .set('host', '127.0.0.1')
        .set('origin', 'http://127.0.0.1')
        .send({ prompt: 'test' });

      expect(res.status).toBe(403);
    });
  });

  describe('1min.ai FAILED status detection', () => {
    test('isFailedResponse returns true on FAILED status', () => {
      expect(isFailedResponse({ aiRecord: { status: 'FAILED' } })).toBe(true);
    });

    test('isFailedResponse returns false on SUCCESS', () => {
      expect(isFailedResponse({ aiRecord: { status: 'SUCCESS' } })).toBe(false);
    });

    test('isFailedResponse returns false on missing status', () => {
      expect(isFailedResponse({ aiRecord: { status: null } })).toBe(false);
    });

    test('extractFailureMessage surfaces upstream errorMessage', () => {
      expect(
        extractFailureMessage({
          aiRecord: { aiRecordDetail: { errorMessage: 'credit exceeded' } },
        }),
      ).toBe('credit exceeded');
    });

    test('POST /api/chat converts FAILED response to 502', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { status: 'FAILED', aiRecordDetail: { errorMessage: 'credit exceeded' } },
      });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post('/api/chat').send({ prompt: 'hi' });

      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/credit exceeded/);
    });

    test('POST /api/images/generate converts FAILED response to 502', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { status: 'FAILED', aiRecordDetail: { errorMessage: 'moderation' } },
      });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post('/api/images/generate')
        .send({ prompt: 'a cat', model: 'gpt-image-2' });

      expect(res.status).toBe(502);
    });
  });

  describe('attachments validation', () => {
    test('rejects attachments as array', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post('/api/chat').send({ prompt: 'hi', attachments: [] });

      expect(res.status).toBe(400);
    });

    test('rejects attachments.images with non-string entries', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post('/api/chat')
        .send({ prompt: 'hi', attachments: { images: [{ url: 'x' }] } });

      expect(res.status).toBe(400);
    });

    test('rejects more than 16 image attachments', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const images = Array.from({ length: 17 }, (_, i) => `key${i}`);
      const res = await request(app).post('/api/chat').send({ prompt: 'hi', attachments: { images } });

      expect(res.status).toBe(400);
    });
  });

  describe('non-gpt-image model rejects gpt-image-only fields', () => {
    test('/api/images/generate with flux + quality=background returns 400', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app).post('/api/images/generate').send({
        prompt: 'a cat',
        model: 'black-forest-labs/flux-schnell',
        quality: 'high',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('image request bounds', () => {
    test('rejects fractional or out-of-range image counts', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      for (const num_outputs of [1.5, 0, 11]) {
        const res = await request(app)
          .post('/api/images/generate')
          .send({ prompt: 'a cat', model: 'gpt-image-2', num_outputs });
        expect(res.status).toBe(400);
      }

      const editor = await request(app)
        .post('/api/images/text-editor')
        .send({ imageUrl: 'images/source.png', prompt: 'edit', model: 'gpt-image-2', n: 1.5 });
      expect(editor.status).toBe(400);
      expect(callOneMin).not.toHaveBeenCalled();
    });

    test('rejects oversized image prompts and asset references before upstream calls', async () => {
      callOneMin.mockResolvedValue({ aiRecord: { status: 'SUCCESS' } });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const prompt = await request(app)
        .post('/api/images/generate')
        .send({ prompt: 'x'.repeat(50_001), model: 'gpt-image-2' });
      expect(prompt.status).toBe(400);

      const imageUrl = await request(app)
        .post('/api/images/text-editor')
        .send({ imageUrl: 'x'.repeat(4097), prompt: 'edit', model: 'gpt-image-2' });
      expect(imageUrl.status).toBe(400);
      expect(callOneMin).not.toHaveBeenCalled();
    });
  });

  describe('command-runner injection gaps', () => {
    test("blocks trailing '&' backgrounding", () => {
      const r = checkCommandSafety('npm test &');
      expect(r.safe).toBe(false);
    });

    test('blocks node --eval and --require', () => {
      expect(checkCommandSafety("node --eval 'process.exit(0)'").safe).toBe(false);
      expect(checkCommandSafety('node --require ./evil.js').safe).toBe(false);
    });

    test('blocks python -m and bash -c', () => {
      expect(checkCommandSafety('python -m os').safe).toBe(false);
      expect(checkCommandSafety("bash -c 'rm -rf /'").safe).toBe(false);
    });

    test('blocks powershell -EncodedCommand', () => {
      expect(checkCommandSafety('powershell -EncodedCommand ZQBjAGgAbwAgACIAdABlAHMAdAAiAA==').safe).toBe(
        false,
      );
    });

    test('blocks cmd.exe /c', () => {
      expect(checkCommandSafety('cmd.exe /c dir').safe).toBe(false);
    });
  });

  describe('mime-guard text validation', () => {
    test('rejects text/plain with embedded null bytes', () => {
      const buf = Buffer.from('hello\x00world', 'utf-8');
      expect(validateBufferMimeType(buf, 'text/plain')).toBe(false);
    });

    test('accepts valid UTF-8 text/plain', () => {
      const buf = Buffer.from('hello\nworld\n', 'utf-8');
      expect(validateBufferMimeType(buf, 'text/plain')).toBe(true);
    });

    test('rejects UTF-8 text with control characters other than tab/newline', () => {
      const buf = Buffer.from('hello\x07world', 'utf-8');
      expect(validateBufferMimeType(buf, 'text/plain')).toBe(false);
    });

    test('rejects text/plain with invalid UTF-8 byte sequence', () => {
      // 0xC3 0x28 is an invalid UTF-8 sequence
      const buf = Buffer.from([0x68, 0x69, 0xc3, 0x28]);
      expect(validateBufferMimeType(buf, 'text/plain')).toBe(false);
    });
  });

  describe('fs-guard revalidateRealPath', () => {
    let tmpDir;
    let outsideDir;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsguard-test-'));
      outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsguard-outside-'));
    });

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
      clearAllowedRootsCache();
      delete process.env.ALLOWED_ROOTS;
    });

    test('returns the real path for a file inside allowed roots', async () => {
      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
      const file = path.join(tmpDir, 'ok.txt');
      await fs.writeFile(file, 'hi');
      const real = revalidateRealPath(file);
      expect(real).toBe(file);
    });

    test('rejects paths outside allowed roots', async () => {
      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
      const outside = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outside, 'secret');
      expect(() => revalidateRealPath(outside)).toThrow(/Access denied/);
    });
  });

  describe('CORS middleware restrictions', () => {
    test('allows localhost origins', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('Origin', 'http://localhost:3000');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });

    test('allows 127.0.0.1 origins with any port', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('Origin', 'https://127.0.0.1:8080');
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://127.0.0.1:8080');
    });

    test('rejects external non-localhost origins', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('Origin', 'https://evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('CORS request blocked');
    });
  });

  describe('FS read revalidation (symlinks)', () => {
    let tmpDir;
    let outsideDir;
    let app;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-read-symlink-'));
      outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-read-outside-'));
      app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    });

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
    });

    test('successfully reads file inside allowed roots', async () => {
      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
      const file = path.join(tmpDir, 'ok.txt');
      await fs.writeFile(file, 'content inside');

      const res = await request(app).get('/api/fs/read').query({ path: file });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('content inside');
    });

    test('rejects symlink pointing outside allowed roots', async () => {
      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret content');

      const linkFile = path.join(tmpDir, 'link.txt');
      try {
        await fs.symlink(outsideFile, linkFile);
      } catch {
        // On Windows, symlink creation might fail if not running with developer mode or admin.
        // If it fails, skip the assertion.
        return;
      }

      const res = await request(app).get('/api/fs/read').query({ path: linkFile });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied: Path is outside the allowed directories');
    });
  });

  describe('Host header validation (DNS Rebinding protection)', () => {
    test('accepts request with localhost host header', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('host', 'localhost:3000');
      expect(res.status).toBe(200);
    });

    test('accepts request with 127.0.0.1 host header', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('host', '127.0.0.1');
      expect(res.status).toBe(200);
    });

    test('rejects request with external host header', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health').set('host', 'evil.example.com');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied: Invalid Host header');
    });
  });

  describe('Agent files symlink revalidation', () => {
    let tmpDir;
    let outsideDir;
    let app;
    let sessionId;

    beforeAll(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-symlink-'));
      outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
      app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
      const res = await request(app).post('/api/agent/sessions').send({ cwd: tmpDir });
      sessionId = res.body.session.id;
    });

    afterAll(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(outsideDir, { recursive: true, force: true });
      clearAllowedRootsCache();
      delete process.env.ALLOWED_ROOTS;
    });

    test('successfully reads file inside agent workspace', async () => {
      const file = path.join(tmpDir, 'ok.txt');
      await fs.writeFile(file, 'agent content');

      const res = await request(app).get(`/api/agent/sessions/${sessionId}/files`).query({ path: 'ok.txt' });

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('agent content');
    });

    test('rejects agent reading symlink pointing outside allowed roots', async () => {
      const outsideFile = path.join(outsideDir, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret content');

      const linkFile = path.join(tmpDir, 'link.txt');
      try {
        await fs.symlink(outsideFile, linkFile);
      } catch {
        return;
      }

      const res = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: 'link.txt' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Access denied: Path is outside the allowed directories');
    });
  });

  describe('HTML Route Security (Cache-Control & Cookie Path)', () => {
    test('serves HTML root with Cache-Control no-store and path=/api for session cookie', async () => {
      const app = createApp({ requireLocalAuth: true, authToken: 'secret-token', enableRateLimit: false });
      const res = await request(app).get('/');

      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate');

      const cookies = res.headers['set-cookie'] || [];
      const sessionCookie = cookies.find((c) => c.startsWith('__bff_session='));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie.toLowerCase()).toContain('path=/api');
    });
  });

  describe('mime-guard getExtensionFromMimeType helper', () => {
    test('correctly maps standard mime types to extensions', () => {
      expect(getExtensionFromMimeType('image/png')).toBe('.png');
      expect(getExtensionFromMimeType('image/jpeg')).toBe('.jpg');
      expect(getExtensionFromMimeType('application/pdf')).toBe('.pdf');
      expect(getExtensionFromMimeType('application/json')).toBe('.json');
      expect(getExtensionFromMimeType('text/plain')).toBe('.txt');
      expect(getExtensionFromMimeType('text/html')).toBe('.html');
      expect(getExtensionFromMimeType('image/unknown')).toBe('.bin');
      expect(getExtensionFromMimeType(null)).toBe('.bin');
    });
  });

  describe('Agent chat XSS prevention (role attribute injection)', () => {
    test('sanitizes malicious role values in messages array', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { aiRecordDetail: { resultObject: 'safe response' } },
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // Attempt to inject via role attribute
      const maliciousRole = 'user" onmouseover="alert(1)" data-x="';
      const res = await request(app)
        .post('/api/agent/chat')
        .send({
          messages: [{ role: maliciousRole, content: 'test' }],
        });

      expect(res.status).toBe(200);
      // The call should succeed and the role should be sanitized
      expect(callOneMin).toHaveBeenCalled();
      const payload = callOneMin.mock.calls[0][1];
      const body = JSON.parse(payload.body);
      // Role should be sanitized: quotes and spaces must be removed to prevent attribute breakout
      expect(body.promptObject.prompt).not.toContain('" onmouseover');
      expect(body.promptObject.prompt).not.toContain('" data-x');
      // The role attribute should be properly quoted with no breakout
      expect(body.promptObject.prompt).toMatch(/role="[a-z0-9_-]+"/);
    });

    test('falls back to "user" for empty role after sanitization', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { aiRecordDetail: { resultObject: 'safe response' } },
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      // Role that becomes empty after sanitization (only special chars)
      const res = await request(app)
        .post('/api/agent/chat')
        .send({
          messages: [{ role: '!@#$%^&*()', content: 'test' }],
        });

      expect(res.status).toBe(200);
      expect(callOneMin).toHaveBeenCalled();
      const payload = callOneMin.mock.calls[0][1];
      const body = JSON.parse(payload.body);
      // Should fall back to "user"
      expect(body.promptObject.prompt).toContain('role="user"');
    });

    test('allows valid role values (user, assistant, system)', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: { aiRecordDetail: { resultObject: 'safe response' } },
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const res = await request(app)
        .post('/api/agent/chat')
        .send({
          messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'system', content: 'context' },
          ],
        });

      expect(res.status).toBe(200);
      expect(callOneMin).toHaveBeenCalled();
      const payload = callOneMin.mock.calls[0][1];
      const body = JSON.parse(payload.body);
      expect(body.promptObject.prompt).toContain('role="user"');
      expect(body.promptObject.prompt).toContain('role="assistant"');
      expect(body.promptObject.prompt).toContain('role="system"');
    });
  });

  describe('CSP script-src nonce security', () => {
    test('includes nonce in script-src directive to block unauthorized inline scripts', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      const csp = res.headers['content-security-policy'] || '';
      // script-src must have nonce to block inline scripts without the nonce
      expect(csp).toMatch(/script-src[^;]*'nonce-/);
      // script-src should NOT have 'unsafe-inline' (nonce makes it ignored anyway)
      expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    });

    test('style-src includes unsafe-inline for Monaco CSSOM compatibility', async () => {
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).get('/api/health');

      expect(res.status).toBe(200);
      const csp = res.headers['content-security-policy'] || '';
      // style-src requires 'unsafe-inline' for Monaco's CSSOM insertRule operations
      expect(csp).toMatch(/style-src[^;]*'unsafe-inline'/);
    });
  });
});
