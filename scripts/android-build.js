/**
 * Cross-platform Gradle wrapper invocation for `npm run android:build`.
 *
 * `gradlew.bat` only exists for Windows and `./gradlew` only works on
 * POSIX hosts, so the npm script used to be Windows-only. This wrapper
 * picks the right launcher for the current platform.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(projectRoot, 'android');
const isWindows = process.platform === 'win32';
const launcher = join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');

if (!existsSync(launcher)) {
  console.error(`Gradle wrapper not found: ${launcher}`);
  console.error('Run "npx cap add android" (or sync the android/ directory) before building.');
  process.exit(1);
}

const result = spawnSync(isWindows ? 'gradlew.bat' : './gradlew', ['assembleDebug'], {
  cwd: androidDir,
  stdio: 'inherit',
  // .bat files can only be executed through a shell on Windows.
  shell: isWindows,
});

if (result.error) {
  console.error(`Failed to run Gradle: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
