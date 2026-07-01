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

    test('should block shell metacharacters', () => {
      expect(checkCommandSafety('echo hello ; rm -rf /').safe).toBe(false);
      expect(checkCommandSafety('echo hello && rm -rf /').safe).toBe(false);
      expect(checkCommandSafety('echo $(whoami)').safe).toBe(false);
    });

    test('should block direct script execution flags', () => {
      expect(checkCommandSafety('node -e "console.log(1)"').safe).toBe(false);
      expect(checkCommandSafety('python -c "print(1)"').safe).toBe(false);
    });

    it('should allow quoted arguments without shell metacharacters', () => {
      const result = checkCommandSafety('npm list "some-package"');
      expect(result.safe).toBe(true);
    });

    it('should allow valid commands with metacharacters safely enclosed in quotes', () => {
      const result = checkCommandSafety('git commit -m "fix & update | refactor; done"');
      expect(result.safe).toBe(true);
    });

    it('should block format command', () => {
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
    it('should execute simple node command', async () => {
      const result = await executeCommand('node --version');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr).toBe('');
    });

    it('should capture stderr via a failing command', async () => {
      const result = await executeCommand('node non_existent_script_xyz.js');
      // Depending on OS, exit code will be > 0 and stderr will have error msg
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.length).toBeGreaterThan(0);
    });

    test('should handle command timeout', async () => {
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'ping -n 10 127.0.0.1' : 'sleep 10';
      const result = await executeCommand(cmd, { timeoutMs: 200 });
      expect(result.timedOut).toBe(true);
    }, 10000);

    test('should block dangerous commands', async () => {
      await expect(executeCommand('rm -rf /', { timeoutMs: 5000 })).rejects.toThrow('Command blocked');
    });

    test('should return non-zero exit code for failing command', async () => {
      const result = await executeCommand('exit 42', { timeoutMs: 5000 });
      expect(result.exitCode).toBe(42);
    });
  });
});
