import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';

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
  });

  describe('GET/POST /api/agent/sessions/:id/files', () => {
    const testFile = path.join(process.cwd(), 'temp-agent-file-test.txt');

    afterEach(async () => {
      try {
        await fs.unlink(testFile);
      } catch {
        // ignore
      }
    });

    test('should write and read back a file in session context', async () => {
      const writeResponse = await request(app)
        .post(`/api/agent/sessions/${sessionId}/files`)
        .send({ path: testFile, content: 'hello agent\n' });

      expect(writeResponse.status).toBe(200);
      expect(writeResponse.body.ok).toBe(true);

      const readResponse = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('hello agent\n');
    });

    test('should block reading protected agent persistence paths in session context', async () => {
      const protectedFile = path.join(process.cwd(), '.mimocode', 'data', 'agent_sessions.json');
      await fs.mkdir(path.dirname(protectedFile), { recursive: true });
      await fs.writeFile(protectedFile, '{}', 'utf-8');

      const response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: protectedFile });

      expect(response.status).toBe(403);
    });

    test('should read a specific slice of lines when startLine and/or endLine are provided', async () => {
      const content = 'line1\nline2\nline3\nline4\nline5';
      await fs.writeFile(testFile, content, 'utf-8');

      // both startLine and endLine
      let readResponse = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile, startLine: 2, endLine: 4 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line2\nline3\nline4');

      // startLine only
      readResponse = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile, startLine: 3 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line3\nline4\nline5');

      // endLine only
      readResponse = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile, endLine: 2 });

      expect(readResponse.status).toBe(200);
      expect(readResponse.body.content).toBe('line1\nline2');
    });

    test('should reject invalid startLine and endLine values', async () => {
      await fs.writeFile(testFile, 'a\nb', 'utf-8');

      // startLine > endLine
      let response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile, startLine: 2, endLine: 1 });
      expect(response.status).toBe(400);

      // startLine 0
      response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/files`)
        .query({ path: testFile, startLine: 0 });
      expect(response.status).toBe(400);
    });
  });

  describe('POST /api/agent/sessions/:id/diff', () => {
    const testFile = path.join(process.cwd(), 'temp-diff-test.txt');

    beforeEach(async () => {
      await fs.writeFile(testFile, 'hello world\nthis is a test\nend of file', 'utf-8');
    });

    afterEach(async () => {
      try {
        await fs.unlink(testFile);
      } catch {
        // ignore
      }
    });

    test('should apply diff with search-and-replace block', async () => {
      const diffContent = `
<<<<<<< SEARCH
this is a test
=======
this has been patched successfully with diff
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
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
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
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
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
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
    test('should return 400 if search block not found', async () => {
      const diffContent = `
<<<<<<< SEARCH
nonexistent-string
=======
something
>>>>>>> REPLACE
`;
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
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
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
        path: testFile,
        diff: diffContent,
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(
        '置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません',
      );
    });

    test('should return 400 if no valid SEARCH/REPLACE blocks found', async () => {
      const response = await request(app).post(`/api/agent/sessions/${sessionId}/diff`).send({
        path: testFile,
        diff: 'invalid diff format',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('有効な SEARCH/REPLACE ブロックが見つかりませんでした');
    });
  });

  describe('GET /api/agent/sessions/:id/search', () => {
    const testSearchFile = path.join(process.cwd(), 'temp-search-test.txt');

    beforeEach(async () => {
      await fs.writeFile(testSearchFile, 'line one\nneedle line here\nline three', 'utf-8');
    });

    afterEach(async () => {
      try {
        await fs.unlink(testSearchFile);
      } catch {
        // ignore
      }
    });

    test('should find query in test file', async () => {
      const response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/search`)
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

    test('should return 400 for missing query', async () => {
      const response = await request(app).get(`/api/agent/sessions/${sessionId}/search`);

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Invalid input|query is required|Validation error/i);
    });

    test('should return 403 for protected search directory', async () => {
      const response = await request(app)
        .get(`/api/agent/sessions/${sessionId}/search`)
        .query({ query: 'dummy', dir: '.env' });

      expect(response.status).toBe(403);
    });
  });
});
