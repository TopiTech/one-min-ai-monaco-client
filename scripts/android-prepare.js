/**
 * Prepares the Android Capacitor + nodejs-mobile bundle:
 * 1. Copies vendored frontend assets (marked, DOMPurify) into public/vendor.
 * 2. Downloads & SHA-256 verifies nodejs-mobile v18.20.4 Android binaries into android/app/libnode.
 * 3. Stages an allowlisted, secret-free Node.js project in android/app/src/main/assets/nodejs-project.
 * 4. Installs production-only dependencies inside the staged directory and removes monaco-editor.
 * 5. Verifies no secrets/logs (.env, .onemin-ai, .mimocode, logs, *.log) exist in the staged assets.
 */
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_ROOT = path.resolve(__dirname, '..');

export const NODEJS_MOBILE_VERSION = 'v18.20.4';
export const NODEJS_MOBILE_URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${NODEJS_MOBILE_VERSION}/nodejs-mobile-${NODEJS_MOBILE_VERSION}-android.zip`;
export const NODEJS_MOBILE_SHA256 = 'bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af';
const TARGET_ABIS = ['arm64-v8a', 'x86_64'];
const UNUSED_ABIS = ['armeabi-v7a'];

const COPY_FILES = ['server.js', 'package.json', 'package-lock.json'];
const COPY_DIRS = ['config', 'providers', 'routes', 'services', 'utils', 'middlewares'];
const FORBIDDEN_TOP_ENTRIES = new Set(['.env', '.onemin-ai', '.mimocode', 'logs']);

function buildSanitizedChildEnv() {
  const env = { ...process.env };
  // Strip npm 11 parent allow-scripts env vars that conflict with --ignore-scripts in child npm ci
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'npm_config_allow_scripts') {
      delete env[key];
    }
  }
  return env;
}

function runChecked(command, args, cwd) {
  const env = buildSanitizedChildEnv();
  const useCmdWrapper = process.platform === 'win32' && command === 'npm';
  const execCommand = useCmdWrapper ? process.env.ComSpec || 'cmd.exe' : command;
  const execArgs = useCmdWrapper ? ['/d', '/s', '/c', command, ...args] : args;

  const result = spawnSync(execCommand, execArgs, {
    cwd,
    env,
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

async function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function downloadFile(url, destPath, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
    }
    const readable = Readable.fromWeb(/** @type {any} */ (res.body));
    await pipeline(readable, fs.createWriteStream(destPath));
  } finally {
    clearTimeout(timer);
  }
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === 'win32') {
    const tarRes = spawnSync('tar', ['-xf', zipPath, '-C', destDir], { stdio: 'inherit' });
    if (tarRes.status === 0) return;
    runChecked(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      destDir,
    );
    return;
  }
  const unzipRes = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'inherit' });
  if (unzipRes.status === 0) return;
  runChecked('tar', ['-xf', zipPath, '-C', destDir], destDir);
}

export async function ensureLibnode(projectRoot = DEFAULT_PROJECT_ROOT) {
  const libnodeDir = path.join(projectRoot, 'android', 'app', 'libnode');
  const allPresent =
    fs.existsSync(path.join(libnodeDir, 'include', 'node', 'node.h')) &&
    TARGET_ABIS.every((abi) => fs.existsSync(path.join(libnodeDir, 'bin', abi, 'libnode.so')));

  if (allPresent) {
    console.log(`[android-prepare] libnode (${NODEJS_MOBILE_VERSION}) already present; skipping download.`);
    return libnodeDir;
  }

  const tmpZip = path.join(os.tmpdir(), `nodejs-mobile-${NODEJS_MOBILE_VERSION}-android.zip`);
  let shouldDownload = true;
  if (fs.existsSync(tmpZip)) {
    const existingHash = await computeFileSha256(tmpZip);
    if (existingHash === NODEJS_MOBILE_SHA256) {
      shouldDownload = false;
      console.log('[android-prepare] Using cached verified nodejs-mobile archive from temp directory.');
    }
  }

  if (shouldDownload) {
    console.log(`[android-prepare] Downloading nodejs-mobile ${NODEJS_MOBILE_VERSION}...`);
    await downloadFile(NODEJS_MOBILE_URL, tmpZip);
  }

  const actualHash = await computeFileSha256(tmpZip);
  if (actualHash !== NODEJS_MOBILE_SHA256) {
    await fsp.rm(tmpZip, { force: true }).catch(() => {});
    throw new Error(
      `SHA-256 mismatch for nodejs-mobile archive. Expected ${NODEJS_MOBILE_SHA256}, got ${actualHash}`,
    );
  }

  await fsp.rm(libnodeDir, { recursive: true, force: true });
  extractZip(tmpZip, libnodeDir);

  for (const abi of UNUSED_ABIS) {
    await fsp.rm(path.join(libnodeDir, 'bin', abi), { recursive: true, force: true });
  }

  await fsp.rm(tmpZip, { force: true }).catch(() => {});

  for (const abi of TARGET_ABIS) {
    const soPath = path.join(libnodeDir, 'bin', abi, 'libnode.so');
    if (!fs.existsSync(soPath)) {
      throw new Error(`Missing expected native library after extraction: ${soPath}`);
    }
  }

  console.log(`[android-prepare] Extracted libnode (${TARGET_ABIS.join(', ')}) into ${libnodeDir}`);
  return libnodeDir;
}

export async function assertNoSecretsInStagedDir(stagedDir) {
  const violations = [];

  async function walk(currentDir, depth = 0) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(stagedDir, fullPath).replace(/\\/g, '/');

      // Skip checking inside node_modules for normal package files, except .env files
      const inNodeModules = relPath === 'node_modules' || relPath.startsWith('node_modules/');
      if (!inNodeModules) {
        if (
          FORBIDDEN_TOP_ENTRIES.has(entry.name) ||
          entry.name.startsWith('.env.') ||
          entry.name.endsWith('.log')
        ) {
          violations.push(relPath);
          continue;
        }
        if (relPath === 'public/vs' || relPath.startsWith('public/vs/')) {
          violations.push(relPath);
          continue;
        }
      } else if (entry.name === '.env' || entry.name.startsWith('.env.')) {
        violations.push(relPath);
        continue;
      }

      if (entry.isDirectory() && !(inNodeModules && depth > 3)) {
        await walk(fullPath, depth + 1);
      }
    }
  }

  await walk(stagedDir);
  if (violations.length > 0) {
    throw new Error(`Forbidden files/directories found in Android bundle: ${violations.join(', ')}`);
  }
}

export async function stageNodeProject(projectRoot = DEFAULT_PROJECT_ROOT, { installProdDeps = true } = {}) {
  const stagedDir = path.join(projectRoot, 'android', 'app', 'src', 'main', 'assets', 'nodejs-project');

  await fsp.rm(stagedDir, { recursive: true, force: true });
  await fsp.mkdir(stagedDir, { recursive: true });

  for (const file of COPY_FILES) {
    const src = path.join(projectRoot, file);
    if (!fs.existsSync(src)) {
      throw new Error(`Required project file missing: ${src}`);
    }
    await fsp.cp(src, path.join(stagedDir, file));
  }

  for (const dir of COPY_DIRS) {
    const src = path.join(projectRoot, dir);
    if (!fs.existsSync(src)) {
      throw new Error(`Required project directory missing: ${src}`);
    }
    await fsp.cp(src, path.join(stagedDir, dir), { recursive: true });
  }

  // Copy public/ excluding public/vs (Monaco Editor assets are not needed on Android)
  const publicSrc = path.join(projectRoot, 'public');
  const publicDest = path.join(stagedDir, 'public');
  await fsp.cp(publicSrc, publicDest, {
    recursive: true,
    filter: (srcPath) => {
      const rel = path.relative(publicSrc, srcPath).replace(/\\/g, '/');
      return rel !== 'vs' && !rel.startsWith('vs/');
    },
  });

  if (installProdDeps) {
    console.log(
      '[android-prepare] Installing production dependencies (npm ci --omit=dev --ignore-scripts)...',
    );
    runChecked('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], stagedDir);
    // monaco-editor is in dependencies for desktop copy-monaco, but unused on Android (~80MB)
    await fsp.rm(path.join(stagedDir, 'node_modules', 'monaco-editor'), { recursive: true, force: true });
  }

  await assertNoSecretsInStagedDir(stagedDir);
  console.log(`[android-prepare] Staged secret-free Node.js project at ${stagedDir}`);
  return stagedDir;
}

export async function runAndroidPrepare({
  projectRoot = DEFAULT_PROJECT_ROOT,
  skipLibnode = false,
  installProdDeps = true,
} = {}) {
  console.log('[android-prepare] Copying vendored frontend assets...');
  runChecked('node', [path.join(projectRoot, 'scripts', 'copy-vendor.js')], projectRoot);

  if (!skipLibnode) {
    await ensureLibnode(projectRoot);
  }
  await stageNodeProject(projectRoot, { installProdDeps });
  console.log('[android-prepare] Done.');
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isDirectRun) {
  const args = new Set(process.argv.slice(2));
  runAndroidPrepare({
    skipLibnode: args.has('--skip-libnode') || process.env.SKIP_LIBNODE === 'true',
    installProdDeps: !args.has('--skip-install'),
  }).catch((err) => {
    console.error('[android-prepare] Failed:', err.message);
    process.exit(1);
  });
}
