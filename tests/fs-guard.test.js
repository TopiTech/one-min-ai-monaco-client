/**
 * Unit tests for fs-guard utility
 */

import { validatePath, PROJECT_ROOT, getAllowedRoots, getDefaultRoot, isProtectedPath, isWriteProtectedPath, isProtectedPathForListing, assertNotProtectedPath, assertNotWriteProtectedPath } from '../utils/fs-guard.js';
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

    describe('isProtectedPath', () => {
        test('should identify protected project files and directories', () => {
            expect(isProtectedPath(path.join(PROJECT_ROOT, '.env'))).toBe(true);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'node_modules', 'left-pad'))).toBe(true);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'package.json'))).toBe(true);
            expect(isProtectedPath(path.join(PROJECT_ROOT, '.gitignore'))).toBe(true);
        });

        test('should allow reading normal project source paths', () => {
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'server.js'))).toBe(false);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'utils', 'fs-guard.js'))).toBe(false);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'public', 'app.js'))).toBe(false);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'src', 'app.js'))).toBe(false);
            expect(isProtectedPath(path.join(PROJECT_ROOT, 'workspace', 'notes.txt'))).toBe(false);
        });

        test('should identify protected files within custom allowed roots', () => {
            const originalEnv = process.env.ALLOWED_ROOTS;
            process.env.ALLOWED_ROOTS = '/tmp-custom-root';
            const customRoot = path.resolve('/tmp-custom-root');

            expect(isProtectedPath(path.join(customRoot, '.env'))).toBe(true);
            expect(isProtectedPath(path.join(customRoot, 'node_modules', 'foo'))).toBe(true);
            expect(isProtectedPath(path.join(customRoot, 'package.json'))).toBe(true);
            expect(isProtectedPath(path.join(customRoot, 'src', 'app.js'))).toBe(false);

            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should throw 403 for protected paths', () => {
            try {
                assertNotProtectedPath(path.join(PROJECT_ROOT, 'package.json'));
            } catch (err) {
                expect(err.status).toBe(403);
            }
        });
    });

    describe('isProtectedPathForListing', () => {
        const originalEnv = process.env.ALLOWED_ROOTS;

        afterEach(() => {
            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should allow listing the default allowed root itself', () => {
            delete process.env.ALLOWED_ROOTS;
            expect(isProtectedPathForListing(PROJECT_ROOT)).toBe(false);
        });

        test('should allow listing a custom allowed root itself', () => {
            process.env.ALLOWED_ROOTS = '/custom/root';
            const customRoot = path.resolve('/custom/root');
            expect(isProtectedPathForListing(customRoot)).toBe(false);
        });

        test('should block listing protected prefixes inside allowed roots', () => {
            delete process.env.ALLOWED_ROOTS;
            expect(isProtectedPathForListing(path.join(PROJECT_ROOT, '.git'))).toBe(true);
            expect(isProtectedPathForListing(path.join(PROJECT_ROOT, 'node_modules', 'pkg'))).toBe(true);
        });

        test('should block protected prefixes inside custom allowed roots', () => {
            process.env.ALLOWED_ROOTS = '/custom/root';
            const customRoot = path.resolve('/custom/root');
            expect(isProtectedPathForListing(path.join(customRoot, '.env'))).toBe(true);
            expect(isProtectedPathForListing(path.join(customRoot, 'src', 'app.js'))).toBe(false);
        });
    });

    describe('isWriteProtectedPath', () => {
        test('should protect source and project infrastructure from destructive operations', () => {
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'server.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'utils', 'fs-guard.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'routes', 'fs.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'public', 'app.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'tests', 'fs-guard.test.js'))).toBe(true);
        });

        test('should allow normal writable project paths', () => {
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'src', 'app.js'))).toBe(false);
            expect(isWriteProtectedPath(path.join(PROJECT_ROOT, 'workspace', 'notes.txt'))).toBe(false);
        });

        test('should identify write-protected files within custom allowed roots', () => {
            const originalEnv = process.env.ALLOWED_ROOTS;
            process.env.ALLOWED_ROOTS = '/tmp-custom-root';
            const customRoot = path.resolve('/tmp-custom-root');

            expect(isWriteProtectedPath(path.join(customRoot, '.env'))).toBe(true);
            expect(isWriteProtectedPath(path.join(customRoot, 'server.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(customRoot, 'utils', 'fs-guard.js'))).toBe(true);
            expect(isWriteProtectedPath(path.join(customRoot, 'node_modules', 'foo'))).toBe(true);
            expect(isWriteProtectedPath(path.join(customRoot, 'src', 'app.js'))).toBe(false);

            if (originalEnv === undefined) {
                delete process.env.ALLOWED_ROOTS;
            } else {
                process.env.ALLOWED_ROOTS = originalEnv;
            }
        });

        test('should throw 403 for write-protected paths', () => {
            try {
                assertNotWriteProtectedPath(path.join(PROJECT_ROOT, 'server.js'));
            } catch (err) {
                expect(err.status).toBe(403);
            }
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
            expect(validatePath(relativePath).toLowerCase()).toBe(expectedPath.toLowerCase());
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
