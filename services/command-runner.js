import { spawn, execFile } from 'child_process';
import { platform } from 'os';
import { StringDecoder } from 'string_decoder';
import { serverConfig } from '../config/server.js';
import { getSafeEnv } from '../utils/env-guard.js';
import logger from '../utils/logger.js';

const activeProcesses = new Set();

/**
 * Register a spawned child process for lifecycle tracking so that
 * graceful shutdown can terminate it cleanly.
 * @param {import('child_process').ChildProcess} child
 * @returns {() => void} Cleanup function to remove process from tracker
 */
export function trackActiveProcess(child) {
  activeProcesses.add(child);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    activeProcesses.delete(child);
  };
  child.once('close', cleanup);
  child.once('error', cleanup);
  return cleanup;
}

/**
 * Force terminate all active spawned processes.
 * Used during server shutdown to prevent zombie processes.
 */
export function killAllActiveProcesses() {
  if (activeProcesses.size === 0) return;
  for (const child of activeProcesses) {
    try {
      killProcessTree(child, true);
    } catch {
      // Best-effort cleanup
    }
  }
  activeProcesses.clear();
}

/**
 * Command execution service with timeout, output collection, and safety checks.
 */

const DEFAULT_TIMEOUT_MS = serverConfig.commandTimeoutMs;
const MAX_COMMAND_LENGTH = 4096;
const MAX_COMMAND_ARGS = 128;

// Dedicated timeout for diagnostic commands that could be used for DoS
// (e.g. "ping -t localhost", "sleep 86400"). Bounded to 5 seconds to
// prevent resource exhaustion while still allowing basic diagnostics.
const DIAGNOSTIC_COMMAND_TIMEOUT_MS = 5_000;
const DIAGNOSTIC_COMMANDS = new Set(['ping', 'sleep']);

const ALLOWED_COMMAND_NAMES = new Set([
  'npm',
  'node',
  'git',
  'jest',
  'tsc',
  'ls',
  'cat',
  'grep',
  'pwd',
  'whoami',
  'python',
  'python3',
  // NOTE: "ping" and "sleep" are included for basic network/timing diagnostics in
  // agent workflows. Both are bounded by COMMAND_TIMEOUT_MS (default 30s) to
  // mitigate denial-of-service via "ping -t" or "sleep 86400". If you do not
  // need these commands, remove them from this list for a tighter security posture.
  'ping',
  'sleep',
  'exit',
]);

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
  if (!commandName) return '';
  return commandName
    .replace(/\.exe$/i, '')
    .replace(/\.cmd$/i, '')
    .toLowerCase();
}

function parseCommand(command) {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Command is empty');
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error('Command is too long');

  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    // Handle backslash escaping outside quotes (except on Windows where it serves as a path separator)
    if (process.platform !== 'win32' && !quote && char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      // Handle escaped quotes inside quoted strings (e.g., "it's", "say \"hello\"")
      if (char === '\\' && i + 1 < trimmed.length && trimmed[i + 1] === quote) {
        escaped = true;
        continue;
      }
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
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (quote) throw new Error('Command contains unclosed quote');
  if (escaped) throw new Error('Command contains trailing backslash');
  if (current) tokens.push(current);
  if (tokens.length > MAX_COMMAND_ARGS) throw new Error('Command has too many arguments');

  return tokens;
}

function isAllowedCommandName(commandName) {
  const name = normalizeCommandName(commandName);
  if (ALLOWED_COMMAND_NAMES.has(name)) return true;
  if (serverConfig.allowedExtraCommands && serverConfig.allowedExtraCommands.has(name)) return true;
  return false;
}

function isExitCommand(commandName) {
  return normalizeCommandName(commandName) === 'exit';
}

function executeExitCommand(commandParts) {
  const exitCode = Number.parseInt(commandParts[1] || '0', 10);
  return {
    exitCode: Number.isNaN(exitCode) ? 1 : exitCode,
    stdout: '',
    stderr: '',
    timedOut: false,
  };
}

function runProcess(commandParts, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onOutput = null,
    maxOutputSize = serverConfig.maxCommandOutputSize,
  } = options;
  const commandName = normalizeCommandName(commandParts[0]);

  if (isExitCommand(commandName)) {
    return executeExitCommand(commandParts);
  }

  const child = spawn(commandName, commandParts.slice(1), {
    cwd,
    env: getSafeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform() !== 'win32',
  });

  const cleanUp = trackActiveProcess(child);

  return collectProcessOutput(child, { timeoutMs, onOutput, maxOutputSize }).then(
    (res) => {
      cleanUp();
      return res;
    },
    (err) => {
      cleanUp();
      throw err;
    },
  );
}

function createOutputCollector(limit, streamName, onOutput) {
  const decoder = new StringDecoder('utf8');
  const streamDecoder = onOutput ? new StringDecoder('utf8') : null;
  let text = '';
  let bytes = 0;
  let truncated = false;

  const pushChunk = (data) => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const chunkBytes = buffer.byteLength;
    if (bytes < limit) {
      if (bytes + chunkBytes > limit) {
        const allowedLen = limit - bytes;
        text += decoder.write(buffer.subarray(0, allowedLen)) + '\n...[output truncated]';
        bytes = limit;
        truncated = true;
      } else {
        text += decoder.write(buffer);
        bytes += chunkBytes;
      }
    } else if (!truncated) {
      truncated = true;
      text += '\n...[output truncated]';
    }
    if (onOutput && streamDecoder) {
      // A disconnected SSE client can make its response writer throw.
      // Streaming output is best-effort and must not turn that UI event
      // into an unhandled exception in the command process.
      try {
        onOutput(streamName, streamDecoder.write(buffer));
      } catch {
        // Ignore consumer callback failures; continue collecting output.
      }
    }
  };

  const finalize = () => {
    if (!truncated) {
      const tail = decoder.end();
      if (tail) text += tail;
    }
    if (onOutput && streamDecoder) {
      const tail = streamDecoder.end();
      if (tail) {
        try {
          onOutput(streamName, tail);
        } catch {
          // Ignore consumer callback failures
        }
      }
    }
    return { text: text.trim(), truncated };
  };

  return { pushChunk, finalize };
}

/**
 * Collect bounded stdout/stderr output with timeout and tree kill cleanup.
 * @param {import('child_process').ChildProcess} child
 * @param {{ timeoutMs?: number, onOutput?: ((type: string, text: string) => void) | null, maxOutputSize?: number, nullExitCode?: number, rawError?: boolean }} [options]
 */
export function collectProcessOutput(child, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onOutput = null,
    maxOutputSize = serverConfig.maxCommandOutputSize,
    nullExitCode = 1,
    rawError = false,
  } = options;

  return new Promise((resolve, reject) => {
    const limit =
      typeof maxOutputSize === 'number' && maxOutputSize > 0 ? Math.floor(maxOutputSize) : 10 * 1024 * 1024;
    const stdoutCollector = createOutputCollector(limit, 'stdout', onOutput);
    const stderrCollector = createOutputCollector(limit, 'stderr', onOutput);
    let timedOut = false;
    let killed = false;

    child.stdout?.on('data', stdoutCollector.pushChunk);
    child.stderr?.on('data', stderrCollector.pushChunk);

    let forceKillTimeoutId = null;

    const timeoutId = setTimeout(() => {
      timedOut = true;
      killed = true;
      killProcessTree(child, false);

      // Force kill after grace period
      forceKillTimeoutId = setTimeout(() => {
        if (child.exitCode === null) {
          killProcessTree(child, true);
        }
      }, 5000);
      forceKillTimeoutId.unref?.();
    }, timeoutMs);

    child.on('close', (exitCode) => {
      clearTimeout(timeoutId);
      if (forceKillTimeoutId) {
        clearTimeout(forceKillTimeoutId);
      }

      if (killed && exitCode === null) {
        exitCode = timedOut ? 124 : 1; // 124 = timeout exit code
      }

      const finalOut = stdoutCollector.finalize();
      const finalErr = stderrCollector.finalize();

      resolve({
        exitCode: exitCode ?? nullExitCode,
        stdout: finalOut.text,
        stderr: finalErr.text,
        timedOut,
        stdoutTruncated: finalOut.truncated,
        stderrTruncated: finalErr.truncated,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeoutId);
      if (forceKillTimeoutId) {
        clearTimeout(forceKillTimeoutId);
      }
      reject(rawError ? err : new Error(`Failed to execute command: ${err.message}`));
    });
  });
}

/**
 * Strip contents inside single/double quotes using the same escape rules as parseCommand.
 * @param {string} command
 * @returns {string}
 */
function stripQuotedContents(command) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) {
      if (!quote) out += char;
      escaped = false;
      continue;
    }
    if (process.platform !== 'win32' && !quote && char === '\\') {
      escaped = true;
      out += char;
      continue;
    }
    if (quote) {
      if (char === '\\' && i + 1 < command.length && command[i + 1] === quote) {
        escaped = true;
        continue;
      }
      if (char === quote) {
        out += quote;
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += quote;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Structural token-based check for dangerous interpreter execution flags
 * regardless of leading options (e.g. `node --no-warnings -e`), bundled short
 * flags (e.g. `node -pe`, `python3 -uc`), or full executable paths.
 *
 * @param {string[]} tokens Parsed command tokens
 * @returns {string | null} Reason string if blocked, null otherwise
 */
function hasDangerousInterpreterInvocation(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return null;
  const rawExe = tokens[0].split(/[/\\]/).pop() || '';
  const exeBase = normalizeCommandName(rawExe);

  const collectFlagsBeforeScript = (args, scriptExtRe) => {
    const flags = [];
    for (const arg of args) {
      if (arg === '--') break;
      if (scriptExtRe && scriptExtRe.test(arg)) break;
      if (arg.startsWith('-')) flags.push(arg);
    }
    return flags;
  };

  if (exeBase === 'node') {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.(?:[cm]?js|ts)$/i)) {
      const head = flag.toLowerCase().split('=')[0];
      if (
        /^--(?:eval|print|require|import|input-type|experimental.*|inspect.*|loader|conditions)$/.test(
          head,
        ) ||
        (/^-[a-z]+$/i.test(head) && /[epr]/i.test(head.slice(1)))
      ) {
        return `node execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (/^python(?:\d+(?:\.\d+)*)?$/.test(exeBase)) {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.(?:py|pyw)$/i)) {
      const head = flag.toLowerCase().split('=')[0];
      if (
        head === '--command' ||
        head === '--module' ||
        (/^-[a-z]+$/i.test(head) && /[cm]/i.test(head.slice(1)))
      ) {
        return `python execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (exeBase === 'perl') {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.(?:pl|pm)$/i)) {
      const head = flag.split('=')[0];
      if (head === '--eval' || (/^-[a-zA-Z]+$/.test(head) && /[eEM]/.test(head.slice(1)))) {
        return `perl execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (exeBase === 'ruby') {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.rb$/i)) {
      const head = flag.toLowerCase().split('=')[0];
      if (
        head === '--eval' ||
        head === '--require' ||
        (/^-[a-z]+$/i.test(head) && /[er]/i.test(head.slice(1)))
      ) {
        return `ruby execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (exeBase === 'php') {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.php$/i)) {
      const head = flag.toLowerCase().split('=')[0];
      if (head === '--run' || (/^-[a-z]+$/i.test(head) && /[rf]/i.test(head.slice(1)))) {
        return `php execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (exeBase === 'bash' || exeBase === 'sh' || exeBase === 'dash' || exeBase === 'zsh') {
    for (const flag of collectFlagsBeforeScript(tokens.slice(1), /\.(?:sh|bash|zsh)$/i)) {
      const head = flag.toLowerCase().split('=')[0];
      if (head === '--command' || (/^-[a-z]+$/i.test(head) && /[cl]/i.test(head.slice(1)))) {
        return `shell execution flag: ${flag}`;
      }
    }
    return null;
  }

  if (exeBase === 'cmd') {
    for (const arg of tokens.slice(1)) {
      if (/^\/[ck](?:$|[:=])/i.test(arg)) {
        return `cmd execution switch: ${arg}`;
      }
    }
    return null;
  }

  if (exeBase === 'powershell' || exeBase === 'pwsh') {
    for (const arg of tokens.slice(1)) {
      const head = arg.toLowerCase().split('=')[0];
      if (/^-(?:c(?:ommand)?|e(?:nc(?:odedcommand)?)?|f(?:ile)?)$/i.test(head)) {
        return `powershell execution flag: ${arg}`;
      }
    }
    return null;
  }

  return null;
}

/**
 * Check if a command contains dangerous patterns.
 * @param {string} command The command to check.
 * @returns {{ safe: boolean, reason?: string }}
 */
export function checkCommandSafety(command) {
  if (!command || typeof command !== 'string') {
    return { safe: false, reason: 'Command is empty or invalid' };
  }

  const trimmed = command.trim();
  if (!trimmed) {
    return { safe: false, reason: 'Command is empty' };
  }
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return { safe: false, reason: 'Command is too long' };
  }

  let tokens;
  try {
    tokens = parseCommand(trimmed);
  } catch (err) {
    return { safe: false, reason: err.message };
  }

  // B-3: Block shell metacharacters before allowlist check.
  // Developers do not need ; | && || ` $() > < in legitimate build/lint commands.
  // To avoid false positives on valid arguments (e.g. git commit -m "fix & update"),
  // we strip the contents inside quotes using the same escape rules as parseCommand.
  const unquoted = stripQuotedContents(trimmed);
  if (SHELL_INJECTION_PATTERN.test(unquoted)) {
    return { safe: false, reason: 'Command contains shell metacharacters that could enable injection' };
  }

  const commandName = normalizeCommandName(tokens[0]);
  if (!isAllowedCommandName(commandName)) {
    return { safe: false, reason: 'Command not in allowlist' };
  }

  const dangerousInterpreter = hasDangerousInterpreterInvocation(tokens);
  if (dangerousInterpreter) {
    return {
      safe: false,
      reason: `Command contains blocked ${dangerousInterpreter}`,
    };
  }

  // B-4: Normalize command to catch obfuscation (quote removal + slash normalization)
  const normalized = trimmed.replace(/["'`]/g, '').replace(/\\/g, '/');

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
 * @param {object} [options] Execution options.
 * @param {string} [options.cwd] Working directory.
 * @param {number} [options.timeoutMs] Timeout in milliseconds.
 * @param {function} [options.onOutput] Callback for streaming output.
 * @param {number} [options.maxOutputSize] Maximum output buffer size in bytes.
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, timedOut: boolean, stdoutTruncated?: boolean, stderrTruncated?: boolean }>}
 */
export async function executeCommand(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onOutput = null,
    maxOutputSize = serverConfig.maxCommandOutputSize,
  } = options;

  // Safety check
  const safety = checkCommandSafety(command);
  if (!safety.safe) {
    throw new Error(`Command blocked: ${safety.reason}`);
  }

  let tokens;
  try {
    tokens = parseCommand(command);
  } catch (err) {
    throw new Error(`Command blocked: ${err.message}`, { cause: err });
  }

  // Clamp timeout between 1 second and configured max
  // Use dedicated timeout for diagnostic commands (ping, sleep) to prevent DoS
  const commandName = normalizeCommandName(tokens[0]);
  const isDiagnostic = DIAGNOSTIC_COMMANDS.has(commandName);
  const maxTimeout = isDiagnostic
    ? Math.min(DIAGNOSTIC_COMMAND_TIMEOUT_MS, serverConfig.commandTimeoutMs || DEFAULT_TIMEOUT_MS)
    : serverConfig.commandTimeoutMs || DEFAULT_TIMEOUT_MS;
  const rawTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clampedTimeout = Math.max(1000, Math.min(Number(rawTimeout) || DEFAULT_TIMEOUT_MS, maxTimeout));

  return runProcess(tokens, {
    cwd,
    timeoutMs: clampedTimeout,
    onOutput,
    maxOutputSize,
  });
}

/**
 * Kill a running process tree.
 * @param {import('child_process').ChildProcess} childProcess The process to kill.
 * @param {boolean} force Whether to force kill (SIGKILL).
 */
export function killProcessTree(childProcess, force = false) {
  if (!childProcess || childProcess.exitCode !== null) return;
  const pid = childProcess.pid;
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (platform() === 'win32') {
      // SEC-KILL-1: Handle taskkill errors to detect zombie processes.
      // The /T flag terminates the process tree, /F forces termination.
      // Fall back to direct childProcess.kill() if taskkill is blocked or errors
      // (for example inside restricted sandboxes) so processes do not linger.
      const tkProc = execFile(
        'taskkill',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: 1500, killSignal: 'SIGKILL' },
        (err) => {
          if (!err) return;
          // Check if the process already exited (not an error during cleanup/shutdown).
          // On Windows, taskkill returns exit code 128 or 1 when process was not found,
          // and message contains "not found" or similar. Node's exec returns numeric code or errno string.
          const msg = err.message || '';
          const isNotFound =
            err.code === 'ESRCH' ||
            err.code === 128 ||
            (err.code === 1 && /not found/i.test(msg)) ||
            /not found/i.test(msg);
          if (!isNotFound) {
            logger.warn(`Failed to kill process tree (PID ${pid}): ${msg}`);
            try {
              if (typeof childProcess.kill === 'function' && childProcess.exitCode === null) {
                childProcess.kill(force ? 'SIGKILL' : 'SIGTERM');
              }
            } catch {
              // Ignore secondary kill failures
            }
          }
        },
      );
      tkProc.unref?.();
    } else {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch (err) {
    if (err.code !== 'ESRCH') {
      logger.warn(`Failed to kill process tree: ${err.message || err}`);
    }
  }
}

export function killProcess(childProcess, force = false) {
  killProcessTree(childProcess, force);
}

export { DEFAULT_TIMEOUT_MS };
