import fs from 'fs';
import os from 'os';
import path from 'path';
import { APP_DATA_DIR_NAME, DATA_DIR, TMP_DIR, migrateLegacyDataSync } from '../config/paths.js';

describe('config/paths.js', () => {
  test('uses an app-owned data directory instead of a coding agent folder', () => {
    expect(APP_DATA_DIR_NAME).toBe('.onemin-ai');
    expect(DATA_DIR).toBe(path.join(path.dirname(DATA_DIR), 'data'));
    expect(DATA_DIR).not.toContain('.mimocode');
    expect(TMP_DIR).not.toContain('.mimocode');
  });

  test('migrates only known legacy files without overwriting existing data', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onemin-paths-test-'));
    const legacyDir = path.join(root, 'legacy', 'data');
    const dataDir = path.join(root, 'app', 'data');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'api_keys.json'), '{"1min":"legacy"}');
    fs.writeFileSync(path.join(legacyDir, 'agent_sessions.json'), '{}');
    fs.writeFileSync(path.join(legacyDir, 'unrelated.txt'), 'not ours');

    try {
      migrateLegacyDataSync({ legacyDir, dataDir });

      expect(fs.readFileSync(path.join(dataDir, 'api_keys.json'), 'utf8')).toBe('{"1min":"legacy"}');
      expect(fs.existsSync(path.join(dataDir, 'agent_sessions.json'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'unrelated.txt'))).toBe(false);

      fs.writeFileSync(path.join(dataDir, 'api_keys.json'), '{"1min":"current"}');
      migrateLegacyDataSync({ legacyDir, dataDir });
      expect(fs.readFileSync(path.join(dataDir, 'api_keys.json'), 'utf8')).toBe('{"1min":"current"}');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
