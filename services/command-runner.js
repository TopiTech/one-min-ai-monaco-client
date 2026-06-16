import { spawn } from "child_process";
import { platform } from "os";
import { serverConfig } from "../config/server.js";

/**
 * Command execution service with timeout, output collection, and safety checks.
 */

// Default timeout from environment or 30 seconds
const DEFAULT_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "30000", 10);

const ALLOWED_COMMAND_PREFIXES = [
  "npm ", "npx ", "node ", "git ", "jest ", "tsc ", "dir ", "ls ",
  "echo ", "cat ", "grep ", "pwd ", "whoami ", "python ", "pip ", "pipenv ",
  "ping ", "sleep ", "exit "
];

// Dangerous patterns that are blocked by default
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\*/,
  /rm\s+-rf\s+~/,
  /del\s+\/s\s+\/q/,
  /format\s+[a-z]:/i,
  /sudo\s+/,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
  />\s*\/dev\/(sda|hd[a-z])/,
  /dd\s+if=.*of=\/dev/,
  /mkfs\./,
  /:\(\)\s*\{.*\}\s*;/, // Fork bomb
  // Additional injection patterns
  /;\s*rm\s+/,
  /\|\s*rm\s+/,
  /`\s*rm\s+/,
  /\$\(.*rm\s+/,
  /eval\s*\(/,
  /exec\s*\(/,
  /child_process/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /process\.env/,
  /Buffer\.from\s*\(/,
  // PowerShell & Windows dangerous patterns
  /Remove-Item\s+-Recurse/i,
  /Invoke-Expression/i,
  /iex\s+/i,
  /Invoke-WebRequest/i,
  /iwr\s+/i,
  /Start-Process/i,
  /Set-ExecutionPolicy/i,
  /powershell\s+-enc/i,
  /wmic\s+/i,
  // Sensitive file access
  /cat\s+.*\.env/,
  /grep\s+.*\.env/,
  /type\s+.*\.env/i,
  /Get-Content\s+.*\.env/i,
  /gc\s+.*\.env/i,
  /more\s+.*\.env/i,
  /less\s+.*\.env/i,
  /head\s+.*\.env/i,
  /tail\s+.*\.env/i,
  /strings\s+.*\.env/i,
  /awk\s+.*\.env/i,
  /sed\s+.*\.env/i,
  /ssh-add\s+-L/,
  /cat\s+~?\/(\.ssh|\.aws|\.kube)/,
  // Network exploration
  /nmap\s+/,
  /netstat\s+/,
  /nc\s+-l/,
  /curl\s+-X\s*POST\s*.*localhost/,
  // Additional script execution patterns (node -e, python -c, etc.)
  /node\s+-e\s*/i,
  /node\s+-p\s*/i,
  /python\s+-c\s*/i,
  /python3\s+-c\s*/i,
  /perl\s+-e\s*/i,
  /ruby\s+-e\s*/i,
  /php\s+-r\s*/i,
];

/**
 * Check if a command contains dangerous patterns.
 * @param {string} command The command to check.
 * @returns {object} { safe: boolean, reason?: string }
 */
export function checkCommandSafety(command) {
  if (!command || typeof command !== "string") {
    return { safe: false, reason: "Command is empty or invalid" };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { safe: false, reason: "Command is empty" };
  }

  if (!ALLOWED_COMMAND_PREFIXES.some(p => trimmed.startsWith(p))) {
    return { safe: false, reason: "Command not in allowlist" };
  }

  // Normalize command: remove quotes and standardize slashes to catch obfuscation
  const normalized = trimmed.replace(/["'`]/g, "").replace(/\\/g, "/");

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(trimmed) || pattern.test(normalized)) {
      return {
        safe: false,
        reason: `Command matches dangerous pattern: ${pattern.toString()}`,
      };
    }
  }

  return { safe: true };
}

/**
 * Execute a command with timeout and output collection.
 * @param {string} command The command to execute.
 * @param {object} options Execution options.
 * @param {string} options.cwd Working directory.
 * @param {number} options.timeoutMs Timeout in milliseconds.
 * @param {function} options.onOutput Callback for streaming output.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
export async function executeCommand(command, options = {}) {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, onOutput = null } = options;

  // Safety check
  const safety = checkCommandSafety(command);
  if (!safety.safe) {
    throw new Error(`Command blocked: ${safety.reason}`);
  }

  // Clamp timeout between 1 second and configured max
  const rawTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clampedTimeout = Math.max(1000, Math.min(Number(rawTimeout) || DEFAULT_TIMEOUT_MS, serverConfig.commandTimeoutMs || DEFAULT_TIMEOUT_MS));

  return new Promise((resolve, reject) => {
    const isWindows = platform() === "win32";
    const shell = isWindows ? "cmd.exe" : "/bin/sh";
    const shellFlag = isWindows ? "/c" : "-c";

    const SAFE_ENV_KEYS = new Set([
      "PATH",
      "PATHEXT",
      "COMSPEC",
      "SystemRoot",
      "WINDIR",
      "OS",
      "PROCESSOR_ARCHITECTURE",
      "NUMBER_OF_PROCESSORS",
      "HOMEDRIVE",
      "HOMEPATH",
      "TMP",
      "TEMP",
    ]);
    const safeEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (SAFE_ENV_KEYS.has(key)) {
        safeEnv[key] = value;
      }
    }

    const child = spawn(shell, [shellFlag, command], {
      cwd,
      env: {
        ...safeEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true, // Hide window on Windows
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    // Collect stdout
    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (onOutput) {
        onOutput("stdout", text);
      }
    });

    // Collect stderr
    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (onOutput) {
        onOutput("stderr", text);
      }
    });

    // Timeout handler
    const timeoutId = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill(isWindows ? "SIGKILL" : "SIGTERM");

      // Force kill after grace period
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, clampedTimeout);

    // Process completion
    child.on("close", (exitCode) => {
      clearTimeout(timeoutId);

      if (killed && exitCode === null) {
        exitCode = timedOut ? 124 : 1; // 124 = timeout exit code
      }

      resolve({
        exitCode: exitCode ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    // Process error
    child.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to execute command: ${err.message}`));
    });
  });
}

/**
 * Kill a running command process.
 * @param {import('child_process').ChildProcess} process The process to kill.
 * @param {boolean} force Whether to force kill (SIGKILL).
 */
export function killProcess(process, force = false) {
  if (process && !process.killed) {
    try {
      process.kill(force ? "SIGKILL" : "SIGTERM");
    } catch (err) {
      if (err.code === "ESRCH") {
        return;
      }
      throw err;
    }
  }
}

export { DEFAULT_TIMEOUT_MS };