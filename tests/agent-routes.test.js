import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';

// Mock the api-client module
jest.unstable_mockModule('../utils/api-client.js', () => ({
    callOneMin: jest.fn(),
    extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
    normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
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
            expect(response.body.items.some(item => item.name === 'server.js' || item.isDirectory)).toBe(true);
        });

        test('should return 404 for invalid session', async () => {
            const response = await request(app)
                .get('/api/agent/sessions/invalid-id/dir')
                .query({ path: 'config' });

            expect(response.status).toBe(404);
            expect(response.body.error).toBe('Session not found');
        });

        test('should return 403 for protected path', async () => {
            const response = await request(app)
                .get(`/api/agent/sessions/${sessionId}/dir`)
                .query({ path: '.env' });

            expect(response.status).toBe(403);
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
            } catch {}
        });

        test('should apply diff with search-and-replace block', async () => {
            const diffContent = `
<<<<<<< SEARCH
this is a test
=======
this has been patched successfully with diff
>>>>>>> REPLACE
`;
            const response = await request(app)
                .post(`/api/agent/sessions/${sessionId}/diff`)
                .send({
                    path: testFile,
                    diff: diffContent
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
            const response = await request(app)
                .post(`/api/agent/sessions/${sessionId}/diff`)
                .send({
                    path: testFile,
                    diff: diffContent
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

        test('should return 400 if search block not found', async () => {
            const diffContent = `
<<<<<<< SEARCH
nonexistent-string
=======
something
>>>>>>> REPLACE
`;
            const response = await request(app)
                .post(`/api/agent/sessions/${sessionId}/diff`)
                .send({
                    path: testFile,
                    diff: diffContent
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
            const response = await request(app)
                .post(`/api/agent/sessions/${sessionId}/diff`)
                .send({
                    path: testFile,
                    diff: diffContent
                });

            expect(response.status).toBe(400);
            expect(response.body.error).toContain('置換対象の SEARCH ブロックのコードがファイル内に複数存在するため、一意に特定できません');
        });

        test('should return 400 if no valid SEARCH/REPLACE blocks found', async () => {
            const response = await request(app)
                .post(`/api/agent/sessions/${sessionId}/diff`)
                .send({
                    path: testFile,
                    diff: 'invalid diff format'
                });

            expect(response.status).toBe(400);
            expect(response.body.error).toContain('有効な SEARCH/REPLACE ブロックが見つかりませんでした');
        });
    });
});
