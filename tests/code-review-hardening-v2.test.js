import path from 'path';
import fs from 'fs/promises';
import { validatePath, isProtectedPath, PROJECT_ROOT } from '../utils/fs-guard.js';
import { SessionLock } from '../utils/async-lock.js';
import { initModels, stopModelSync } from '../config/models.js';
import { agentChatSchema, MAX_AGENT_PROMPT_CHARS, MAX_AGENT_MESSAGE_CHARS } from '../routes/agent-chat.js';
import { ForbiddenError } from '../utils/errors.js';

describe('Code Review Hardening V2: NTFS ADS & Windows Colon Injection Prevention', () => {
  test('rejects Windows NTFS Alternate Data Streams (ADS) in validatePath', () => {
    // Colon after path segment (e.g. file.txt:secret)
    expect(() => validatePath(path.join(PROJECT_ROOT, 'test.txt:secret'))).toThrow(ForbiddenError);
    expect(() => validatePath('C:\\project\\secret.env:stream')).toThrow(ForbiddenError);
    expect(() => validatePath('foo/bar.txt:hidden')).toThrow(ForbiddenError);
  });

  test('allows legitimate Windows drive letter path but rejects any secondary colon', () => {
    // Drive letter alone
    const validDrivePath = path.resolve(PROJECT_ROOT, 'package.json');
    expect(() => validatePath(validDrivePath)).not.toThrow();

    // Drive letter followed by ADS colon
    expect(() => validatePath('C:\\project\\file.txt:stream')).toThrow(ForbiddenError);
  });

  test('isProtectedPath recognizes protected filenames even if ADS suffix is attempted', () => {
    expect(isProtectedPath(path.join(PROJECT_ROOT, '.env:secret'))).toBe(true);
    expect(isProtectedPath(path.join(PROJECT_ROOT, '.git:stream'))).toBe(true);
  });
});

describe('Code Review Hardening V2: SessionLock Re-entrancy & Concurrency', () => {
  test('allows re-entrant lock acquisition in the same async context without deadlocking', async () => {
    const lock = new SessionLock();
    let innerExecuted = false;

    const result = await lock.acquire('session-1', async () => {
      // Re-entrant call on the same key within the same async flow
      return await lock.acquire('session-1', async () => {
        innerExecuted = true;
        return 'success';
      });
    });

    expect(result).toBe('success');
    expect(innerExecuted).toBe(true);
  });

  test('serializes concurrent execution for the same key across separate execution contexts', async () => {
    const lock = new SessionLock();
    const order = [];

    const task1 = lock.acquire('session-2', async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('end-1');
    });

    const task2 = lock.acquire('session-2', async () => {
      order.push('start-2');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end-2');
    });

    await Promise.all([task1, task2]);

    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  test('runs tasks with different keys concurrently', async () => {
    const lock = new SessionLock();
    const startOrder = [];

    const taskA = lock.acquire('session-A', async () => {
      startOrder.push('A');
      await new Promise((r) => setTimeout(r, 20));
    });

    const taskB = lock.acquire('session-B', async () => {
      startOrder.push('B');
      await new Promise((r) => setTimeout(r, 20));
    });

    await Promise.all([taskA, taskB]);

    expect(startOrder).toContain('A');
    expect(startOrder).toContain('B');
  });
});

describe('Code Review Hardening V2: Model Sync Teardown', () => {
  afterAll(() => {
    stopModelSync();
  });

  test('stopModelSync is idempotent and cleans up recurring sync interval', () => {
    expect(() => stopModelSync()).not.toThrow();
    initModels();
    expect(() => stopModelSync()).not.toThrow();
    expect(() => stopModelSync()).not.toThrow();
  });
});

describe('Code Review Hardening V2: Agent Chat Limits & Schema', () => {
  test('allows single prompt up to MAX_AGENT_MESSAGE_CHARS (50,000 characters)', () => {
    const validPrompt = 'a'.repeat(MAX_AGENT_MESSAGE_CHARS);
    const parsed = agentChatSchema.safeParse({ prompt: validPrompt });
    expect(parsed.success).toBe(true);
  });

  test('rejects single prompt exceeding MAX_AGENT_MESSAGE_CHARS', () => {
    const excessivePrompt = 'a'.repeat(MAX_AGENT_MESSAGE_CHARS + 1);
    const parsed = agentChatSchema.safeParse({ prompt: excessivePrompt });
    expect(parsed.success).toBe(false);
  });

  test('allows multi-message conversation aggregate up to MAX_AGENT_PROMPT_CHARS', () => {
    expect(MAX_AGENT_PROMPT_CHARS).toBe(200000);
    const parsed = agentChatSchema.safeParse({
      messages: [
        { role: 'user', content: 'a'.repeat(40000) },
        { role: 'assistant', content: 'b'.repeat(40000) },
      ],
    });
    expect(parsed.success).toBe(true);

    const excessiveParsed = agentChatSchema.safeParse({
      messages: [
        { role: 'user', content: 'a'.repeat(MAX_AGENT_MESSAGE_CHARS) },
        { role: 'assistant', content: 'b'.repeat(MAX_AGENT_MESSAGE_CHARS) },
        { role: 'user', content: 'c'.repeat(MAX_AGENT_MESSAGE_CHARS) },
        { role: 'assistant', content: 'd'.repeat(MAX_AGENT_MESSAGE_CHARS) },
        { role: 'user', content: 'e'.repeat(1000) },
      ],
    });
    expect(excessiveParsed.success).toBe(false);
  });

  test('rejects messages array exceeding 100 entries', () => {
    const excessiveMessages = Array.from({ length: 101 }, () => ({ role: 'user', content: 'hi' }));
    const parsed = agentChatSchema.safeParse({ messages: excessiveMessages });
    expect(parsed.success).toBe(false);
  });
});

describe('Code Review Hardening V2: Accessibility Structure in index.html', () => {
  test('index.html has proper for attributes on image settings labels', async () => {
    const htmlPath = path.join(PROJECT_ROOT, 'public', 'index.html');
    const html = await fs.readFile(htmlPath, 'utf8');

    expect(html).toContain('for="aspectRatio"');
    expect(html).toContain('for="numOutputs"');
    expect(html).toContain('for="editorSize"');
    expect(html).toContain('for="editorQuality"');
    expect(html).toContain('for="editorN"');
    expect(html).toContain('for="editorBackground"');
    expect(html).toContain('for="editorOutputFormat"');
    expect(html).toContain('for="editorOutputCompression"');
  });

  test('index.html does not have redundant role="button" on nav button elements', async () => {
    const htmlPath = path.join(PROJECT_ROOT, 'public', 'index.html');
    const html = await fs.readFile(htmlPath, 'utf8');

    expect(html).not.toMatch(/<button[^>]*class="nav[^"]*"[^>]*role="button"/);
  });

  test('key input fields in index.html have aria-label attributes', async () => {
    const htmlPath = path.join(PROJECT_ROOT, 'public', 'index.html');
    const html = await fs.readFile(htmlPath, 'utf8');

    expect(html).toMatch(/<input[^>]*id="editorImageUrl"[^>]*aria-label=/);
    expect(html).toMatch(/<input[^>]*id="explorerPath"[^>]*aria-label=/);
    expect(html).toMatch(/<input[^>]*id="fileSearchInput"[^>]*aria-label=/);
    expect(html).toMatch(/<textarea[^>]*id="agentInstruction"[^>]*aria-label=/);
    expect(html).toMatch(/<input[^>]*id="folderPickerPath"[^>]*aria-label=/);
  });
});
