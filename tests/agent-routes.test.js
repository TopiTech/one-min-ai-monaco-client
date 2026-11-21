import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { clearAllowedRootsCache } from '../utils/fs-guard.js';

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

const { createApp } = await import('../server.js');
const { parseSearchReplaceBlocks, cleanupExpiredSessions, pendingCommands } =
  await import('../routes/agent.js');

describe('Agent Directory and Patch Routes', () => {
  let app;
  let sessionId;

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    // Create a session first to work with
    const response = await request(app)
      .post('/api/agent/sessions')
      .send({ cwd: process.cwd(), task: 'Test task' });

    sessionId = response.body.session.id;
  });

  test('rejects oversized session metadata before it is retained in memory', async () => {
    const response = await request(app)
      .post('/api/agent/sessions')
      .send({ task: 'x'.repeat(50001) });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('50000');
  });

  afterEach(() => {
    delete process.env.NODE_ENV;
  });

  describe('GET /api/agent/sessions/:id/dir', () => {
    test('should list contents of the directory', async () => {
      const response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/dir`)
        .query({ path: 'config' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('items');
      expect(Array.isArray(response.body.items)).toBe(true);
      expect(response.body.items.some((item) => item.name === 'server.js' || item.isDirectory)).toBe(true);
    });

    test('should return 404 for invalid session', async () => {
      const response = await request(app).get('/api/agent/sessions/invalid-id/dir').query({ path: 'config' });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Session not found');
    });

    test('should return 403 for protected path', async () => {
      const response = await request(app).get(`/api/agent/sessions/${sessionId}/dir`).query({ path: '.env' });

      expect(response.status).toBe(403);
    });

    test('should reject duplicate path query parameters', async () => {
      const response = await request(app).get(`/api/agent/sessions/${sessionId}/dir?path=config&path=public`);

      expect(response.status).toBe(400);
    });
  });

  describe('GET/POST /api/agent/sessions/:id/files', () => {
    let localTmpDir;
    let localSessionId;
    let testFile;
    let prevRoots;

    beforeEach(async () => {
      prevRoots = process.env.ALLOWED_ROOTS;
      localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-files-test-'));
      process.env.ALLOWED_ROOTS = localTmpDir;
      clearAllowedRootsCache();
      testFile = path.join(localTmpDir, 'temp-agent-file-test.txt');

      const res = await request(app)
        .post('/api/agent/sessions')
        .send({ cwd: localTmpDir, task: 'Files test' });
      localSessionId = res.body.session.id;
    });

    afterEach(async () => {
      if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
      else process.env.ALLOWED_ROOTS = prevRoots;
      clearAllowedRootsCache();
      await fs.rm(localTmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('should write and read back a file in session context', async () => {
      const writeResponse = await request(app)
        .post(`/api/agent/sessions/${localSessionId}/files`)
        .send({ path: testFile, content: 'hello agent\n' });

      expect(writeResponse.status).toBe(200);
      expect(writeResponse.body.ok).toBe(true);

      const readResponse = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('hello agent\n');
    });

    test('should block reading protected agent persistence paths in session context', async () => {
      const protectedFile = path.join(localTmpDir, '.onemin-ai', 'data', 'agent_sessions.json');
      await fs.mkdir(path.dirname(protectedFile), { recursive: true });
      await fs.writeFile(protectedFile, '{}', 'utf-8');

      const response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: protectedFile });

      expect(response.status).toBe(403);
    });

    test('should block writing to symlinks and directories via agent files and diff endpoints', async () => {
      const subDir = path.join(localTmpDir, 'dir-target');
      await fs.mkdir(subDir, { recursive: true });

      const dirWriteRes = await request(app)
        .post(`/api/agent/sessions/${localSessionId}/files`)
        .send({ path: subDir, content: 'overwrite' });
      expect(dirWriteRes.status).toBe(400);

      const realTarget = path.join(localTmpDir, 'real-dir');
      await fs.mkdir(realTarget, { recursive: true });
      const junction = path.join(localTmpDir, 'link-dir');
      try {
        await fs.symlink(realTarget, junction, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;
      }

      const linkWriteRes = await request(app)
        .post(`/api/agent/sessions/${localSessionId}/files`)
        .send({ path: junction, content: 'blocked' });
      expect(linkWriteRes.status).toBe(403);

      const linkDiffRes = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: junction,
        diff: '<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE',
      });
      expect(linkDiffRes.status).toBe(403);
    });

    test('should read a specific slice of lines when startLine and/or endLine are provided', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      await fs.writeFile(testFile, content, 'utf-8');

      // both startLine and endLine
      let readResponse = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile, startLine: 2, endLine: 4 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line2\nline3\nline4');

      // startLine only
      readResponse = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile, startLine: 3 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line3\nline4\nline5');

      // endLine only
      readResponse = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile, endLine: 2 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line1\nline2');
    });

    test('should reject invalid startLine and endLine values', async () => {
      await fs.writeFile(testFile, 'a\nb', 'utf-8');

      // startLine > endLine
      let response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile, startLine: 2, endLine: 1 });
      expect(response.status).toBe(400);

      // startLine 0
      response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/files`)
        .query({ path: testFile, startLine: 0 });
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/agent/sessions/:id/diff', () => {
    let localTmpDir;
    let localSessionId;
    let testFile;
    let prevRoots;

    beforeEach(async () => {
      prevRoots = process.env.ALLOWED_ROOTS;
      localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-diff-test-'));
      process.env.ALLOWED_ROOTS = localTmpDir;
      clearAllowedRootsCache();
      testFile = path.join(localTmpDir, 'temp-diff-test.txt');
      await fs.writeFile(testFile, 'hello world\nthis is a test\nend of file', 'utf-8');

      const res = await request(app)
        .post('/api/agent/sessions')
        .send({ cwd: localTmpDir, task: 'Diff test' });
      localSessionId = res.body.session.id;
    });

    afterEach(async () => {
      if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
      else process.env.ALLOWED_ROOTS = prevRoots;
      clearAllowedRootsCache();
      await fs.rm(localTmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('should apply diff with search-and-replace block', async () => {
      const diffContent = `
<<<<<<< SEARCH
this is a test
=======
this has been patched successfully with diff
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.message).toContain('1個のブロックの置換に成功しました。');

      const fileContent = await fs.readFile(testFile, 'utf-8');
      expect(fileContent).toContain('this has been patched successfully with diff');
      expect(fileContent).not.toContain('this is a test');
    });

    test('should apply multi-block diff successfully', async () => {
      const diffContent = `
<<<<<<< SEARCH
hello world
=======
welcome everyone
>>>>>>> REPLACE

<<<<<<< SEARCH
end of file
=======
fin.
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.message).toContain('2個のブロックの置換に成功しました。');

      const fileContent = await fs.readFile(testFile, 'utf-8');
      expect(fileContent).toContain('welcome everyone');
      expect(fileContent).toContain('fin.');
      expect(fileContent).not.toContain('hello world');
      expect(fileContent).not.toContain('end of file');
    });

    test('should apply diff even if leading indentation of search block is mismatched', async () => {
      const diffContent = `
<<<<<<< SEARCH
  this is a test
=======
  this has been patched successfully with diff
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);

      const fileContent = await fs.readFile(testFile, 'utf-8');
      expect(fileContent).toContain('this has been patched successfully with diff');
      expect(fileContent).not.toContain('  this has been patched successfully with diff');
      expect(fileContent).not.toContain('this is a test');
    });

    test('should delete code when diff REPLACE block is empty', async () => {
      const diffContent = `
<<<<<<< SEARCH
this is a test
=======
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);

      const fileContent = await fs.readFile(testFile, 'utf-8');
      expect(fileContent).not.toContain('this is a test');
    });

    test('should return 400 if search block not found', async () => {
      const diffContent = `
<<<<<<< SEARCH
nonexistent-string
=======
something
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('置換対象の SEARCH ブロックのコードが見つかりません');
    });

    test('should return 400 if search block has multiple matches', async () => {
      // Write content with duplicate strings
      await fs.writeFile(testFile, 'dup\ndup\nend', 'utf-8');

      const diffContent = `
<<<<<<< SEARCH
dup
=======
replaced
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        '置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません',
      );
    });

    test('should return 400 if no valid SEARCH/REPLACE blocks found', async () => {
      const response = await request(app).post(`/api/agent/sessions/${localSessionId}/diff`).send({
        path: testFile,
        diff: 'invalid diff format',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('有効な SEARCH/REPLACE ブロックが見つかりませんでした');
    });

    test('should reject an oversized diff before reading the target file', async () => {
      const response = await request(app)
        .post(`/api/agent/sessions/${localSessionId}/diff`)
        .send({
          path: testFile,
          diff: 'x'.repeat(500001),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('500000');
    });
  });

  describe('GET /api/agent/sessions/:id/search', () => {
    let localTmpDir;
    let localSessionId;
    let testSearchFile;
    let prevRoots;

    beforeEach(async () => {
      prevRoots = process.env.ALLOWED_ROOTS;
      localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-search-test-'));
      process.env.ALLOWED_ROOTS = localTmpDir;
      clearAllowedRootsCache();
      testSearchFile = path.join(localTmpDir, 'temp-search-test.txt');
      await fs.writeFile(testSearchFile, 'line one\nneedle line here\nline three', 'utf-8');

      const res = await request(app)
        .post('/api/agent/sessions')
        .send({ cwd: localTmpDir, task: 'Search test' });
      localSessionId = res.body.session.id;
    });

    afterEach(async () => {
      if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
      else process.env.ALLOWED_ROOTS = prevRoots;
      clearAllowedRootsCache();
      await fs.rm(localTmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('should find query in test file', async () => {
      const response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/search`)
        .query({ query: 'needle' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('query', 'needle');
      expect(response.body).toHaveProperty('results');
      expect(Array.isArray(response.body.results)).toBe(true);
      const found = response.body.results.find((r) => r.file.includes('temp-search-test.txt'));
      expect(found).toBeDefined();
      expect(found.line).toBe(2);
      expect(found.content).toContain('needle line here');
    });

    test('should correctly parse search results when line content contains colons and numbers', async () => {
      await fs.writeFile(
        testSearchFile,
        'line one\nconst apiUrl = "http://localhost:3000/api/v1";\nline three',
        'utf-8',
      );
      const response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/search`)
        .query({ query: 'http://localhost:3000' });

      expect(response.status).toBe(200);
      const found = response.body.results.find((r) => r.file.includes('temp-search-test.txt'));
      expect(found).toBeDefined();
      expect(found.line).toBe(2);
      expect(found.content).toContain('http://localhost:3000/api/v1');
    });

    test('should return 400 for missing query', async () => {
      const response = await request(app).get(`/api/agent/sessions/${localSessionId}/search`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Invalid input|query is required|Validation error/i);
    });

    test('should return 403 for protected search directory', async () => {
      const response = await request(app)
        .get(`/api/agent/sessions/${localSessionId}/search`)
        .query({ query: 'dummy', dir: '.env' });

      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /api/agent/sessions/:id and /api/agent/sessions/all', () => {
    test('should delete an individual session', async () => {
      // Create another session to test deletion
      const res = await request(app)
        .post('/api/agent/sessions')
        .send({ cwd: process.cwd(), task: 'Task to delete' });
      const idToDelete = res.body.session.id;

      const deleteRes = await request(app).delete(`/api/agent/sessions/${idToDelete}`);
      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body.ok).toBe(true);

      const getRes = await request(app).get(`/api/agent/sessions/${idToDelete}`);
      expect(getRes.status).toBe(404);
    });

    test('should return 404 when deleting non-existent session', async () => {
      const deleteRes = await request(app).delete('/api/agent/sessions/non-existent-session-id');
      expect(deleteRes.status).toBe(404);
    });

    test('should delete all idle sessions', async () => {
      const clearRes = await request(app).delete('/api/agent/sessions/all');
      expect(clearRes.status).toBe(200);
      expect(clearRes.body.ok).toBe(true);
      expect(typeof clearRes.body.cleared).toBe('number');
    });
  });

  describe('parseSearchReplaceBlocks unit tests', () => {
    test('parses single block with replacement', () => {
      const diff = '<<<<<<< SEARCH\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> REPLACE';
      const blocks = parseSearchReplaceBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('const a = 1;');
      expect(blocks[0].replace).toBe('const a = 2;');
      expect(blocks[0].searchLines).toEqual(['const a = 1;']);
      expect(blocks[0].replaceLines).toEqual(['const a = 2;']);
    });

    test('parses empty replace block as deletion (0 replaceLines)', () => {
      const diff = '<<<<<<< SEARCH\nconst a = 1;\n=======\n>>>>>>> REPLACE';
      const blocks = parseSearchReplaceBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('const a = 1;');
      expect(blocks[0].replace).toBe('');
      expect(blocks[0].searchLines).toEqual(['const a = 1;']);
      expect(blocks[0].replaceLines).toEqual([]);
    });

    test('parses multi-block with CRLF endings', () => {
      const diff =
        '<<<<<<< SEARCH\r\nfoo\r\n=======\r\nbar\r\n>>>>>>> REPLACE\r\n<<<<<<< SEARCH\r\nbaz\r\n=======\r\n>>>>>>> REPLACE';
      const blocks = parseSearchReplaceBlocks(diff);
      expect(blocks).toHaveLength(2);
      expect(blocks[0].search).toBe('foo');
      expect(blocks[0].replace).toBe('bar');
      expect(blocks[1].search).toBe('baz');
      expect(blocks[1].replaceLines).toEqual([]);
    });

    test('ignores conversational preamble and postscript', () => {
      const diff =
        'Here is the diff to apply:\n<<<<<<< SEARCH\nfoo\n=======\nbar\n>>>>>>> REPLACE\nHope that helps!';
      const blocks = parseSearchReplaceBlocks(diff);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].search).toBe('foo');
      expect(blocks[0].replace).toBe('bar');
    });

    test('returns empty array for invalid input', () => {
      expect(parseSearchReplaceBlocks(null)).toEqual([]);
      expect(parseSearchReplaceBlocks('')).toEqual([]);
      expect(parseSearchReplaceBlocks('no markers')).toEqual([]);
      expect(parseSearchReplaceBlocks('<<<<<<< SEARCH\nno closing')).toEqual([]);
    });
  });

  describe('cleanupExpiredSessions', () => {
    test('purges expired pending commands and retains unexpired ones', () => {
      const now = Date.now();
      pendingCommands.set('expired-token', { createdAt: now - 6 * 60 * 1000, command: 'ls' });
      pendingCommands.set('valid-token', { createdAt: now - 1 * 60 * 1000, command: 'pwd' });

      cleanupExpiredSessions();

      expect(pendingCommands.has('expired-token')).toBe(false);
      expect(pendingCommands.has('valid-token')).toBe(true);

      // Clean up
      pendingCommands.delete('valid-token');
    });

    test('purges pending commands belonging to sessions expired during cleanup', async () => {
      const createdRes = await request(app).post('/api/agent/sessions').send({ cwd: process.cwd() });
      expect(createdRes.status).toBe(200);
      const staleId = createdRes.body.session.id;

      const futureNow = Date.now() + 2 * 60 * 60 * 1000;
      pendingCommands.set('orphan-tok', {
        createdAt: futureNow - 1000,
        sessionId: staleId,
        command: 'pwd',
      });
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(futureNow);
      try {
        cleanupExpiredSessions();
        expect(pendingCommands.has('orphan-tok')).toBe(false);
      } finally {
        pendingCommands.delete('orphan-tok');
        nowSpy.mockRestore();
      }
    });

    test('hides protected files such as .env, secrets.json, and package.json in dir and find-files listings', async () => {
      const localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dir-protect-'));
      const prevRoots = process.env.ALLOWED_ROOTS;
      const prevEnv = process.env.NODE_ENV;
      process.env.ALLOWED_ROOTS = localTmpDir;
      process.env.NODE_ENV = 'test';
      clearAllowedRootsCache();

      try {
        await fs.writeFile(path.join(localTmpDir, '.env'), 'SECRET=1');
        await fs.writeFile(path.join(localTmpDir, 'secrets.json'), '{}');
        await fs.writeFile(path.join(localTmpDir, 'visible.txt'), 'hello');

        const localApp = createApp({ requireLocalAuth: false, enableRateLimit: false });
        const sessionRes = await request(localApp).post('/api/agent/sessions').send({ cwd: localTmpDir });
        const localSessionId = sessionRes.body.session.id;

        const dirRes = await request(localApp).get(`/api/agent/sessions/${localSessionId}/dir`);
        expect(dirRes.status).toBe(200);
        const dirNames = dirRes.body.items.map((item) => item.name);
        expect(dirNames).toContain('visible.txt');
        expect(dirNames).not.toContain('.env');
        expect(dirNames).not.toContain('secrets.json');

        const findRes = await request(localApp).get(`/api/agent/sessions/${localSessionId}/find-files`);
        expect(findRes.status).toBe(200);
        const foundNames = findRes.body.files.map((item) => item.name);
        expect(foundNames).toContain('visible.txt');
        expect(foundNames).not.toContain('secrets.json');
        expect(foundNames).not.toContain('.env');
      } finally {
        if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
        else process.env.ALLOWED_ROOTS = prevRoots;
        if (prevEnv === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prevEnv;
        clearAllowedRootsCache();
        await fs.rm(localTmpDir, { recursive: true, force: true });
      }
    });

    test('resolves relative /dir paths against session.cwd, blocks symlink escapes, and maps missing/non-dir to 404/400', async () => {
      const localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dir-cwd-'));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-dir-outside-'));
      const prevRoots = process.env.ALLOWED_ROOTS;
      process.env.ALLOWED_ROOTS = localTmpDir;
      clearAllowedRootsCache();

      try {
        const subDir = path.join(localTmpDir, 'nested');
        await fs.mkdir(subDir, { recursive: true });
        await fs.writeFile(path.join(subDir, 'inside.js'), 'export const ok = true;\n');

        const localApp = createApp({ requireLocalAuth: false, enableRateLimit: false });
        const sessionRes = await request(localApp).post('/api/agent/sessions').send({ cwd: localTmpDir });
        const localSessionId = sessionRes.body.session.id;

        // Relative path resolved against session.cwd (not PROJECT_ROOT)
        const dirRes = await request(localApp)
          .get(`/api/agent/sessions/${localSessionId}/dir`)
          .query({ path: 'nested' });
        expect(dirRes.status).toBe(200);
        expect(dirRes.body.items.map((i) => i.name)).toContain('inside.js');

        // Non-existent directory -> 404
        const missingRes = await request(localApp)
          .get(`/api/agent/sessions/${localSessionId}/dir`)
          .query({ path: 'does-not-exist' });
        expect(missingRes.status).toBe(404);

        // File path instead of directory -> 400
        const fileAsDirRes = await request(localApp)
          .get(`/api/agent/sessions/${localSessionId}/dir`)
          .query({ path: 'nested/inside.js' });
        expect(fileAsDirRes.status).toBe(400);

        const searchFileAsDir = await request(localApp)
          .get(`/api/agent/sessions/${localSessionId}/search`)
          .query({ query: 'ok', dir: 'nested/inside.js' });
        expect(searchFileAsDir.status).toBe(400);

        const findFileAsDir = await request(localApp)
          .get(`/api/agent/sessions/${localSessionId}/find-files`)
          .query({ dir: 'nested/inside.js' });
        expect(findFileAsDir.status).toBe(400);

        // Symlink escaping allowed roots must be blocked with 403 across /dir, /search, /find-files
        await fs.writeFile(path.join(outsideDir, 'secret.txt'), 'secret-needle\n');
        const linkDir = path.join(localTmpDir, 'escape-dir');
        let symlinkCreated = false;
        try {
          await fs.symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
          symlinkCreated = true;
        } catch {
          symlinkCreated = false;
        }

        if (symlinkCreated) {
          const escDir = await request(localApp)
            .get(`/api/agent/sessions/${localSessionId}/dir`)
            .query({ path: 'escape-dir' });
          expect(escDir.status).toBe(403);

          const escSearch = await request(localApp)
            .get(`/api/agent/sessions/${localSessionId}/search`)
            .query({ query: 'secret-needle', dir: 'escape-dir' });
          expect(escSearch.status).toBe(403);

          const escFind = await request(localApp)
            .get(`/api/agent/sessions/${localSessionId}/find-files`)
            .query({ dir: 'escape-dir' });
          expect(escFind.status).toBe(403);
        }
      } finally {
        if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
        else process.env.ALLOWED_ROOTS = prevRoots;
        clearAllowedRootsCache();
        await fs.rm(localTmpDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    test('concurrent session creation enforces agentMaxSessions and retains in-memory history without disk persistence', async () => {
      const { serverConfig } = await import('../config/server.js');
      const prevMax = serverConfig.agentMaxSessions;
      const prevPersist = serverConfig.persistAgentSessions;
      const prevAutoApprove = serverConfig.agentAutoApprove;
      const prevExec = serverConfig.enableCommandExecution;
      const prevRoots = process.env.ALLOWED_ROOTS;
      const localTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-lock-hist-'));
      process.env.ALLOWED_ROOTS = localTmpDir;
      clearAllowedRootsCache();

      try {
        const listRes = await request(app).get('/api/agent/sessions');
        await Promise.all(
          (listRes.body.sessions || []).map((s) => request(app).delete(`/api/agent/sessions/${s.id}`)),
        );

        serverConfig.agentMaxSessions = 2;
        const created = await Promise.all([
          request(app).post('/api/agent/sessions').send({ cwd: localTmpDir, task: 'c1' }),
          request(app).post('/api/agent/sessions').send({ cwd: localTmpDir, task: 'c2' }),
          request(app).post('/api/agent/sessions').send({ cwd: localTmpDir, task: 'c3' }),
          request(app).post('/api/agent/sessions').send({ cwd: localTmpDir, task: 'c4' }),
        ]);
        expect(created.every((r) => r.status === 200)).toBe(true);
        const afterList = await request(app).get('/api/agent/sessions');
        expect(afterList.body.sessions.length).toBeLessThanOrEqual(2);

        serverConfig.persistAgentSessions = false;
        serverConfig.agentAutoApprove = true;
        serverConfig.enableCommandExecution = true;
        const targetSessionId = created[0].body.session.id;
        // Pick the surviving session in case created[0] was evicted during concurrent burst
        const survivorId = afterList.body.sessions[0]?.id || targetSessionId;
        const cmdRes = await request(app)
          .post(`/api/agent/sessions/${survivorId}/commands`)
          .send({ command: 'node --version' });
        expect(cmdRes.status).toBe(200);

        const sessionInfo = await request(app).get(`/api/agent/sessions/${survivorId}`);
        expect(sessionInfo.status).toBe(200);
        expect(sessionInfo.body.session.history.length).toBeGreaterThanOrEqual(1);
      } finally {
        serverConfig.agentMaxSessions = prevMax;
        serverConfig.persistAgentSessions = prevPersist;
        serverConfig.agentAutoApprove = prevAutoApprove;
        serverConfig.enableCommandExecution = prevExec;
        if (prevRoots === undefined) delete process.env.ALLOWED_ROOTS;
        else process.env.ALLOWED_ROOTS = prevRoots;
        clearAllowedRootsCache();
        await fs.rm(localTmpDir, { recursive: true, force: true });
      }
    });
  });
});
