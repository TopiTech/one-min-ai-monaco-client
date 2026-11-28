/**
 * Regression tests for the `node --check` subprocess usage in
 * services/code-analyzer.js.
 *
 * Root cause covered here: `spawnSync` does not throw when the child cannot be
 * started (EAGAIN, ENOENT, sandbox restrictions) or is killed by its timeout.
 * It returns `{ status: null, stderr: null, error }`. The analyzer parsed that
 * empty result as a syntax error, so *valid* code was reported as
 * `{ valid: false, error: 'Unknown syntax error' }` and the documented
 * in-process `vm.Script` fallback was unreachable dead code.
 */
import { jest } from '@jest/globals';

const spawnSyncMock = jest.fn();
jest.unstable_mockModule('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const { validateCodeSyntax } = await import('../services/code-analyzer.js');

const spawnFailure = (code = 'EAGAIN') => ({
  status: null,
  signal: null,
  stdout: '',
  stderr: null,
  error: Object.assign(new Error(`spawnSync ${process.execPath} ${code}`), { code }),
});

describe('validateCodeSyntax subprocess failures', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  test('validates valid JavaScript in-process when the check cannot be spawned', () => {
    spawnSyncMock.mockImplementation(() => spawnFailure());

    expect(validateCodeSyntax('const answer = 42;\n', 'javascript')).toEqual({ valid: true });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
  });

  test('reports the real parse error, not "Unknown syntax error", after a timeout', () => {
    spawnSyncMock.mockImplementation(() => spawnFailure('ETIMEDOUT'));

    const result = validateCodeSyntax('const answer = ;\n', 'javascript');

    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe('Unknown syntax error');
    expect(result.error).toMatch(/unexpected|invalid|missing/i);
    expect(result.line).toBe(1);
  });

  test('falls back for the CommonJS retry instead of reporting an empty status', () => {
    // First check reports the CommonJS-only construct, the retry cannot spawn.
    spawnSyncMock
      .mockImplementationOnce(() => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'syntax_check.js:2\nreturn 1;\n^^^^^^\n\nSyntaxError: Illegal return statement\n',
        error: undefined,
      }))
      .mockImplementationOnce(() => spawnFailure());

    const result = validateCodeSyntax('const answer = 42;\n', 'javascript');

    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ valid: true });
  });

  test('still reports genuine syntax errors returned by the subprocess', () => {
    spawnSyncMock.mockImplementation(() => ({
      status: 1,
      signal: null,
      stdout: '',
      stderr: "[stdin]:1\nconst answer = ;\n               ^\n\nSyntaxError: Unexpected token ';'\n",
      error: undefined,
    }));

    const result = validateCodeSyntax('const answer = ;\n', 'javascript');

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unexpected token/);
    expect(result.line).toBe(1);
  });
});
