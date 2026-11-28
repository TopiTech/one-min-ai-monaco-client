/**
 * Regression tests for the second full-project review round.
 *
 * Covered root causes:
 * - Unknown /api routes fell through to Express' HTML 404 page, breaking the
 *   JSON error contract every client parses.
 * - Building the app with authentication disabled still created/migrated the
 *   persisted BFF session token (tests wrote into the checkout).
 * - The in-memory asset fallback and the binary probes used a single
 *   FileHandle.read(), which may return fewer bytes than requested.
 * - The 1forall "1min-sse" passthrough buffered the upstream body with no
 *   size cap.
 * - Persisted agent sessions/pending commands were trusted without validation.
 * - The agent directory listing used a hard-coded cap and never reported
 *   truncation, unlike /api/fs/list.
 * - saveFile() marked the tab that was active *after* the write as clean.
 */
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import request from 'supertest';

const { createApp } = await import('../server.js');
const { readHeadBytes } = await import('../utils/fs-utils.js');
const { validatePath } = await import('../utils/fs-guard.js');
const { readBoundedResponseText } = await import('../utils/sse.js');
const { normalizePersistedSession, normalizePersistedPendingCommand } = await import('../routes/agent.js');
const { DATA_DIR, PROJECT_ROOT } = await import('../config/paths.js');
const { serverConfig } = await import('../config/server.js');

jest.unstable_mockModule('../public/js/api.js', () => ({
  api: jest.fn(),
  assetUrl: (value) => value,
}));
jest.unstable_mockModule('../public/js/toast.js', () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    confirm: jest.fn(async () => true),
  },
}));

const { api: apiMock } = await import('../public/js/api.js');
const { toast: toastMock } = await import('../public/js/toast.js');
const { createEditorTabManager } = await import('../public/js/editor-tabs.js');

function findBySelector(root, selector) {
  if (!selector.startsWith('#')) return null;
  const id = selector.slice(1);
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findBySelector(child, selector);
    if (found) return found;
  }
  return null;
}

function createFakeElement() {
  const element = {
    id: '',
    className: '',
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    attributes: {},
    _classes: new Set(),
    classList: {
      add: (...names) => names.forEach((name) => element._classes.add(name)),
      remove: (...names) => names.forEach((name) => element._classes.delete(name)),
      contains: (name) => element._classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !element._classes.has(name) : Boolean(force);
        if (on) element._classes.add(name);
        else element._classes.delete(name);
        return on;
      },
    },
    setAttribute(name, value) {
      element.attributes[name] = String(value);
    },
    getAttribute(name) {
      return element.attributes[name];
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index !== -1) element.children.splice(index, 1);
      return child;
    },
    addEventListener() {},
    removeEventListener() {},
    focus() {
      element.focused = true;
    },
    select() {},
    remove() {},
    closest() {
      return null;
    },
    querySelector(selector) {
      return findBySelector(element, selector);
    },
    querySelectorAll() {
      return [];
    },
  };
  Object.defineProperty(element, 'firstChild', {
    get: () => element.children[0] || null,
  });
  return element;
}

function realPathOf(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

describe('API error envelope', () => {
  let app;

  beforeEach(() => {
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  test('unknown /api routes return the JSON error shape, not HTML', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Not Found', code: 'NOT_FOUND' });
    expect(res.body.details).toBeUndefined();
    expect(res.body.stack).toBeUndefined();
  });

  test('non-API GETs still fall through to the static/SPA handling', async () => {
    const res = await request(app).get('/not-an-api-route');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).not.toMatch(/application\/json/);
  });
});

describe('createApp without authentication', () => {
  test('does not create or rewrite the persisted session token', async () => {
    const tokenPath = path.join(DATA_DIR, 'bff_session.token');
    const savedEnvToken = process.env.LOCAL_BFF_AUTH_TOKEN;
    delete process.env.LOCAL_BFF_AUTH_TOKEN;
    try {
      const before = await fs.stat(tokenPath).catch(() => null);

      createApp({ requireLocalAuth: false, enableRateLimit: false });

      const after = await fs.stat(tokenPath).catch(() => null);
      expect(Boolean(after)).toBe(Boolean(before));
      if (before && after) {
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(after.size).toBe(before.size);
      }
    } finally {
      if (savedEnvToken !== undefined) process.env.LOCAL_BFF_AUTH_TOKEN = savedEnvToken;
    }
  });
});

describe('readHeadBytes', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-head-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('returns the requested prefix and the full file when smaller', async () => {
    const file = path.join(tmpDir, 'data.bin');
    const payload = Buffer.alloc(20_000);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await fs.writeFile(file, payload);

    const head = await readHeadBytes(file, 8192);
    expect(head.length).toBe(8192);
    expect(Buffer.compare(head, payload.subarray(0, 8192))).toBe(0);

    const whole = await readHeadBytes(file, 1 << 20);
    expect(whole.length).toBe(payload.length);
    expect(Buffer.compare(whole, payload)).toBe(0);
  });

  test('handles empty files and non-positive limits without reading', async () => {
    const file = path.join(tmpDir, 'empty.txt');
    await fs.writeFile(file, '');

    expect((await readHeadBytes(file, 8192)).length).toBe(0);
    expect((await readHeadBytes(file, 0)).length).toBe(0);
    expect((await readHeadBytes(file, Number.NaN)).length).toBe(0);
  });
});

describe('readBoundedResponseText', () => {
  const streamResponse = (chunks) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
      { status: 200 },
    );

  test('returns the full body when it fits the budget', async () => {
    const encoder = new TextEncoder();
    const response = streamResponse([encoder.encode('event: content\n'), encoder.encode('\n')]);

    const result = await readBoundedResponseText(response, 1024);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe('event: content\n\n');
    expect(result.totalBytes).toBe(16);
  });

  test('treats a body that exactly fills the budget as complete', async () => {
    const encoder = new TextEncoder();
    const response = streamResponse([encoder.encode('x'.repeat(512)), encoder.encode('y'.repeat(512))]);

    const result = await readBoundedResponseText(response, 1024);

    expect(result.truncated).toBe(false);
    expect(result.text).toBe('x'.repeat(512) + 'y'.repeat(512));
    expect(result.totalBytes).toBe(1024);
  });

  test('stops at the byte budget and never returns a partial body', async () => {
    const encoder = new TextEncoder();
    // Both chunks fit individually; the body only overflows once the second
    // one arrives, so a prefix of the body has already been decoded.
    const response = streamResponse([encoder.encode('a'.repeat(1024)), encoder.encode('b')]);

    const result = await readBoundedResponseText(response, 1024);

    expect(result.truncated).toBe(true);
    expect(result.text).toBe('');
    expect(result.totalBytes).toBe(1025);
  });
});

describe('persisted agent state validation', () => {
  test('normalizes a valid session and drops unusable history entries', () => {
    const session = normalizePersistedSession(
      {
        cwd: PROJECT_ROOT,
        task: 'refactor',
        status: 'running',
        history: [{ type: 'command' }, { noType: true }, 'not-an-object', null],
        createdAt: '2024-01-01T00:00:00.000Z',
        lastAccessedAt: 1700000000000,
      },
      'session-1',
    );

    expect(session).not.toBeNull();
    expect(session.id).toBe('session-1');
    expect(session.cwd).toBe(realPathOf(PROJECT_ROOT));
    expect(session.task).toBe('refactor');
    expect(session.status).toBe('idle');
    expect(session.history).toHaveLength(1);
    expect(session.history[0]).toEqual({ type: 'command' });
    expect(session.createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(session.lastAccessedAt).toBe(1700000000000);
  });

  test('drops sessions with a missing or malformed cwd', () => {
    expect(normalizePersistedSession(null, 'a')).toBeNull();
    expect(normalizePersistedSession([], 'a')).toBeNull();
    expect(normalizePersistedSession({ cwd: '' }, 'a')).toBeNull();
    expect(normalizePersistedSession({ cwd: 42 }, 'a')).toBeNull();
    expect(normalizePersistedSession({ cwd: PROJECT_ROOT }, '')).toBeNull();
  });

  test('keeps a session whose cwd is outside the allowed roots instead of erasing it', () => {
    // A reload must not drop records: the writer persists only live sessions,
    // so dropping one here would delete it from disk on the next save. The
    // command route re-validates the directory and answers 403 instead.
    const outside = os.tmpdir();
    const session = normalizePersistedSession({ cwd: outside, task: 'kept' }, 'a');

    expect(session).not.toBeNull();
    expect(session.cwd).toBe(outside);
    expect(session.task).toBe('kept');
    expect(() => validatePath(outside)).toThrow();
  });

  test('falls back to usable defaults for missing metadata', () => {
    const session = normalizePersistedSession({ cwd: PROJECT_ROOT }, 'session-2');

    expect(session).not.toBeNull();
    expect(session.task).toBe('');
    expect(session.history).toEqual([]);
    expect(typeof session.createdAt).toBe('string');
    expect(Number.isFinite(session.lastAccessedAt)).toBe(true);
  });

  test('validates pending commands and rejects expired or malformed entries', () => {
    const now = Date.now();
    const valid = { command: 'npm test', cwd: PROJECT_ROOT, sessionId: 's1', createdAt: now };

    expect(normalizePersistedPendingCommand(valid, now)).toEqual(valid);
    expect(normalizePersistedPendingCommand({ ...valid, command: '' }, now)).toBeNull();
    expect(normalizePersistedPendingCommand({ ...valid, cwd: 42 }, now)).toBeNull();
    expect(normalizePersistedPendingCommand({ ...valid, sessionId: null }, now)).toBeNull();
    expect(normalizePersistedPendingCommand({ ...valid, createdAt: now - 10 * 60 * 1000 }, now)).toBeNull();
    expect(normalizePersistedPendingCommand({ ...valid, createdAt: 'nope' }, now)).toBeNull();
    expect(normalizePersistedPendingCommand(null, now)).toBeNull();
    expect(normalizePersistedPendingCommand([], now)).toBeNull();
  });
});

describe('agent directory listing contract', () => {
  test('reports truncation state like /api/fs/list', async () => {
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    const created = await request(app).post('/api/agent/sessions').send({ cwd: PROJECT_ROOT });
    expect(created.status).toBe(200);
    const sessionId = created.body.session.id;

    try {
      const listing = await request(app)
        .get(`/api/agent/sessions/${sessionId}/dir`)
        .query({ path: PROJECT_ROOT });

      expect(listing.status).toBe(200);
      expect(listing.body.path).toBe(realPathOf(PROJECT_ROOT));
      expect(Array.isArray(listing.body.items)).toBe(true);
      expect(listing.body.truncated).toBe(false);
    } finally {
      await request(app).delete(`/api/agent/sessions/${sessionId}`);
    }
  });
});

describe('agent command working directory guard', () => {
  test('rejects a command whose cwd is outside the allowed roots', async () => {
    // A persisted session keeps its stored cwd even when that directory no
    // longer validates, so this guard is what stops it from being used.
    //
    // Force the feature flag on: it defaults to false and only local .env
    // files set it, so relying on the environment made this test pass locally
    // but hit the "execution disabled" branch in CI before the cwd guard.
    const previousExec = serverConfig.enableCommandExecution;
    serverConfig.enableCommandExecution = true;
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    const created = await request(app).post('/api/agent/sessions').send({ cwd: PROJECT_ROOT });
    expect(created.status).toBe(200);
    const sessionId = created.body.session.id;

    try {
      const response = await request(app)
        .post(`/api/agent/sessions/${sessionId}/commands`)
        .send({ command: 'echo hi', cwd: os.tmpdir() });

      expect(response.status).toBe(403);
      expect(response.body.error).toMatch(/^Invalid working directory/);
    } finally {
      await request(app).delete(`/api/agent/sessions/${sessionId}`);
      serverConfig.enableCommandExecution = previousExec;
    }
  });
});

describe('editor tab save race', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const makeElement = () => ({ textContent: '', title: '', disabled: false });

  test('marks the file that was written as clean, not the tab active afterwards', async () => {
    let resolveWrite;
    apiMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveWrite = resolve;
        }),
    );

    const editorState = { activeFilePath: '/repo/first.js', readOnlyFiles: {}, openTabs: [] };
    const markClean = jest.fn();
    const editorManager = {
      instance: {
        getValue: () => 'first-content',
        getModel: () => ({ getAlternativeVersionId: () => 7 }),
        updateOptions: jest.fn(),
      },
      markClean,
    };
    const dom = {
      currentFileName: makeElement(),
      saveFileBtn: makeElement(),
      editorTabsBar: makeElement(),
    };
    const manager = createEditorTabManager(editorState, editorManager, dom, {});

    const savePromise = manager.saveFile();
    // The user switches tabs while the write is still in flight.
    editorState.activeFilePath = '/repo/second.js';
    await Promise.resolve();
    await Promise.resolve();
    resolveWrite({ ok: true });
    await savePromise;

    expect(apiMock).toHaveBeenCalledTimes(1);
    const [, options] = apiMock.mock.calls[0];
    expect(JSON.parse(options.body)).toEqual({ path: '/repo/first.js', content: 'first-content' });
    expect(markClean).toHaveBeenCalledTimes(1);
    // The version captured before the write must be recorded, not the version
    // that is current when the response arrives.
    expect(markClean).toHaveBeenCalledWith('/repo/first.js', 7);
    expect(toastMock.success).toHaveBeenCalled();
  });

  test('serializes writes of the same file so an older save cannot land last', async () => {
    const resolvers = [];
    apiMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    const editorState = { activeFilePath: '/repo/app.js', readOnlyFiles: {}, openTabs: [] };
    const editorManager = {
      instance: {
        getValue: () => 'content',
        getModel: () => ({ getAlternativeVersionId: () => 3 }),
        updateOptions: jest.fn(),
      },
      markClean: jest.fn(),
    };
    const dom = {
      currentFileName: makeElement(),
      saveFileBtn: makeElement(),
      editorTabsBar: makeElement(),
    };
    const manager = createEditorTabManager(editorState, editorManager, dom, {});

    const firstSave = manager.saveFile();
    const secondSave = manager.saveFile();
    await Promise.resolve();
    await Promise.resolve();
    // The second write must wait for the first one to finish.
    expect(apiMock).toHaveBeenCalledTimes(1);

    resolvers[0]({ ok: true });
    await firstSave;
    await Promise.resolve();
    await Promise.resolve();
    expect(apiMock).toHaveBeenCalledTimes(2);

    resolvers[1]({ ok: true });
    await secondSave;
    expect(editorManager.markClean).toHaveBeenCalledTimes(2);
  });
});

describe('local auth token isolation', () => {
  test('a token-less app generates its own token instead of reusing the persisted one', async () => {
    const { getActiveSecretValues } = await import('../services/key-store.js');
    const before = new Set(getActiveSecretValues());

    createApp({ requireLocalAuth: false, enableRateLimit: false });
    const afterFirst = new Set(getActiveSecretValues());
    createApp({ requireLocalAuth: false, enableRateLimit: false });
    const afterSecond = new Set(getActiveSecretValues());

    const firstAdded = [...afterFirst].filter((value) => !before.has(value));
    const secondAdded = [...afterSecond].filter((value) => !afterFirst.has(value));

    // Each app registers exactly one fresh runtime secret. Reading the
    // persisted token made the second app register nothing (it reused it).
    expect(firstAdded).toHaveLength(1);
    expect(secondAdded).toHaveLength(1);
    expect(firstAdded[0]).not.toBe(secondAdded[0]);
  });
});

describe('agent directory listing truncation', () => {
  test('marks the listing truncated when the directory exceeds the configured cap', async () => {
    const originalCap = serverConfig.fsMaxListEntries;
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    const created = await request(app).post('/api/agent/sessions').send({ cwd: PROJECT_ROOT });
    expect(created.status).toBe(200);
    const sessionId = created.body.session.id;
    serverConfig.fsMaxListEntries = 1;

    try {
      const listing = await request(app)
        .get(`/api/agent/sessions/${sessionId}/dir`)
        .query({ path: PROJECT_ROOT });

      expect(listing.status).toBe(200);
      expect(listing.body.items).toHaveLength(1);
      expect(listing.body.truncated).toBe(true);
    } finally {
      serverConfig.fsMaxListEntries = originalCap;
      await request(app).delete(`/api/agent/sessions/${sessionId}`);
    }
  });
});

describe('static asset header wiring', () => {
  test('express.static applies the immutable + nosniff policy to vendored files', async () => {
    const vendorDir = path.join(PROJECT_ROOT, 'public', 'vendor');
    const vendorFile = path.join(vendorDir, 'review-wiring-check.js');
    const dirExisted = existsSync(vendorDir);
    await fs.mkdir(vendorDir, { recursive: true });
    await fs.writeFile(vendorFile, 'window.__reviewWiringCheck = true;\n');

    try {
      const res = await request(createApp({ requireLocalAuth: false, enableRateLimit: false })).get(
        '/vendor/review-wiring-check.js',
      );

      expect(res.status).toBe(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toContain('max-age=31536000');
      expect(res.headers['cache-control']).toContain('immutable');
    } finally {
      await fs.rm(vendorFile, { force: true });
      if (!dirExisted) await fs.rm(vendorDir, { recursive: true, force: true });
    }
  });
});

describe('inline chat widget lifecycle', () => {
  let createInlineChatManager;

  beforeAll(async () => {
    global.document = { createElement: () => createFakeElement() };
    ({ createInlineChatManager } = await import('../public/js/inline-chat.js'));
  });

  afterAll(() => {
    delete global.document;
  });

  const setup = () => {
    const state = { modelValue: 'const a = 1;' };
    const model = {
      getLanguageId: () => 'javascript',
      getValue: () => state.modelValue,
      isDisposed: () => false,
    };
    const instance = {
      getModel: () => model,
      getValue: () => state.modelValue,
      getPosition: () => ({ lineNumber: 1, column: 1 }),
      addContentWidget: jest.fn(),
      removeContentWidget: jest.fn(),
      focus: jest.fn(),
      pushUndoStop: jest.fn(),
      executeEdits: jest.fn(),
    };
    const editorState = { activeFilePath: '/repo/app.js' };
    const manager = createInlineChatManager(
      editorState,
      { instance },
      {
        codeModel: { value: 'gpt-4o-mini' },
      },
    );
    return { state, model, instance, editorState, manager, widgetNode: editorState.inlineChatDom };
  };

  test('re-enables the reused widget when it is closed while a request is in flight', async () => {
    jest.clearAllMocks();
    const { manager, widgetNode } = setup();
    const input = widgetNode.querySelector('#inlineChatPrompt');
    const statusDiv = widgetNode.querySelector('#inlineChatStatus');

    manager.toggleInlineChat();
    input.value = 'rename';
    let resolveRequest;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = manager.submitInlineChat();
    expect(input.disabled).toBe(true);

    // Ctrl+I while the request runs closes the widget; the DOM node is reused
    // on the next open, so it must not stay disabled and loading.
    manager.toggleInlineChat();
    resolveRequest({ code: 'renamed' });
    await pending;

    expect(input.disabled).toBe(false);
    expect(statusDiv.className).toBe('inline-chat-status');
    expect(statusDiv.classList.contains('loading')).toBe(false);
  });

  test('refuses to insert when the document changed during the request', async () => {
    jest.clearAllMocks();
    const { manager, instance, state, widgetNode } = setup();
    const input = widgetNode.querySelector('#inlineChatPrompt');

    manager.toggleInlineChat();
    input.value = 'insert';
    let resolveRequest;
    apiMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const pending = manager.submitInlineChat();
    state.modelValue = 'const changed = true;';
    resolveRequest({ code: 'inserted' });
    await pending;

    expect(instance.executeEdits).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalled();
  });

  test('reports a disposed model instead of throwing', async () => {
    jest.clearAllMocks();
    const { manager, instance, model, widgetNode } = setup();
    const input = widgetNode.querySelector('#inlineChatPrompt');

    manager.toggleInlineChat();
    input.value = 'insert';
    model.isDisposed = () => true;
    model.getValue = () => {
      throw new Error('Model is disposed!');
    };
    apiMock.mockImplementationOnce(async () => ({ code: 'inserted' }));

    await manager.submitInlineChat();

    expect(toastMock.error).not.toHaveBeenCalled();
    expect(toastMock.warning).toHaveBeenCalled();
    expect(instance.executeEdits).not.toHaveBeenCalled();
  });
});

describe('chat attachment retention on abort', () => {
  let createChatManager;
  let createChatState;

  beforeAll(async () => {
    global.document = {
      createElement: () => createFakeElement(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      body: createFakeElement(),
      documentElement: { lang: 'en' },
      head: { contains: () => false, appendChild: () => {} },
    };
    global.window = { dispatchEvent: () => {} };
    ({ createChatManager, createChatState } = await import('../public/js/chat.js'));
  });

  afterAll(() => {
    delete global.document;
    delete global.window;
  });

  test('keeps attachments the user never sent when the send is aborted during upload', async () => {
    jest.clearAllMocks();
    const chatPrompt = createFakeElement();
    const dom = {
      chatPrompt,
      chatLog: createFakeElement(),
      sendChatBtn: createFakeElement(),
      abortChatBtn: createFakeElement(),
      attachmentPreviews: createFakeElement(),
      chatAttachments: createFakeElement(),
      chatModel: { value: 'gpt-4o-mini' },
      conversationId: { value: '' },
      webSearch: { checked: false },
    };
    const state = { chat: createChatState() };
    const manager = createChatManager(dom, state);
    state.chat.attachments.push(
      {
        type: 'image',
        file: { name: 'first.png', type: 'image/png', size: 10 },
        uploading: false,
        previewUrl: 'blob:first',
      },
      {
        type: 'image',
        file: { name: 'second.png', type: 'image/png', size: 10 },
        uploading: false,
        previewUrl: 'blob:second',
      },
    );
    chatPrompt.value = 'hello';

    let uploads = 0;
    apiMock.mockImplementation((route, options) => {
      if (!String(route).startsWith('/api/assets/upload')) {
        return Promise.reject(new Error(`unexpected request: ${route}`));
      }
      uploads += 1;
      if (uploads === 1) return Promise.resolve({ key: 'asset-1' });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const sendPromise = manager.sendChat(() => {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    manager.abortChat();
    await sendPromise;

    expect(uploads).toBe(2);
    // The first upload finished, but no request was ever sent: both
    // attachments must stay in the composer.
    expect(state.chat.attachments).toHaveLength(2);
  });
});
