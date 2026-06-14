/**
 * Unit tests for fs-guard utility
 */

import { validatePath, PROJECT_ROOT, getAllowedRoots, getDefaultRoot } from '../utils/fs-guard.js';
import path from 'path';

describe('fs-guard', () => {
    describe('PROJECT_ROOT', () => {
        test('should be an absolute path', () => {
            expect(path.isAbsolute(PROJECT_ROOT)).toBe(true);
        });
    });

    describe('getAllowedRoots', () => {
        const originalEnv = process.env.ALLOWED_ROOTS;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should return only PROJECT_ROOT when ALLOWED_ROOTS is not set', () => {
            delete process.env.ALLOWED_ROOTS;
            const roots = getAllowedRoots();
            expect(roots).toEqual([PROJECT_ROOT]);
        });

        test('should return only PROJECT_ROOT when ALLOWED_ROOTS is empty', () => {
            process.env.ALLOWED_ROOTS = '';
            const roots = getAllowedRoots();
            expect(roots).toEqual([PROJECT_ROOT]);
        });

        test('should parse comma-separated ALLOWED_ROOTS and include PROJECT_ROOT', () => {
            process.env.ALLOWED_ROOTS = '/tmp,/home';
            const roots = getAllowedRoots();
            expect(roots).toContain(PROJECT_ROOT);
            expect(roots).toContain(path.resolve('/tmp'));
            expect(roots).toContain(path.resolve('/home'));
        });

        test('should always include PROJECT_ROOT as first entry', () => {
            process.env.ALLOWED_ROOTS = '/tmp';
            const roots = getAllowedRoots();
            expect(roots[0]).toBe(PROJECT_ROOT);
        });
    });

    describe('getDefaultRoot', () => {
        const originalEnv = process.env.ALLOWED_ROOTS;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should return PROJECT_ROOT when no custom roots', () => {
            delete process.env.ALLOWED_ROOTS;
            expect(getDefaultRoot()).toBe(PROJECT_ROOT);
        });

        test('should return first custom root when set', () => {
            process.env.ALLOWED_ROOTS = '/custom/root';
            expect(getDefaultRoot()).toBe(path.resolve('/custom/root'));
        });
    });

    describe('validatePath', () => {
        const originalEnv = process.env.ALLOWED_ROOTS;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should accept valid path within project root', () => {
            delete process.env.ALLOWED_ROOTS;
            const testPath = path.join(PROJECT_ROOT, 'test-file.txt');
            expect(validatePath(testPath)).toBe(testPath);
        });

        test('should accept project root itself', () => {
            delete process.env.ALLOWED_ROOTS;
            expect(validatePath(PROJECT_ROOT)).toBe(PROJECT_ROOT);
        });

        test('should reject path within parent directory (narrow default)', () => {
            delete process.env.ALLOWED_ROOTS;
            const testPath = path.join(path.dirname(PROJECT_ROOT), 'test-file.txt');
            expect(() => validatePath(testPath)).toThrow('Access denied');
        });

        test('should accept relative path within project', () => {
            delete process.env.ALLOWED_ROOTS;
            const relativePath = 'src/app.js';
            const expectedPath = path.resolve(relativePath);
            expect(validatePath(relativePath)).toBe(expectedPath);
        });

        test('should reject path outside default allowed roots', () => {
            delete process.env.ALLOWED_ROOTS;
            const outsidePath = path.resolve('/outside-one-min-ai-monaco-client');
            expect(() => validatePath(outsidePath)).toThrow('Access denied');
        });

        test('should reject path traversal attempt', () => {
            delete process.env.ALLOWED_ROOTS;
            const traversalPath = path.join(PROJECT_ROOT, '..', '..', 'etc', 'passwd');
            expect(() => validatePath(traversalPath)).toThrow('Access denied');
        });

        test('should reject empty path', () => {
            expect(() => validatePath('')).toThrow('Path is required');
        });

        test('should reject null path', () => {
            expect(() => validatePath(null)).toThrow('Path is required');
        });

        test('should reject undefined path', () => {
            expect(() => validatePath(undefined)).toThrow('Path is required');
        });

        test('should set 403 status on access denied error', () => {
            delete process.env.ALLOWED_ROOTS;
            try {
                validatePath('/outside/path');
            } catch (err) {
                expect(err.status).toBe(403);
            }
        });

        test('should accept path within custom allowed root', () => {
            process.env.ALLOWED_ROOTS = '/tmp';
            const testPath = path.resolve('/tmp/test-file.txt');
            expect(validatePath(testPath)).toBe(testPath);
        });

        test('should reject path outside all allowed roots', () => {
            process.env.ALLOWED_ROOTS = '/tmp';
            expect(() => validatePath('/etc/passwd')).toThrow('Access denied');
        });
    });
});
