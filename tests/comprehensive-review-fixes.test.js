/**
 * Comprehensive regression tests covering all issues fixed during the full-repository code review:
 * - ISSUE-01: 1forall SSRF open-redirect blocking, streaming download size cap, base64 pre-check, shared S3 matching
 * - ISSUE-02: image-schema normalized itemsType handling & strict array validation
 * - ISSUE-03: symlinked root lexical path protection & readSpecificLines bounds/stop
 * - ISSUE-04: key deletion catalog reset & sync state recovery
 * - ISSUE-05: dynamic image param proxy/key normalization, uppercase output_format, /api/jobs abort guard
 * - ISSUE-06: /api/chat/stream null-JSON 502 & >50MB limit suppressing false final-result/[DONE]
 * - ISSUE-07: error handler non-HTTP status clamping & /api/fs/rename self-move/conflict 400 errors
 * - ISSUE-08: image editor non-gpt parameter filtering, editorBackground=opaque, feature switch recovery, model-picker sync
 * - ISSUE-09: chat.js FAILED SSE status detection, processCommandStream UTF-8 EOF flush, app.js UI race & drive selection guards
 * - ISSUE-10: editor.js markClean disposed model guard, editor-tabs closed-mid-save guard, settings delete model refresh
 */
import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

const { createApp } = await import('../server.js');
const { serverConfig } = await import('../config/server.js');
const { isS3BucketUrl, extractAssetKey } = await import('../utils/asset-utils.js');
const { downloadImageForUpload, buildOneForAllAdditionalFields, isOneForAllOwnedUrl } =
  await import('../providers/one-for-all/images.js');
const { buildOneMinImagePayload } = await import('../providers/one-min/images.js');
const { describeOneForAllImage, describeOneForAllParams, validateParamValues } =
  await import('../services/image-schema.js');
const { isProtectedPath, isWriteProtectedPath, clearAllowedRootsCache } =
  await import('../utils/fs-guard.js');
const { readSpecificLines } = await import('../utils/fs-utils.js');
const { resetKeyStoreCache, setKeyStoreFilePath } = await import('../services/key-store.js');
const { fetchOneForAllModels, getChatModels, getModelSyncStatus, resetProviderModels } =
  await import('../config/models.js');

function makeMockElement(tag = 'div', id = '') {
  const attrs = new Map();
  const children = [];
  const listeners = new Map();
  let text = '';

  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    children,
    dataset: {},
    style: {},
    parentElement: null,
    disabled: false,
    value: '',
    checked: false,
    scrollTop: 0,
    clientHeight: 100,
    scrollHeight: 100,
    innerHTML: '',
    get textContent() {
      return text;
    },
    set textContent(v) {
      text = String(v ?? '');
      children.length = 0;
    },
    classList: {
      add: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.add(n));
        el.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.delete(n));
        el.className = [...set].join(' ');
      },
      toggle: (name, force) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !set.has(name) : Boolean(force);
        if (shouldAdd) set.add(name);
        else set.delete(name);
        el.className = [...set].join(' ');
        return shouldAdd;
      },
      contains: (name) => el.className.split(/\s+/).filter(Boolean).includes(name),
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    removeAttribute: (k) => attrs.delete(k),
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) || []) fn({ target: el, ...event });
    },
    appendChild: (child) => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    removeChild: (child) => {
      const idx = children.indexOf(child);
      if (idx !== -1) {
        children.splice(idx, 1);
        child.parentElement = null;
      }
    },
    remove: () => {
      el.parentElement?.removeChild(el);
    },
    closest: (selector) => {
      if (selector === '.u-flex-1, .u-flex-2') {
        let cur = el.parentElement;
        while (cur) {
          if (cur.classList.contains('u-flex-1') || cur.classList.contains('u-flex-2')) return cur;
          cur = cur.parentElement;
        }
      }
      return null;
    },
    querySelectorAll: (selector) => {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (selector === '[data-param-key]' && child.dataset?.paramKey) {
            out.push(child);
          } else if (selector === 'button' && child.tagName === 'BUTTON') {
            out.push(child);
          }
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    querySelector: (selector) => el.querySelectorAll(selector)[0] || null,
    click: () => {
      for (const fn of listeners.get('click') || []) fn({ target: el, preventDefault: () => {} });
      if (typeof el.onclick === 'function') el.onclick({ target: el, preventDefault: () => {} });
    },
  };

  Object.defineProperty(el, 'firstChild', { get: () => children[0] || null });
  return el;
}

function createBaseDocument({ getElementById = () => null } = {}) {
  const head = makeMockElement('head');
  const body = makeMockElement('body');
  const styleEl = makeMockElement('style', 'csp-dynamic-styles');
  head.contains = (node) => node === styleEl || head.children.includes(node);
  return {
    cookie: '',
    documentElement: { lang: 'en', classList: { toggle: () => {} } },
    head,
    body,
    getElementById: (id) => (id === 'csp-dynamic-styles' ? styleEl : getElementById(id)),
    createElement: (tag) => makeMockElement(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('Comprehensive Review Fixes', () => {
  let originalFetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env = { ...savedEnv, NODE_ENV: 'test' };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
    resetKeyStoreCache();
    setKeyStoreFilePath(null);
    resetProviderModels('1min');
    resetProviderModels('1forall');
    clearAllowedRootsCache();
    jest.restoreAllMocks();
  });

  describe('ISSUE-01: SSRF redirect blocking, bounded download & shared S3 matching', () => {
    test('blocks HTTP redirects to internal/metadata hosts and cancels redirect body', async () => {
      const redirectCancel = jest.fn(async () => {});
      globalThis.fetch = jest.fn(async () => ({
        status: 302,
        ok: false,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data/' }),
        body: { cancel: redirectCancel },
      }));

      await expect(downloadImageForUpload('https://asset.1min.ai/images/source.png')).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_IMAGE_URL',
      });
      expect(redirectCancel).toHaveBeenCalledTimes(1);
    });

    test('follows trusted redirect and enforces 20MB streaming limit when Content-Length is missing', async () => {
      const cancelOversized = jest.fn(async () => {});
      let fetchCalls = 0;
      globalThis.fetch = jest.fn(async (url) => {
        fetchCalls++;
        if (fetchCalls === 1) {
          expect(String(url)).toBe('https://asset.1min.ai/images/src.png');
          return {
            status: 302,
            ok: false,
            headers: new Headers({ location: 'https://storage.1min.ai/images/redirected.png' }),
            body: { cancel: jest.fn(async () => {}) },
          };
        }
        expect(String(url)).toBe('https://storage.1min.ai/images/redirected.png');
        let reads = 0;
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'image/png' }),
          body: {
            getReader: () => ({
              read: async () => {
                reads++;
                if (reads <= 2) {
                  return { done: false, value: new Uint8Array(11 * 1024 * 1024) };
                }
                return { done: true, value: undefined };
              },
              cancel: cancelOversized,
              releaseLock: () => {},
            }),
          },
        };
      });

      await expect(downloadImageForUpload('https://asset.1min.ai/images/src.png')).rejects.toMatchObject({
        status: 413,
        code: 'IMAGE_TOO_LARGE',
      });
      expect(cancelOversized).toHaveBeenCalledTimes(1);
    });

    test('rejects excessive redirect chains and oversized base64 data URIs before full decode', async () => {
      globalThis.fetch = jest.fn(async () => ({
        status: 302,
        ok: false,
        headers: new Headers({ location: 'https://storage.1min.ai/next.png' }),
        body: { cancel: jest.fn(async () => {}) },
      }));

      await expect(downloadImageForUpload('https://asset.1min.ai/images/loop.png')).rejects.toMatchObject({
        status: 502,
        code: 'IMAGE_FETCH_FAILED',
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(6);

      // 28MB base64 encodes ~21MB -> rejected synchronously by length estimate
      const hugeDataUri = `data:image/png;base64,${'A'.repeat(28 * 1024 * 1024)}`;
      await expect(downloadImageForUpload(hugeDataUri)).rejects.toMatchObject({
        status: 413,
        code: 'IMAGE_TOO_LARGE',
      });
    });

    test('shared S3 helper matches virtual-host, accelerate, dualstack, and path-style buckets consistently', () => {
      expect(
        isS3BucketUrl(new URL('https://voicegen-storage.s3.us-east-1.amazonaws.com/a.png'), [
          'voicegen-storage',
        ]),
      ).toBe(true);
      expect(
        isS3BucketUrl(new URL('https://s3.eu-west-1.amazonaws.com/tts-clariteia/clip.mp4'), [
          'tts-clariteia',
        ]),
      ).toBe(true);
      expect(isOneForAllOwnedUrl('https://voicegen-storage.s3-accelerate.amazonaws.com/img.png')).toBe(true);
      expect(extractAssetKey('https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/cat.png')).toBe(
        'images/cat.png',
      );
    });
  });

  describe('ISSUE-02: image-schema normalized itemsType & array element validation', () => {
    test('retains ARRAY type and image itemType for normalized catalog additionalFields', () => {
      const entry = {
        id: 'multi-img-model',
        meta: {
          mode: 'IMAGE_TO_IMAGE',
          additionalFields: [
            {
              code: 'reference_images',
              name: 'Reference Images',
              type: 'ARRAY',
              itemsType: 'IMAGE',
              required: false,
              enabled: true,
            },
          ],
        },
      };

      const desc = describeOneForAllImage(entry, 'multi-img-model');
      expect(desc.params[0]).toMatchObject({
        key: 'reference_images',
        type: 'array',
        itemType: 'image',
      });

      const params = describeOneForAllParams(entry);
      const valid = validateParamValues(params, {
        reference_images: ['https://example.com/1.png', '  https://example.com/2.png  '],
      });
      expect(valid.issues).toEqual([]);
      expect(valid.values.reference_images).toEqual([
        'https://example.com/1.png',
        'https://example.com/2.png',
      ]);

      const badObj = validateParamValues(params, { reference_images: [{ url: 'x' }] });
      expect(badObj.issues[0]).toContain('primitive');

      const tooMany = validateParamValues(params, {
        reference_images: Array.from({ length: 33 }, (_, i) => `item-${i}`),
      });
      expect(tooMany.issues[0]).toContain('32');
    });
  });

  describe('ISSUE-03: symlinked root protection and readSpecificLines bounds', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'comprehensive-fs-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('readSpecificLines clamps invalid bounds and stops at endLine', async () => {
      const file = path.join(tmpDir, 'lines.txt');
      await fs.writeFile(file, 'l1\nl2\nl3\nl4\nl5', 'utf-8');

      expect(await readSpecificLines(file, 0, 2)).toBe('l1\nl2');
      expect(await readSpecificLines(file, 4, 2)).toBe('');
      expect(await readSpecificLines(file, 2, 3)).toBe('l2\nl3');
    });

    test('isProtectedPath and isWriteProtectedPath match protected paths through lexical symlinked root', async () => {
      const realRoot = path.join(tmpDir, 'real-root');
      const linkRoot = path.join(tmpDir, 'link-root');
      await fs.mkdir(realRoot, { recursive: true });
      try {
        await fs.symlink(realRoot, linkRoot, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return;
      }

      process.env.ALLOWED_ROOTS = linkRoot;
      clearAllowedRootsCache();

      expect(isProtectedPath(path.join(linkRoot, '.env'))).toBe(true);
      expect(isProtectedPath(path.join(realRoot, '.env'))).toBe(true);
      expect(isWriteProtectedPath(path.join(linkRoot, 'package.json'))).toBe(true);
    });
  });

  describe('ISSUE-04 & ISSUE-10: settings key deletion resets catalog & triggers UI refresh', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-reset-'));
      setKeyStoreFilePath(path.join(tmpDir, 'api_keys.json'));
      delete process.env.ONE_MIN_AI_API_KEY;
      delete process.env.ONE_FOR_ALL_API_KEY;
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('DELETE /api/settings/keys/:provider resets cached remote models when no env key remains', async () => {
      globalThis.fetch = jest.fn(async (url) => {
        if (String(url).includes('/v1/external/llm/models/')) {
          return new Response(
            JSON.stringify([{ code: 'custom-remote-1forall', name: 'Remote Model', enabled: true }]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const saveRes = await request(app).post('/api/settings/keys').send({
        provider: '1forall',
        apiKey: 'sk_live_test_remote_9999',
        verify: true,
      });
      expect(saveRes.status).toBe(200);

      await fetchOneForAllModels();
      expect(getChatModels('1forall').some((m) => m.id === 'custom-remote-1forall')).toBe(true);
      expect(getModelSyncStatus('1forall').source).toBe('remote');

      const delRes = await request(app).delete('/api/settings/keys/1forall');
      expect(delRes.status).toBe(200);
      expect(delRes.body.provider.configured).toBe(false);
      expect(getChatModels('1forall').some((m) => m.id === 'custom-remote-1forall')).toBe(false);
      expect(getModelSyncStatus('1forall').source).toBe('fallback');
    });

    test('settings delete button dispatches models-refresh-requested', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStorage = global.localStorage;
      const elements = new Map();
      const ids = [
        'providerSelectGlobal',
        'settingsProviderSelect',
        'providerDotGlobal',
        'oneMinApiKeyInput',
        'saveOneMinKeyBtn',
        'deleteOneMinKeyBtn',
        'oneMinKeyStatus',
        'oneMinKeyBadge',
        'oneMinKeyMasked',
        'oneForAllApiKeyInput',
        'saveOneForAllKeyBtn',
        'deleteOneForAllKeyBtn',
        'oneForAllKeyStatus',
        'oneForAllKeyBadge',
        'oneForAllKeyMasked',
        'verifyApiKeyOnSave',
      ];
      for (const id of ids) {
        elements.set(id, makeMockElement(id.includes('Btn') ? 'button' : 'div', id));
      }
      const dispatched = [];
      global.DOMParser = class {
        parseFromString() {
          return { documentElement: { tagName: 'svg', querySelector: () => null } };
        }
      };
      global.document = createBaseDocument({
        getElementById: (id) => elements.get(id) || null,
      });
      global.window = {
        dispatchEvent: (evt) => dispatched.push(evt),
      };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };
      globalThis.fetch = jest.fn(async (url, opts) => {
        if (opts?.method === 'DELETE') {
          return new Response(
            JSON.stringify({ ok: true, provider: { configured: false, source: 'none', masked: null } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            defaultProvider: '1min',
            providers: { '1min': { configured: true, source: 'ui', masked: 'test...1234' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });

      const prevDOMParser = global.DOMParser;
      try {
        const { toast } = await import('../public/js/toast.js');
        jest.spyOn(toast, 'success').mockImplementation(() => {});
        jest.spyOn(toast, 'error').mockImplementation(() => {});
        const { bootstrapSettings } = await import('../public/js/settings.js');
        bootstrapSettings();
        elements.get('deleteOneMinKeyBtn').click();
        await new Promise((r) => setTimeout(r, 20));

        expect(dispatched.some((e) => e.type === 'models-refresh-requested')).toBe(true);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.localStorage = prevStorage;
        global.DOMParser = prevDOMParser;
      }
    });
  });

  describe('ISSUE-05: dynamic image param unwrapping, uppercase output_format, and /api/jobs abort', () => {
    test('extracts asset keys on nested image params and normalizes uppercase output_format', async () => {
      process.env.ONE_MIN_AI_API_KEY = 'test_1min_key';
      const promptObj = buildOneMinImagePayload({
        feature: 'FACE_SWAPPER',
        model: 'dzine',
        params: {},
        extra: {
          swapImageUrl: '/api/assets/proxy?key=images%2Fface.png',
          targetImageUrl: 'https://asset.1min.ai/images/body.png',
        },
      });
      expect(promptObj).toMatchObject({
        swapImageUrl: 'images/face.png',
        targetImageUrl: 'images/body.png',
      });

      const oneForAllFields = buildOneForAllAdditionalFields(
        {
          additional_fields: [
            { code: 'mask', name: 'Mask', type: 'IMAGE', enabled: true },
            {
              code: 'reference_images',
              name: 'Ref Images',
              type: 'ARRAY',
              items_type: 'IMAGE',
              enabled: true,
            },
          ],
        },
        'custom-editor',
        {},
        {
          mask: '/api/assets/proxy?url=https%3A%2F%2Fcdn.example.com%2Fmask.png',
          reference_images: ['/api/assets/proxy?key=images%2Fref1.png'],
        },
      );
      expect(oneForAllFields).toEqual({
        mask: 'https://cdn.example.com/mask.png',
        reference_images: ['https://asset.1min.ai/images/ref1.png'],
      });

      globalThis.fetch = jest.fn(async () => {
        return new Response(JSON.stringify({ aiRecord: { uuid: 'u1', status: 'SUCCESS' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const res = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'gpt-image-2',
        prompt: 'a cat',
        output_format: ' PNG ',
      });
      expect(res.status).toBe(200);
      const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
      expect(sent.promptObject.output_format).toBe('png');
    });

    test('/api/jobs forwards abort signal on disconnect without throwing unhandled errors', async () => {
      process.env.ONE_MIN_AI_API_KEY = 'test_1min_key';
      const http = await import('node:http');
      let capturedSignal = null;
      let rejectPending;
      globalThis.fetch = jest.fn((_url, opts) => {
        capturedSignal = opts?.signal;
        return new Promise((_resolve, reject) => {
          rejectPending = reject;
          opts?.signal?.addEventListener?.('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
      const server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        const { port } = server.address();
        await new Promise((resolve) => {
          const req = http.get({
            hostname: '127.0.0.1',
            port,
            path: '/api/jobs/1min/video/job-123',
            agent: false,
          });
          req.on('error', () => resolve());
          setTimeout(() => {
            req.destroy();
          }, 25);
        });
        await new Promise((r) => setTimeout(r, 25));
        expect(capturedSignal?.aborted).toBe(true);
      } finally {
        rejectPending?.(new Error('cleanup'));
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('ISSUE-06: /api/chat/stream invalid JSON & >50MB stream size overflow', () => {
    test('returns 502 when JSON fallback response cannot be parsed and omits [DONE] on >50MB overflow', async () => {
      process.env.ONE_MIN_AI_API_KEY = 'test_1min_key';
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      globalThis.fetch = jest.fn(async () => {
        return new Response('not-valid-json{{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      });

      const badJsonRes = await request(app).post('/api/chat/stream').send({ prompt: 'hello' });
      expect(badJsonRes.status).toBe(502);

      // Oversized stream (>50MB): should emit event: error and NEVER flush final-result or [DONE]
      const encoder = new TextEncoder();
      const bigFiller = new Uint8Array(26 * 1024 * 1024).fill(97);
      let chunkIdx = 0;
      globalThis.fetch = jest.fn(async () => {
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (chunkIdx === 0) {
                chunkIdx++;
                controller.enqueue(
                  encoder.encode(
                    'event: result\ndata: {"aiRecord":{"aiRecordDetail":{"resultObject":["ok"]}}}\n\ndata: [DONE]\n\n',
                  ),
                );
                return;
              }
              if (chunkIdx <= 2) {
                chunkIdx++;
                controller.enqueue(bigFiller);
                return;
              }
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      });

      const overflowRes = await request(app).post('/api/chat/stream').send({ prompt: 'hello' });
      expect(overflowRes.status).toBe(200);
      expect(overflowRes.text).toContain('event: error');
      expect(overflowRes.text).toContain('Stream exceeded maximum size');
      expect(overflowRes.text).not.toContain('event: final-result');
      expect(overflowRes.text).not.toContain('data: [DONE]');
    });
  });

  describe('ISSUE-07: invalid error status clamping & /api/fs/rename conflict handling', () => {
    let tmpDir;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-rename-edge-'));
      process.env.ALLOWED_ROOTS = tmpDir;
      clearAllowedRootsCache();
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('clamps non-HTTP err.status in error middleware instead of throwing ERR_HTTP_INVALID_STATUS_CODE', async () => {
      process.env.ONE_MIN_AI_API_KEY = 'test_1min_key';
      const prevRetries = serverConfig.apiRetryAttempts;
      serverConfig.apiRetryAttempts = 0;
      globalThis.fetch = jest.fn(async () => {
        const err = new Error('Malformed upstream status');
        err.status = 999;
        throw err;
      });

      try {
        const app = createApp({ requireLocalAuth: false, enableRateLimit: false });
        const res = await request(app).post('/api/chat').send({ prompt: 'hello' });
        expect(res.status).toBe(500);
        expect(res.body.error).toBeDefined();
      } finally {
        serverConfig.apiRetryAttempts = prevRetries;
      }
    });

    test('POST /api/fs/rename returns 400 when moving directory into itself or conflicting with directory', async () => {
      const parentDir = path.join(tmpDir, 'parent');
      await fs.mkdir(parentDir, { recursive: true });
      const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

      const selfMove = await request(app)
        .post('/api/fs/rename')
        .send({ oldPath: parentDir, newPath: path.join(parentDir, 'child') });
      expect(selfMove.status).toBe(400);
      expect(selfMove.body.error).toContain('into itself');

      const existingFile = path.join(tmpDir, 'plain.txt');
      await fs.writeFile(existingFile, 'hi');
      const dirOverFile = await request(app)
        .post('/api/fs/create')
        .send({ path: existingFile, type: 'directory' });
      expect(dirOverFile.status).toBe(400);
    });
  });

  describe('ISSUE-08: image UI capability filtering, editorBackground option & feature fallback', () => {
    test('index.html uses valid gpt-image background option "opaque" instead of "original"', async () => {
      const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf-8');
      expect(html).toContain('<option value="opaque">opaque</option>');
      expect(html).not.toContain('<option value="original">original</option>');
    });

    test('image.js omits gpt-image-only params for non-gpt editors and recovers valid model on feature switch', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStorage = global.localStorage;
      const prevDOMParser = global.DOMParser;

      const elements = new Map();
      for (const id of [
        'imageFeature',
        'imageToImageParams',
        'textToImageParams',
        'modelParamsSection',
        'modelParamsGrid',
        'editorSize',
        'editorQuality',
        'editorN',
        'editorBackground',
        'editorOutputFormat',
        'editorOutputCompression',
        'generateImageBtnText',
        'clearImageBtn',
      ]) {
        elements.set(
          id,
          makeMockElement(id.includes('Select') || id.includes('Feature') ? 'select' : 'div', id),
        );
      }
      elements.get('imageFeature').value = 'IMAGE_GENERATOR';
      elements.get('editorSize').value = '1024x1024';
      elements.get('editorQuality').value = 'medium';
      elements.get('editorN').value = '1';
      elements.get('editorBackground').value = 'auto';
      elements.get('editorOutputFormat').value = 'webp';

      // Wrap quick-edit inputs in .u-flex-1 + .row containers as in index.html
      for (const fid of [
        'editorSize',
        'editorQuality',
        'editorN',
        'editorBackground',
        'editorOutputFormat',
        'editorOutputCompression',
      ]) {
        const row = makeMockElement('div');
        row.className = 'row';
        const flex = makeMockElement('div');
        flex.className = 'u-flex-1';
        flex.appendChild(elements.get(fid));
        row.appendChild(flex);
        elements.get('imageToImageParams').appendChild(row);
      }

      global.DOMParser = class {
        parseFromString() {
          return { documentElement: { tagName: 'svg', querySelector: () => null } };
        }
      };
      global.document = createBaseDocument({
        getElementById: (id) => elements.get(id) || null,
      });
      global.window = {
        addEventListener: () => {},
        dispatchEvent: () => {},
      };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };

      const postedBodies = [];
      globalThis.fetch = jest.fn(async (url, opts) => {
        const u = String(url);
        if (u.startsWith('/api/images/capabilities')) {
          const parsedUrl = new URL(u, 'http://localhost');
          const feature = parsedUrl.searchParams.get('feature');
          const model = parsedUrl.searchParams.get('model');
          if (feature === 'IMAGE_EDITOR' && model === 'black-forest-labs/flux-kontext-pro') {
            return new Response(
              JSON.stringify({
                provider: '1min',
                feature: 'IMAGE_EDITOR',
                model,
                models: [model],
                params: [
                  { key: 'imageUrl', type: 'image', required: true },
                  { key: 'prompt', type: 'text', required: true },
                  { key: 'guidance', type: 'number', min: 1, max: 10 },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (feature === 'IMAGE_UPSCALER' && model === 'gpt-image-2') {
            return new Response(
              JSON.stringify({
                error: 'model "gpt-image-2" does not support IMAGE_UPSCALER',
                code: 'UNSUPPORTED_IMAGE_MODEL',
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          if (feature === 'IMAGE_UPSCALER' && !model) {
            return new Response(
              JSON.stringify({
                provider: '1min',
                feature: 'IMAGE_UPSCALER',
                model: 'recraft',
                models: ['recraft'],
                params: [{ key: 'imageUrl', type: 'image', required: true }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
        }
        if (u === '/api/images/text-editor') {
          postedBodies.push(JSON.parse(opts.body));
          return new Response(
            JSON.stringify({ aiRecord: { status: 'SUCCESS', aiRecordDetail: { resultObject: ['x.png'] } } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      });

      try {
        const { toast } = await import('../public/js/toast.js');
        jest.spyOn(toast, 'success').mockImplementation(() => {});
        jest.spyOn(toast, 'error').mockImplementation(() => {});
        const { createImageManager } = await import('../public/js/image.js');
        const dom = {
          imageModel: makeMockElement('input', 'imageModel'),
          imageModelLabel: makeMockElement('span', 'imageModelLabel'),
          imagePrompt: makeMockElement('textarea', 'imagePrompt'),
          editorImageUrl: makeMockElement('input', 'editorImageUrl'),
          imageGallery: makeMockElement('div', 'imageGallery'),
          generateImage: makeMockElement('button', 'generateImage'),
          assetResult: makeMockElement('pre', 'assetResult'),
        };
        dom.imageModel.value = 'black-forest-labs/flux-kontext-pro';
        dom.editorImageUrl.value = 'images/input.png';
        dom.imagePrompt.value = 'add sunglasses';
        elements.get('imageFeature').value = 'IMAGE_EDITOR';

        const mgr = createImageManager(dom);
        await mgr.refreshCapabilities({ force: true });
        await mgr.generateImage();

        expect(postedBodies).toHaveLength(1);
        expect(postedBodies[0]).toEqual({
          provider: '1min',
          imageUrl: 'images/input.png',
          prompt: 'add sunglasses',
          model: 'black-forest-labs/flux-kontext-pro',
          params: {},
        });
        expect(elements.get('imageToImageParams').classList.contains('is-shown')).toBe(false);

        // Switching to IMAGE_UPSCALER recovers from UNSUPPORTED_IMAGE_MODEL automatically
        dom.imageModel.value = 'gpt-image-2';
        elements.get('imageFeature').value = 'IMAGE_UPSCALER';
        elements.get('imageFeature').dispatchEvent({ type: 'change' });
        await new Promise((r) => setTimeout(r, 30));

        expect(dom.imageModel.value).toBe('recraft');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.localStorage = prevStorage;
        global.DOMParser = prevDOMParser;
      }
    });
  });

  describe('ISSUE-09 & ISSUE-10: SSE failure detection, UTF-8 EOF stream flush & editor clean leak guard', () => {
    test('chat.js surfaces FAILED status inside SSE final-result frames as an error', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevDOMParser = global.DOMParser;

      const chatLog = makeMockElement('div', 'chatLog');
      const chatPrompt = makeMockElement('textarea', 'chatPrompt');
      chatPrompt.value = 'hello';

      global.DOMParser = class {
        parseFromString() {
          return { documentElement: { tagName: 'svg', querySelector: () => null } };
        }
      };
      global.document = createBaseDocument();
      global.window = {
        dispatchEvent: () => {},
        DOMPurify: { sanitize: (h) => h },
        marked: { parse: (m) => m },
      };

      const encoder = new TextEncoder();
      globalThis.fetch = jest.fn(async () => {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'event: final-result\ndata: {"aiRecord":{"status":"FAILURE","aiRecordDetail":{"errorMessage":"Moderation policy triggered"}}}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      });

      try {
        const { toast } = await import('../public/js/toast.js');
        const toastErrSpy = jest.spyOn(toast, 'error').mockImplementation(() => {});
        const { createChatManager, createChatState } = await import('../public/js/chat.js');
        const manager = createChatManager(
          {
            chatLog,
            chatPrompt,
            sendChatBtn: makeMockElement('button'),
            abortChatBtn: makeMockElement('button'),
            chatModel: { value: 'gpt-4o-mini' },
            conversationId: { value: '' },
            webSearch: { checked: false },
            chatAttachments: makeMockElement('div'),
            attachmentPreviews: makeMockElement('div'),
          },
          { chat: createChatState() },
        );
        await manager.sendChat(() => {});
        expect(toastErrSpy).toHaveBeenCalled();

        const aiBubble = chatLog.children.at(-1).children[1];
        expect(aiBubble.textContent).toContain('Moderation policy triggered');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.DOMParser = prevDOMParser;
      }
    });

    test('agent-core processCommandStream flushes split multi-byte UTF-8 EOF blocks accurately', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStorage = global.localStorage;

      global.document = createBaseDocument();
      global.window = { dispatchEvent: () => {} };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };

      const payloadBytes = Buffer.from(
        `event: done\ndata: ${JSON.stringify({ exitCode: 0, stdout: '日本語テスト完了', stderr: '' })}`,
        'utf-8',
      );
      const cutPoint = payloadBytes.length - 8;
      let turn = 0;
      let feedbackContent = '';

      try {
        const { createAgentRuntime } = await import('../public/js/agent-core.js');
        const dom = {
          explorerPath: { value: '/ws' },
          agentStatus: makeMockElement('span'),
          agentActivityLog: makeMockElement('div'),
          startAgentBtn: makeMockElement('button'),
          sendAgentFeedbackBtn: makeMockElement('button'),
          stopAgentBtn: makeMockElement('button'),
          resetAgentBtn: makeMockElement('button'),
          agentInstruction: makeMockElement('textarea'),
        };
        const runtime = createAgentRuntime({
          dom,
          state: { agent: { active: true, sessionId: null, history: [] }, editor: {} },
          api: (url, opts) => {
            if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-utf8' } });
            if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 3 });
            if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
            if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/ws', items: [] });
            if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
            if (url.includes('/commands?stream=true')) {
              return Promise.resolve(
                new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(payloadBytes.subarray(0, cutPoint));
                      controller.enqueue(payloadBytes.subarray(cutPoint));
                      controller.close();
                    },
                  }),
                  { status: 200, headers: { 'content-type': 'text/event-stream' } },
                ),
              );
            }
            if (url === '/api/agent/chat') {
              turn++;
              if (turn === 1) {
                return Promise.resolve({
                  text: '<call_tool name="run_command"><parameter name="command">echo ok</parameter></call_tool>',
                });
              }
              feedbackContent = JSON.parse(opts.body).messages.at(-1).content;
              return Promise.resolve({ text: '<finish>ok</finish>' });
            }
            return Promise.resolve({});
          },
          parseXMLTags: (txt) => {
            if (txt.includes('run_command')) {
              return { toolCall: { name: 'run_command', params: { command: 'echo ok' } } };
            }
            if (txt.includes('<finish>')) return { finish: 'ok' };
            return {};
          },
          t: (key) => key,
          setAgentStatus: () => {},
          addAgentTimelineStep: () => 'step-utf8',
          addAgentApprovalStep: () => {},
        });

        await runtime.runAgentLoop('test utf8');
        expect(feedbackContent).toContain('日本語テスト完了');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.localStorage = prevStorage;
      }
    });

    test('editor markClean ignores disposed models closed while an async save is pending', async () => {
      const prevMonaco = global.monaco;
      const models = new Map();
      global.monaco = {
        Uri: { file: (p) => ({ toString: () => `file://${p}` }) },
        editor: {
          getModel: (uri) => models.get(uri.toString()) || null,
        },
      };

      try {
        const { createEditorManager, createEditorState } = await import('../public/js/editor.js');
        const state = createEditorState();
        const mgr = createEditorManager(state);

        // Model does not exist (disposed when tab closed during save)
        mgr.markClean('/ws/closed.js', 5);
        expect(state.originalVersions['/ws/closed.js']).toBeUndefined();

        // Model exists -> records captured version cleanly
        models.set('file:///ws/open.js', { getAlternativeVersionId: () => 9 });
        mgr.markClean('/ws/open.js', 5);
        expect(state.originalVersions['/ws/open.js']).toBe(5);
      } finally {
        global.monaco = prevMonaco;
      }
    });

    test('model-picker notifies model-selected when loadModels updates imageModel and app.js guards rapid Start/Stop restarts', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStorage = global.localStorage;

      const imageModel = makeMockElement('input', 'imageModel');
      const imageModelLabel = makeMockElement('span', 'imageModelLabel');
      imageModel.value = 'gpt-image-2';
      const dispatched = [];

      global.document = createBaseDocument({
        getElementById: (id) => {
          if (id === 'imageModel') return imageModel;
          if (id === 'imageModelLabel') return imageModelLabel;
          return null;
        },
      });
      global.window = {
        dispatchEvent: (evt) => dispatched.push(evt),
      };
      global.localStorage = { getItem: () => '1forall', setItem: () => {}, removeItem: () => {} };
      globalThis.fetch = jest.fn(async () => {
        return new Response(
          JSON.stringify({
            providers: {
              '1forall': {
                chatModels: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI', tags: [] }],
                codeModels: [{ id: 'gpt-4o', label: 'GPT-4o', provider: 'OpenAI', tags: ['code'] }],
                imageModels: [
                  {
                    id: 'black-forest-labs/flux-schnell',
                    label: 'FLUX.1 Schnell',
                    provider: 'Black Forest Labs',
                    tags: ['image'],
                  },
                ],
                videoModels: [
                  { id: 'google-veo3', label: 'Google Veo 3', provider: 'Google', tags: ['video'] },
                ],
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });

      try {
        const { loadModels } = await import('../public/js/model-picker.js');
        await loadModels();
        expect(imageModel.value).toBe('black-forest-labs/flux-schnell');
        expect(
          dispatched.some(
            (e) =>
              e.type === 'model-selected' &&
              e.detail?.type === 'image' &&
              e.detail?.id === 'black-forest-labs/flux-schnell',
          ),
        ).toBe(true);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.localStorage = prevStorage;
      }

      const appSrc = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf-8');
      expect(appSrc).toMatch(/const uiRunId = \+\+_agentUiRunId;/);
      expect(appSrc).toMatch(/if \(uiRunId === _agentUiRunId\)/);
      expect(appSrc).toMatch(/currentNorm\.startsWith\(driveNorm \+ '\/'\)/);
    });
  });
});
