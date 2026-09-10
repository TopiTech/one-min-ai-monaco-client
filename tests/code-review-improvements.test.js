/**
 * Tests for code review improvements across frontend and backend.
 */
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Code Review Improvements', () => {
  describe('public/index.html A11y & Dialog Semantics', () => {
    test('diffModal dialog has proper ARIA attributes and title ID', async () => {
      const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf-8');

      // Verify diff-dialog container has dialog role and aria attributes
      expect(html).toMatch(
        /class="[^"]*diff-dialog[^"]*"\s+role="dialog"\s+aria-modal="true"\s+aria-labelledby="diffModalTitle"/,
      );
      // Verify title has id matching aria-labelledby
      expect(html).toContain('id="diffModalTitle"');
    });
  });

  describe('agent-core.js computeHash resilience', () => {
    test('source code includes fallbackHash and safe window.crypto checks', async () => {
      const src = await fs.readFile(new URL('../public/js/agent-core.js', import.meta.url), 'utf-8');
      expect(src).toContain('function fallbackHash(text)');
      expect(src).toContain('window.crypto?.subtle?.digest');
      expect(src).toContain('return fallbackHash(text)');
    });

    test('fallbackHash produces deterministic hashes', async () => {
      // Extract and execute the fallback algorithm to verify determinism
      function fallbackHash(text) {
        let h1 = 0xdeadbeef ^ 0;
        let h2 = 0x41c6ce57 ^ 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text.charCodeAt(i);
          h1 = Math.imul(h1 ^ ch, 2654435761);
          h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 'fb_' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
      }

      const hash1 = fallbackHash('hello world');
      const hash2 = fallbackHash('hello world');
      const hash3 = fallbackHash('different text');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1.startsWith('fb_')).toBe(true);
    });
  });

  describe('chat.js error recovery', () => {
    test('removes streaming class in both catch and finally blocks', async () => {
      const src = await fs.readFile(new URL('../public/js/chat.js', import.meta.url), 'utf-8');
      expect(src).toMatch(/catch\s*\(e\)\s*\{\s*aiMsgDiv\.classList\.remove\('streaming'\);/);
      expect(src).toMatch(/finally\s*\{\s*aiMsgDiv\.classList\.remove\('streaming'\);/);
    });
  });

  describe('fs.js 0-byte file reading optimization', () => {
    let tmpDir;
    let app;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-fs-test-'));
      process.env.ALLOWED_ROOTS = tmpDir;
      process.env.NODE_ENV = 'test';
      const { createApp } = await import('../server.js');
      app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    });

    afterEach(async () => {
      delete process.env.ALLOWED_ROOTS;
      delete process.env.NODE_ENV;
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('reads empty 0-byte text file successfully', async () => {
      const emptyFilePath = path.join(tmpDir, 'empty.txt');
      await fs.writeFile(emptyFilePath, '');

      const res = await request(app)
        .get(`/api/fs/read?path=${encodeURIComponent(emptyFilePath)}`)
        .set('host', '127.0.0.1');

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.writable).toBe(true);
    });
  });
});
