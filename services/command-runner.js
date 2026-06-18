import { spawn } from "child_process";
import { platform } from "os";
import { serverConfig } from "../config/server.js";

/**
 * Command execution service with timeout, output collection, and safety checks.
 */

// Default timeout from environment or 30 seconds
const DEFAULT_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS || "30000", 10);
const MAX_COMMAND_LENGTH = 4096;
const MAX_COMMAND_ARGS = 128;

const ALLOWED_COMMAND_NAMES = new Set([
  "npm",
  "npx",
  "node",
  "git",
  "jest",
  "tsc",
  "dir",
  "ls",
  "echo",
  "cat",
  "grep",
  "pwd",
  "whoami",
  "python",
  "python3",
  "pip",
  "pipenv",
  "ping",
  "sleep",
  "exit",
]);

const WINDOWS_BUILT_IN_COMMANDS = new Set(["dir", "echo", "exit"]);

// Dangerous patterns that are blocked by default
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\*/,
  /rm\s+-rf\s+~/,
  /del\s+\/s\s+\/q/i,
  /format\s+[a-z]:/i,
  /sudo\s+/i,
  /curl\s+.*\|\s*(ba)?sh/i,
  /wget\s+.*\|\s*(ba)?sh/i,
  /\/dev\/(sda|hd[a-z])/,
  /dd\s+if=.*of=\/dev/i,
  /mkfs\./i,
  /:()\s*\{.*\}\s*;/, // Fork bomb
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
  /(?:^|\s)(?:cat|grep|type|Get-Content|gc|more|less|head|tail|string|awk|sed)\s+.*\.env(?:\s|$)/i,
  /ssh-add\s+-L/i,
  /cat\s+~?\/(\.(ssh|aws|kube))/i,
  // Network exploration
  /nmap\s+/i,
  /netstat\s+/i,
  /nc\s+-l/i,
  /curl\s+-X\s*POST\s*.*localhost/i,
  // Additional script execution patterns (node -e, python -c, etc.)
  /(?:^|\s)node\s+-{1,2}(e|p|eval|print|require|input-type|experimental|inspect|loader|conditions)(?:[\s=]|$)/i,
  /(?:^|\s)python(?:3)?\s+-(c|m|command|module)\b/i,
  /(?:^|\s)perl\s+-(e|M)\b/i,
  /(?:^|\s)ruby\s+-(e|r)\b/i,
  /(?:^|\s)php\s+-(r|f)\b/i,
  /(?:^|\s)bash\s+-(c|l)\b/i,
  /(?:^|\s)sh\s+-(c|l)\b/i,
  /(?:^|\s)cmd\.exe\s+\/c\b/i,
  /(?:^|\s)powershell(?:\.exe)?\s+-(c|enc|Command|EncodedCommand|File)\b/i,
];

// B-3/B-4: Shell metacharacters that enable injection attacks.
// These must be blocked regardless of the command prefix allowlist.
const SHELL_INJECTION_PATTERN = /[\n\r;|`<>&]|&&|\|\||\$\(|\$\{|%(?:0[aAdD]|\d{2})/;

function normalizeCommandName(commandName) {
  if (!commandName) return "";
  return commandName.replace(/\.exe$/i, "").replace(/\.cmd$/i, "").toLowerCase();
}

function parseCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Command is empty");
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error("Command is too long");

  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new Error("Command contains unclosed quote");
  if (current) tokens.push(current);
  if (tokens.length > MAX_COMMAND_ARGS) throw new Error("Command has too many arguments");

  return tokens;
}

function isAllowedCommandName(commandName) {
  return ALLOWED_COMMAND_NAMES.has(normalizeCommandName(commandName));
}

function isWindowsBuiltInCommand(commandName) {
  return platform() === "win32" && WINDOWS_BUILT_IN_COMMANDS.has(normalizeCommandName(commandName));
}

function isExitCommand(commandName) {
  return normalizeCommandName(commandName) === "exit";
}

function getSafeEnv() {
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
  return safeEnv;
}

function buildWindowsCommand(commandParts) {
  return commandParts
    .map((part) => {
      if (/\s/.test(part) || /[&|<>()%!^]/.test(part)) {
        return `"${part.replace(/"/g, "")}"`;
      }
      return part;
    })
    .join(" ");
}

function executeExitCommand(commandParts) {
  const exitCode = Number.parseInt(commandParts[1] || "0", 10);
  return {
    exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
    stdout: "",
    stderr: "",
    timedOut: false,
  };
}

function runProcess(commandParts, options = {}) {
  const { cwd = process.cwd(), timeoutMs = DEFAULT_TIMEOUT_MS, onOutput = null } = options;
  const commandName = normalizeCommandName(commandParts[0]);

  if (isExitCommand(commandName)) {
    return executeExitCommand(commandParts);
  }

  if (isWindowsBuiltInCommand(commandName)) {
    const shellCommand = buildWindowsCommand(commandParts);
    const child = spawn("cmd.exe", ["/d", "/s", "/c", shellCommand], {
      cwd,
      env: getSafeEnv(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    return collectProcessOutput(child, timeoutMs, onOutput);
  }

  const child = spawn(commandName, commandParts.slice(1), {
    cwd,
    env: getSafeEnv(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  return collectProcessOutput(child, timeoutMs, onOutput);
}

function collectProcessOutput(child, timeoutMs, onOutput) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killed = false;

    child.stdout.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (onOutput) {
        onOutput("stdout", text);
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (onOutput) {
        onOutput("stderr", text);
      }
    });

    const timeoutId = setTimeout(() => {
      timedOut = true;
      killed = true;
      child.kill(platform() === "win32" ? "SIGKILL" : "SIGTERM");

      // Force kill after grace period
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5000);
    }, timeoutMs);

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

    child.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to execute command: ${err.message}`));
    });
  });
}

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
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { safe: false, reason: "Command is too long" };
  }

  let tokens;
  try {
    tokens = parseCommand(trimmed);
  } catch (err) {
    return { safe: false, reason: err.message };
  }

  // B-3: Block shell metacharacters before allowlist check.
  // Developers do not need ; | && || ` $() > < in legitimate build/lint commands.
  if (SHELL_INJECTION_PATTERN.test(trimmed)) {
    return { safe: false, reason: "Command contains shell metacharacters that could enable injection" };
  }

  const commandName = normalizeCommandName(tokens[0]);
  if (!isAllowedCommandName(commandName)) {
    return { safe: false, reason: "Command not in allowlist" };
  }

  // B-4: Normalize command to catch obfuscation (quote removal + slash normalization)
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

  let tokens;
  try {
    tokens = parseCommand(command);
  } catch (err) {
    throw new Error(`Command blocked: ${err.message}`);
  }

  return runProcess(tokens, {
    cwd,
    timeoutMs: clampedTimeout,
    onOutput,
  });
}

/**
 * Kill a running command process.
 * @param {import('child_process').ChildProcess} childProcess The process to kill.
 * @param {boolean} force Whether to force kill (SIGKILL).
 */
export function killProcess(childProcess, force = false) {
  if (childProcess && !childProcess.killed) {
    try {
      childProcess.kill(force ? "SIGKILL" : "SIGTERM");
    } catch (err) {
      if (err.code === "ESRCH") {
        return;
      }
      throw err;
    }
  }
}

export { DEFAULT_TIMEOUT_MS };
