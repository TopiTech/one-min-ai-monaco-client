import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { startupCleanup, startPeriodicCleanup } from '../services/tmp-cleanup.js';

describe('tmp-cleanup service', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-min-ai-cleanup-test-'));
  });

  afterEach(() => {
    try {
      if (fs.existsSync(tmpDir)) {
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
          fs.unlinkSync(path.join(tmpDir, file));
        }
        fs.rmdirSync(tmpDir);
      }
    } catch {
      // Ignore cleanup failures in test teardown
    }
  });

  describe('startupCleanup', () => {
    test('removes all files in target temp directory', () => {
      fs.writeFileSync(path.join(tmpDir, 'file1.tmp'), 'hello');
      fs.writeFileSync(path.join(tmpDir, 'file2.tmp'), 'world');

      expect(fs.readdirSync(tmpDir).length).toBe(2);

      startupCleanup(tmpDir);

      expect(fs.readdirSync(tmpDir).length).toBe(0);
    });

    test('ignores errors gracefully when directory does not exist', () => {
      const nonExistentDir = path.join(tmpDir, 'does-not-exist');
      expect(() => startupCleanup(nonExistentDir)).not.toThrow();
    });
  });

  describe('startPeriodicCleanup', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('deletes only files older than 1 hour when interval fires', () => {
      const freshFile = path.join(tmpDir, 'fresh.tmp');
      fs.writeFileSync(freshFile, 'fresh');

      const oldFile = path.join(tmpDir, 'old.tmp');
      fs.writeFileSync(oldFile, 'old');

      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
      fs.utimesSync(oldFile, twoHoursAgo, twoHoursAgo);

      expect(fs.readdirSync(tmpDir).length).toBe(2);

      const intervalId = startPeriodicCleanup(tmpDir);

      try {
        jest.advanceTimersByTime(60 * 60 * 1000);

        const remaining = fs.readdirSync(tmpDir);
        expect(remaining).toContain('fresh.tmp');
        expect(remaining).not.toContain('old.tmp');
      } finally {
        clearInterval(intervalId);
      }
    });

    test('ignores errors gracefully if directory does not exist when interval fires', () => {
      const nonExistentDir = path.join(tmpDir, 'non-existent');
      const intervalId = startPeriodicCleanup(nonExistentDir);

      try {
        expect(() => {
          jest.advanceTimersByTime(60 * 60 * 1000);
        }).not.toThrow();
      } finally {
        clearInterval(intervalId);
      }
    });
  });
});
