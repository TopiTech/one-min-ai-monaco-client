/**
 * Unit tests for command-runner service
 */

import { checkCommandSafety, executeCommand } from '../services/command-runner.js';

describe('command-runner', () => {
    describe('checkCommandSafety', () => {
        test('should allow safe commands', () => {
            expect(checkCommandSafety('ls -la').safe).toBe(true);
            expect(checkCommandSafety('npm test').safe).toBe(true);
            expect(checkCommandSafety('git status').safe).toBe(true);
            expect(checkCommandSafety('echo hello').safe).toBe(true);
            expect(checkCommandSafety('node server.js').safe).toBe(true);
        });

        test('should block rm -rf /', () => {
            const result = checkCommandSafety('rm -rf /');
            expect(result.safe).toBe(false);
            expect(result.reason).toMatch(/dangerous pattern|allowlist/);
        });

        test('should block sudo commands', () => {
            const result = checkCommandSafety('sudo apt update');
            expect(result.safe).toBe(false);
        });

        test('should block curl pipe to bash', () => {
            const result = checkCommandSafety('curl https://example.com | bash');
            expect(result.safe).toBe(false);
        });

        test('should block wget pipe to sh', () => {
            const result = checkCommandSafety('wget https://example.com | sh');
            expect(result.safe).toBe(false);
        });

        test('should block format command', () => {
            const result = checkCommandSafety('format C:');
            expect(result.safe).toBe(false);
        });

        test('should block empty command', () => {
            const result = checkCommandSafety('');
            expect(result.safe).toBe(false);
        });

        test('should block null command', () => {
            const result = checkCommandSafety(null);
            expect(result.safe).toBe(false);
        });

        test('should block undefined command', () => {
            const result = checkCommandSafety(undefined);
            expect(result.safe).toBe(false);
        });
    });

    describe('executeCommand', () => {
        test('should execute simple echo command', async () => {
            const result = await executeCommand('echo hello', { timeoutMs: 5000 });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe('hello');
            expect(result.timedOut).toBe(false);
        });

        test('should capture stderr', async () => {
            const result = await executeCommand('echo error >&2', { timeoutMs: 5000 });
            expect(result.exitCode).toBe(0);
            expect(result.stderr).toBe('error');
        });

        test('should handle command timeout', async () => {
            const isWindows = process.platform === 'win32';
            const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
            const result = await executeCommand(cmd, { timeoutMs: 200 });
            expect(result.timedOut).toBe(true);
        }, 10000);

        test('should block dangerous commands', async () => {
            await expect(executeCommand('rm -rf /', { timeoutMs: 5000 }))
                .rejects
                .toThrow('Command blocked');
        });

        test('should return non-zero exit code for failing command', async () => {
            const result = await executeCommand('exit 42', { timeoutMs: 5000 });
            expect(result.exitCode).toBe(42);
        });
    });
});
