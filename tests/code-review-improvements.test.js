/**
 * Tests for code review improvements across frontend and backend.
 */
import { jest } from '@jest/globals';
import request from 'supertest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Code Review Improvements', () => {
  describe('public/index.html A11y & Dialog Semantics', () => {
    test('diffModal dialog has proper ARIA attributes and title ID', async () => {
      const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf-8');

      // Verify diff-dialog container has dialog role and aria attributes
      expect(html).toMatch(
        /class="[^"]*diff-dialog[^"]*"\s+role="dialog"\s+aria-modal="true"\s+aria-labelledby="diffModalTitle"/,
      );
      // Verify title has id matching aria-labelledby
      expect(html).toContain('id="diffModalTitle"');
    });
  });

  describe('agent-core.js computeHash resilience', () => {
    test('source code includes fallbackHash and safe window.crypto checks', async () => {
      const src = await fs.readFile(new URL('../public/js/agent-core.js', import.meta.url), 'utf-8');
      expect(src).toContain('function fallbackHash(text)');
      expect(src).toContain('window.crypto?.subtle?.digest');
      expect(src).toContain('return fallbackHash(text)');
    });

    test('fallbackHash produces deterministic hashes', async () => {
      // Extract and execute the fallback algorithm to verify determinism
      function fallbackHash(text) {
        let h1 = 0xdeadbeef ^ 0;
        let h2 = 0x41c6ce57 ^ 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text.charCodeAt(i);
          h1 = Math.imul(h1 ^ ch, 2654435761);
          h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 'fb_' + (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
      }

      const hash1 = fallbackHash('hello world');
      const hash2 = fallbackHash('hello world');
      const hash3 = fallbackHash('different text');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1.startsWith('fb_')).toBe(true);
    });
  });

  describe('chat.js error recovery', () => {
    test('removes streaming class in both catch and finally blocks', async () => {
      const src = await fs.readFile(new URL('../public/js/chat.js', import.meta.url), 'utf-8');
      expect(src).toMatch(/catch\s*\(e\)\s*\{\s*aiMsgDiv\.classList\.remove\('streaming'\);/);
      expect(src).toMatch(/finally\s*\{\s*aiMsgDiv\.classList\.remove\('streaming'\);/);
    });
  });

  describe('fs.js 0-byte file reading optimization', () => {
    let tmpDir;
    let app;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-fs-test-'));
      process.env.ALLOWED_ROOTS = tmpDir;
      process.env.NODE_ENV = 'test';
      const { createApp } = await import('../server.js');
      app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    });

    afterEach(async () => {
      delete process.env.ALLOWED_ROOTS;
      delete process.env.NODE_ENV;
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    });

    test('reads empty 0-byte text file successfully', async () => {
      const emptyFilePath = path.join(tmpDir, 'empty.txt');
      await fs.writeFile(emptyFilePath, '');

      const res = await request(app)
        .get(`/api/fs/read?path=${encodeURIComponent(emptyFilePath)}`)
        .set('host', '127.0.0.1');

      expect(res.status).toBe(200);
      expect(res.body.content).toBe('');
      expect(res.body.writable).toBe(true);
    });
  });

  describe('Frontend one-min-response & dom-style safeguards', () => {
    test('frontend one-min-response filters search metadata, handles DAGs, and survives circular objects', async () => {
      const { extractTextFromOneMinResponse } = await import('../public/js/one-min-response.js');
      const payload = {
        aiRecord: {
          aiRecordDetail: {
            resultObject: [
              { type: 'web_search', sources: ['https://example.com'] },
              '⚙ Crawling site https://example.com',
              'Final frontend answer',
            ],
          },
        },
      };
      expect(extractTextFromOneMinResponse(payload)).toBe('Final frontend answer');

      const node = { foo: 'bar' };
      const dag = { content: node, text: { resultObject: node } };
      expect(extractTextFromOneMinResponse(dag)).toBe(JSON.stringify(node, null, 2));

      const cyclic = {};
      cyclic.self = cyclic;
      expect(() => extractTextFromOneMinResponse({ resultObject: cyclic })).not.toThrow();
    });

    test('dom-style removeCriticalStylesByPrefix removes comparison slider rules without leaving orphans', async () => {
      const styleEl = {
        id: 'csp-dynamic-styles',
        textContent: '',
        setAttribute: () => {},
        getAttribute: () => null,
      };
      const prevDoc = global.document;
      global.document = {
        head: {
          contains: (el) => el === styleEl,
          appendChild: () => {},
        },
        querySelector: () => null,
        getElementById: (id) => (id === 'csp-dynamic-styles' ? styleEl : null),
        createElement: () => styleEl,
      };
      try {
        const { setCriticalStyle, removeCriticalStylesByPrefix, clearInjectedStyles } =
          await import('../public/js/dom-style.js');
        clearInjectedStyles();
        setCriticalStyle('.cmp-1 .image-before { clip-path: polygon(0 0); }');
        setCriticalStyle('.cmp-1 .slider-divider { left: 50%; }');
        setCriticalStyle('.cmp-2 .slider-divider { left: 10%; }');
        expect(styleEl.textContent).toContain('.cmp-1');
        expect(styleEl.textContent).toContain('.cmp-2');

        removeCriticalStylesByPrefix('.cmp-1 ');
        expect(styleEl.textContent).not.toContain('.cmp-1');
        expect(styleEl.textContent).toContain('.cmp-2');
      } finally {
        global.document = prevDoc;
      }
    });

    test('chatManager cancels pending stream render timer, prevents re-entry, and keeps error status', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevDOMParser = global.DOMParser;

      global.DOMParser = class {
        parseFromString() {
          return {
            documentElement: {
              tagName: 'svg',
              querySelector: () => null,
            },
          };
        }
      };

      const makeEl = (cls = '') => {
        const children = [];
        const el = {
          className: cls,
          children,
          textContent: '',
          innerHTML: '',
          value: '',
          disabled: false,
          scrollTop: 0,
          clientHeight: 100,
          scrollHeight: 100,
          style: {},
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
            contains: (name) => el.className.split(/\s+/).filter(Boolean).includes(name),
          },
          setAttribute: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          querySelectorAll: () => [],
          closest: () => null,
          focus: () => {},
          select: () => {},
          remove: () => {},
          appendChild: (child) => {
            children.push(child);
            return child;
          },
          removeChild: (child) => {
            const idx = children.indexOf(child);
            if (idx !== -1) children.splice(idx, 1);
          },
        };
        Object.defineProperty(el, 'firstChild', { get: () => children[0] || null });
        return el;
      };

      global.document = {
        cookie: '',
        documentElement: { lang: 'en' },
        head: { contains: () => false, appendChild: () => {} },
        body: makeEl(),
        createElement: () => makeEl(),
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
      };
      global.window = { dispatchEvent: () => {} };

      const { createChatManager, createChatState } = await import('../public/js/chat.js');

      const chatLog = makeEl();
      const chatPrompt = makeEl();
      chatPrompt.value = 'Hello world';
      const sendChatBtn = makeEl();
      const abortChatBtn = makeEl();
      const dom = {
        chatPrompt,
        chatLog,
        sendChatBtn,
        abortChatBtn,
        attachmentPreviews: makeEl(),
        chatAttachments: makeEl(),
        chatModel: { value: 'gpt-4o-mini' },
        conversationId: { value: '' },
        webSearch: { checked: false },
      };
      const state = { chat: createChatState() };
      const manager = createChatManager(dom, state);

      const encoder = new TextEncoder();
      global.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('event:error\ndata:{"error":"upstream boom"}\n\n'));
              controller.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );

      const statusCalls = [];
      try {
        await manager.sendChat((txt, cls) => statusCalls.push({ txt, cls }));
        expect(statusCalls.at(-1).cls).toBe('err');

        // Also test normal stream cancels pending render timer & blocks concurrent sendChat re-entry
        chatPrompt.value = 'Test markdown';
        let fetchCount = 0;
        let finishStream;
        global.window.DOMPurify = { sanitize: (h) => h };
        global.window.marked = { parse: (m) => `<h1>${m.replace(/^#\s*/, '')}</h1>` };
        global.fetch = () => {
          fetchCount++;
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode('event: content\ndata: {"content":"# Title"}\n\n'));
                  finishStream = () => {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                  };
                },
              }),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        };

        const p1 = manager.sendChat((txt, cls) => statusCalls.push({ txt, cls }));
        const p2 = manager.sendChat((txt, cls) => statusCalls.push({ txt, cls }));
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchCount).toBe(1);
        finishStream();
        await Promise.all([p1, p2]);
        await new Promise((r) => setTimeout(r, 160));
        const aiDiv = chatLog.children.at(-1).children[1];
        expect(aiDiv.innerHTML).toContain('<h1>Title</h1>');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.DOMParser = prevDOMParser;
      }
    });
  });

  describe('Cycle 4 UI & Editor Fixes', () => {
    const createRichMockDom = () => {
      const elementsById = new Map();
      const elementsByClass = new Map();
      const docListeners = new Map();

      const makeEl = (tag = 'div', id = '', cls = '') => {
        const children = [];
        const listeners = new Map();
        const attrs = new Map();
        let textVal = '';
        const matchesSingle = (node, part) => {
          if (part === 'button') return node.tagName === 'BUTTON';
          if (part === 'a') return node.tagName === 'A';
          if (part === 'img:not(.image-before)') {
            return node.tagName === 'IMG' && !node.classList?.contains('image-before');
          }
          if (part.startsWith('.')) {
            return part
              .slice(1)
              .split('.')
              .every((c) => node.classList?.contains(c));
          }
          return false;
        };
        const el = {
          tagName: tag.toUpperCase(),
          id,
          className: cls,
          children,
          parentElement: null,
          get lastChild() {
            return children[children.length - 1] || null;
          },
          get childElementCount() {
            return children.length;
          },
          get textContent() {
            return textVal;
          },
          set textContent(v) {
            textVal = String(v ?? '');
            children.length = 0;
          },
          innerHTML: '',
          title: '',
          value: '',
          checked: false,
          disabled: false,
          max: '',
          type: '',
          offsetHeight: 300,
          dataset: {},
          style: {},
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
              const addIt = force === undefined ? !set.has(name) : Boolean(force);
              if (addIt) set.add(name);
              else set.delete(name);
              el.className = [...set].join(' ');
              return addIt;
            },
            contains: (name) => el.className.split(/\s+/).filter(Boolean).includes(name),
            [Symbol.iterator]: function* () {
              yield* el.className.split(/\s+/).filter(Boolean);
            },
          },
          setAttribute: (k, v) => attrs.set(k, String(v)),
          getAttribute: (k) => attrs.get(k) ?? null,
          removeAttribute: (k) => attrs.delete(k),
          addEventListener: (type, fn) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(fn);
          },
          removeEventListener: (type, fn) => {
            listeners.get(type)?.delete(fn);
          },
          dispatchEvent: (evt) => {
            const eventObj = { target: el, stopPropagation: () => {}, preventDefault: () => {}, ...evt };
            for (const fn of listeners.get(eventObj.type) || []) {
              fn(eventObj);
            }
          },
          querySelector: (sel) => el.querySelectorAll(sel)[0] || null,
          querySelectorAll: (sel) => {
            const parts = sel
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean);
            const out = [];
            const walk = (node) => {
              for (const child of node.children || []) {
                if (parts.some((p) => matchesSingle(child, p))) out.push(child);
                walk(child);
              }
            };
            walk(el);
            return out;
          },
          closest: () => null,
          contains: (other) => {
            if (other === el) return true;
            return children.some((c) => c === other || c.contains?.(other));
          },
          focus: () => {},
          select: () => {},
          scrollIntoView: () => {},
          remove: () => {
            el.parentElement?.removeChild(el);
          },
          getBoundingClientRect: () => ({ top: 100, bottom: 130, left: 20, width: 120 }),
          appendChild: (child) => {
            child.parentElement = el;
            children.push(child);
            return child;
          },
          prepend: (child) => {
            child.parentElement = el;
            children.unshift(child);
            return child;
          },
          removeChild: (child) => {
            const idx = children.indexOf(child);
            if (idx !== -1) {
              children.splice(idx, 1);
              child.parentElement = null;
            }
          },
          click: () => {
            if (typeof el.onclick === 'function') {
              el.onclick({ stopPropagation: () => {}, preventDefault: () => {}, target: el });
            }
            el.dispatchEvent({ type: 'click' });
          },
        };
        if (id) elementsById.set(id, el);
        for (const c of cls.split(/\s+/).filter(Boolean)) {
          if (!elementsByClass.has(c)) elementsByClass.set(c, []);
          elementsByClass.get(c).push(el);
        }
        return el;
      };

      const body = makeEl('body');
      const documentMock = {
        cookie: '',
        documentElement: { lang: 'en' },
        head: { contains: () => false, appendChild: () => {} },
        body,
        activeElement: null,
        createElement: (tag) => makeEl(tag),
        getElementById: (id) => elementsById.get(id) || null,
        querySelector: (sel) => documentMock.querySelectorAll(sel)[0] || null,
        querySelectorAll: (sel) => {
          if (sel.startsWith('#modelPickerList ')) {
            const listEl = elementsById.get('modelPickerList');
            return listEl ? listEl.querySelectorAll(sel.replace('#modelPickerList ', '')) : [];
          }
          if (sel.startsWith('.')) {
            return [...(elementsByClass.get(sel.slice(1)) || [])];
          }
          return [];
        },
        addEventListener: (type, fn) => {
          if (!docListeners.has(type)) docListeners.set(type, new Set());
          docListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => {
          docListeners.get(type)?.delete(fn);
        },
        dispatchEvent: (evt) => {
          for (const fn of docListeners.get(evt.type) || []) {
            fn(evt);
          }
        },
      };

      return { makeEl, documentMock, elementsById };
    };

    test('editor-tabs reuses blank model URI and ignores stale out-of-order openFile responses', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevMonaco = global.monaco;

      const { makeEl, documentMock } = createRichMockDom();
      const models = new Map();
      let blankCreates = 0;

      global.document = documentMock;
      global.window = { dispatchEvent: () => {} };
      global.monaco = {
        Uri: {
          from: ({ scheme, path }) => ({ scheme, path, toString: () => `${scheme}://${path}` }),
          file: (p) => ({ scheme: 'file', path: p, toString: () => `file://${p}` }),
        },
        editor: {
          getModel: (uri) => models.get(uri.toString()) || null,
          createModel: (val, _lang, uri) => {
            const key = uri.toString();
            if (key === 'inmemory:///__blank__') blankCreates++;
            const model = {
              uriKey: key,
              _value: val,
              setValue: (v) => {
                model._value = v;
              },
              getValue: () => model._value,
              dispose: () => {
                models.delete(key);
              },
            };
            models.set(key, model);
            return model;
          },
        },
      };

      try {
        const { createEditorTabManager } = await import('../public/js/editor-tabs.js');

        let activeModel = null;
        const editorState = {
          activeFilePath: null,
          openTabs: [],
          readOnlyFiles: {},
        };
        const editorManager = {
          instance: {
            updateOptions: () => {},
            setModel: (m) => {
              activeModel = m;
            },
          },
          getOrCreateModel: (filePath, content) => {
            const uri = global.monaco.Uri.file(filePath);
            return (
              global.monaco.editor.getModel(uri) ||
              global.monaco.editor.createModel(content, 'javascript', uri)
            );
          },
          markClean: () => {},
          disposeUnusedModels: () => {},
          isDirty: () => false,
        };
        const dom = {
          editorTabsBar: makeEl('div'),
          currentFileName: makeEl('span'),
          saveFileBtn: makeEl('button'),
        };

        let resolveSlow;
        global.fetch = (url) => {
          if (url.includes('slow.js')) {
            return new Promise((resolve) => {
              resolveSlow = () =>
                resolve(
                  new Response(JSON.stringify({ content: 'slow-content', writable: true }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  }),
                );
            });
          }
          const name = url.includes('fast.js') ? 'fast-content' : 'normal-content';
          return Promise.resolve(
            new Response(JSON.stringify({ content: name, writable: true }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        };

        const tabs = createEditorTabManager(editorState, editorManager, dom);

        // Blank model should be created only once across repeated close-to-blank transitions
        await tabs.openFile('/a.js');
        tabs.closeTabInternal('/a.js');
        await tabs.openFile('/b.js');
        tabs.closeTabInternal('/b.js');
        expect(blankCreates).toBe(1);
        expect(activeModel?.uriKey).toBe('inmemory:///__blank__');

        // Stale out-of-order openFile response must not override newer selection
        const slowPromise = tabs.openFile('/slow.js');
        const fastPromise = tabs.openFile('/fast.js');
        await fastPromise;
        resolveSlow();
        await slowPromise;
        expect(editorState.activeFilePath).toBe('/fast.js');
        expect(activeModel?.uriKey).toBe('file:///fast.js');

        // Dirty open tab should not be overwritten by openFile and closing must clear metadata
        editorState.readOnlyFiles['/fast.js'] = false;
        editorManager.isDirty = (p) => p === '/fast.js';
        const fastModel = global.monaco.editor.getModel(global.monaco.Uri.file('/fast.js'));
        fastModel.setValue('unsaved user edits');
        await tabs.openFile('/fast.js');
        expect(fastModel.getValue()).toBe('unsaved user edits');
        tabs.closeTabInternal('/fast.js');
        expect(editorState.readOnlyFiles['/fast.js']).toBeUndefined();
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.monaco = prevMonaco;
      }
    });

    test('settings coordinates webSearch disabled state with creditSavingToggle and 1forall capabilities', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevStorage = global.localStorage;

      const { makeEl, documentMock } = createRichMockDom();
      const ids = [
        'creditSavingToggle',
        'webSearch',
        'chatNumOfSite',
        'chatMaxWord',
        'withMemories',
        'isMixed',
        'brandVoiceId',
        'createConversation',
        'conversationId',
        'attachImageBtn',
        'codeWebSearch',
        'codeNumOfSite',
        'codeMaxWord',
        'numOutputs',
        'providerConfigDot',
      ];
      const labels = new Map();
      for (const id of ids) {
        const el = makeEl('input', id);
        const lbl = makeEl('label');
        el.closest = (sel) => (sel === 'label' ? lbl : null);
        labels.set(id, lbl);
      }

      const creditSavingToggle = documentMock.getElementById('creditSavingToggle');
      const webSearch = documentMock.getElementById('webSearch');
      const codeWebSearch = documentMock.getElementById('codeWebSearch');
      const withMemories = documentMock.getElementById('withMemories');

      global.document = documentMock;
      global.window = { dispatchEvent: () => {} };
      global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

      try {
        const { applyProviderCapabilitiesToUi } = await import('../public/js/settings.js');

        creditSavingToggle.checked = true;
        applyProviderCapabilitiesToUi('1min');
        expect(webSearch.disabled).toBe(true);
        expect(codeWebSearch.disabled).toBe(true);
        expect(withMemories.disabled).toBe(false);

        creditSavingToggle.checked = false;
        applyProviderCapabilitiesToUi('1min');
        expect(webSearch.disabled).toBe(false);
        expect(codeWebSearch.disabled).toBe(false);

        applyProviderCapabilitiesToUi('1forall');
        expect(webSearch.disabled).toBe(true);
        expect(codeWebSearch.disabled).toBe(true);
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.localStorage = prevStorage;
      }
    });

    test('model-picker applies creditSaving filter to image models and searches by model id', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevStorage = global.localStorage;

      const { makeEl, documentMock } = createRichMockDom();
      const imageBtn = makeEl('button', '', 'model-picker-btn');
      imageBtn.dataset = { modelType: 'image', targetInput: 'imageModel' };
      makeEl('input', 'imageModel');
      makeEl('span', 'imageModelLabel');
      makeEl('input', 'editorImageUrl');
      makeEl('div', 'modelPickerDropdown', 'u-hidden');
      const searchInput = makeEl('input', 'modelPickerSearch');
      const pickerList = makeEl('div', 'modelPickerList');
      const tabAll = makeEl('button', '', 'picker-tab active');
      tabAll.dataset = { tag: 'all' };

      global.document = documentMock;
      global.window = {
        innerHeight: 800,
        innerWidth: 1200,
        scrollY: 0,
        addEventListener: () => {},
        dispatchEvent: () => {},
      };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };
      global.fetch = (url) => {
        if (url === '/api/models') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                providers: {
                  '1min': {
                    chatModels: [
                      { id: 'gpt-4o-mini', label: 'GPT-4o mini', provider: 'OpenAI', tags: ['fast'] },
                    ],
                    codeModels: [
                      {
                        id: 'qwen3-coder-plus',
                        label: 'Qwen3 Coder Plus',
                        provider: 'Alibaba',
                        tags: ['code'],
                      },
                    ],
                    imageModels: [
                      {
                        id: 'bfl/flux-schnell-2',
                        label: 'Quick Diffusion',
                        provider: 'BFL',
                        tags: ['image', 'fast'],
                      },
                      {
                        id: 'openai/gpt-image-2',
                        label: 'HD Painter',
                        provider: 'OpenAI',
                        tags: ['image', 'flagship'],
                      },
                      {
                        id: 'edit-special',
                        label: 'Mask Editor',
                        provider: 'Editor',
                        tags: ['image', 'editor'],
                      },
                    ],
                    videoModels: [{ id: 'kling', label: 'Kling AI', provider: 'Kling', tags: ['video'] }],
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ models: { source: 'live' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };

      try {
        const { initModelPickers, loadModels, setCreditSavingMode } =
          await import('../public/js/model-picker.js');

        await loadModels();
        initModelPickers();

        setCreditSavingMode(true);
        imageBtn.click();
        await new Promise((r) => setTimeout(r, 25));

        let renderedIds = pickerList.querySelectorAll('.model-picker-item').map((el) => el.dataset.id);
        expect(renderedIds).toEqual(['bfl/flux-schnell-2']);

        // Close picker, turn off creditSaving, reopen, and search by model id substring not in label
        documentMock.dispatchEvent({ type: 'keydown', key: 'Escape' });
        setCreditSavingMode(false);
        imageBtn.click();
        await new Promise((r) => setTimeout(r, 25));

        searchInput.value = 'gpt-image-2';
        searchInput.dispatchEvent({ type: 'input' });
        renderedIds = pickerList.querySelectorAll('.model-picker-item').map((el) => el.dataset.id);
        expect(renderedIds).toEqual(['openai/gpt-image-2']);

        documentMock.dispatchEvent({ type: 'keydown', key: 'Escape' });
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.localStorage = prevStorage;
      }
    });

    test('agent-core always cleans up active state on early session failure and prevents stale loop overwrite', async () => {
      const prevStorage = global.localStorage;
      const { makeEl } = createRichMockDom();
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };

      try {
        const { createAgentRuntime } = await import('../public/js/agent-core.js');
        const makeAgentDom = () => ({
          explorerPath: { value: '/workspace' },
          codeModel: { value: 'qwen3-coder-plus' },
          startAgentBtn: makeEl('button', '', 'is-hidden'),
          sendAgentFeedbackBtn: makeEl('button', '', 'is-shown'),
          stopAgentBtn: makeEl('button', '', 'is-shown'),
          resetAgentBtn: makeEl('button', '', 'is-hidden'),
          agentInstruction: makeEl('textarea'),
          agentStatus: makeEl('span'),
        });

        // 1. Session creation failure must still clean up active flag, abortController, and button classes
        const dom1 = makeAgentDom();
        const state1 = {
          agent: { active: true, sessionId: null, history: [], abortController: null },
          editor: { activeFilePath: null },
        };
        const rt1 = createAgentRuntime({
          dom: dom1,
          state: state1,
          api: async () => {
            throw new Error('session create failed');
          },
          t: (_k, fallback) => fallback || _k,
          parseXMLTags: () => ({}),
          setAgentStatus: (_txt, cls) => {
            dom1.agentStatus.className = cls || '';
          },
          addAgentTimelineStep: () => {},
          addAgentApprovalStep: () => {},
        });

        await rt1.runAgentLoop('hello');
        expect(state1.agent.active).toBe(false);
        expect(state1.agent.abortController).toBeNull();
        expect(dom1.startAgentBtn.classList.contains('is-hidden')).toBe(false);
        expect(dom1.stopAgentBtn.classList.contains('is-shown')).toBe(false);

        // 2. Starting a second run aborts the first; first finishing later must not clobber the second run
        const dom2 = makeAgentDom();
        const state2 = {
          agent: { active: true, sessionId: null, history: [], abortController: null },
          editor: { activeFilePath: null },
        };
        let rejectFirstSession;
        let finishSecondChat;
        const rt2 = createAgentRuntime({
          dom: dom2,
          state: state2,
          api: (url, opts = {}) => {
            if (url === '/api/agent/sessions') {
              if (!rejectFirstSession) {
                return new Promise((_resolve, reject) => {
                  rejectFirstSession = () => {
                    const err = new Error('Aborted');
                    err.name = 'AbortError';
                    reject(err);
                  };
                  opts.signal?.addEventListener?.('abort', () => rejectFirstSession(), { once: true });
                });
              }
              return Promise.resolve({ session: { id: 'sess-2' } });
            }
            if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 5 });
            if (url.includes('/project-info')) return Promise.resolve({ project: null });
            if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
            if (url === '/api/agent/chat') {
              return new Promise((resolve) => {
                finishSecondChat = () => resolve({ text: '<finish>done</finish>' });
              });
            }
            return Promise.resolve({});
          },
          t: (_k, fallback) => fallback || _k,
          parseXMLTags: (txt) =>
            txt.includes('<finish>') ? { finish: 'done', thought: null, toolCall: null } : { toolCall: null },
          setAgentStatus: (_txt, cls) => {
            dom2.agentStatus.className = cls || '';
          },
          addAgentTimelineStep: () => {},
          addAgentApprovalStep: () => {},
        });

        const firstRun = rt2.runAgentLoop('first');
        await new Promise((r) => setTimeout(r, 15));
        const secondRun = rt2.runAgentLoop('second');
        await firstRun;

        // While second run is still in-flight, state.agent.active & abortController stay active!
        expect(state2.agent.active).toBe(true);
        expect(state2.agent.abortController).not.toBeNull();
        expect(dom2.stopAgentBtn.classList.contains('is-shown')).toBe(true);

        for (let i = 0; i < 40 && !finishSecondChat; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        finishSecondChat();
        await secondRun;
        expect(state2.agent.active).toBe(false);
        expect(state2.agent.abortController).toBeNull();
      } finally {
        global.localStorage = prevStorage;
      }
    });

    test('editor bridges Monaco CancellationToken.onCancellationRequested to AbortSignal and disposes subscription', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevStorage = global.localStorage;
      const prevMonaco = global.monaco;
      const prevResizeObserver = global.ResizeObserver;

      const { makeEl, documentMock } = createRichMockDom();
      makeEl('div', 'editor');
      const codeModel = makeEl('input', 'codeModel');
      codeModel.value = 'qwen3-coder-plus';
      const codeMaxWord = makeEl('input', 'codeMaxWord');
      codeMaxWord.value = '500';

      const providers = new Map();
      global.document = documentMock;
      global.window = {
        matchMedia: () => ({ matches: false }),
        dispatchEvent: () => {},
      };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };
      global.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
      global.monaco = {
        KeyMod: { CtrlCmd: 2048 },
        KeyCode: { KeyS: 49, KeyI: 39 },
        Range: class {
          constructor(sl, sc, el, ec) {
            this.sl = sl;
            this.sc = sc;
            this.el = el;
            this.ec = ec;
          }
        },
        editor: {
          create: () => ({
            addCommand: () => {},
            layout: () => {},
            dispose: () => {},
          }),
          setTheme: () => {},
        },
        languages: {
          registerInlineCompletionsProvider: (lang, provider) => {
            providers.set(lang, provider);
          },
        },
      };

      let observedSignal = null;
      let finishFetch;
      global.fetch = (_url, opts = {}) => {
        observedSignal = opts.signal;
        return new Promise((resolve) => {
          finishFetch = () =>
            resolve(
              new Response(JSON.stringify({ suggestion: 'console.log(1);' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        });
      };

      try {
        const { createEditorManager, createEditorState } = await import('../public/js/editor.js');
        const mgr = createEditorManager(createEditorState());
        mgr.init();

        const provider = providers.get('javascript');
        let cancelCallback = null;
        let disposed = false;
        const token = {
          isCancellationRequested: false,
          onCancellationRequested: (cb) => {
            cancelCallback = cb;
            return {
              dispose: () => {
                disposed = true;
              },
            };
          },
        };
        const fakeModel = {
          getLineCount: () => 5,
          getLineMaxColumn: () => 20,
          getValueInRange: () => 'const foo',
          getLineContent: () => 'const foo',
          getLanguageId: () => 'javascript',
        };

        const completionPromise = provider.provideInlineCompletions(
          fakeModel,
          { lineNumber: 1, column: 10 },
          {},
          token,
        );
        for (let i = 0; i < 40 && !observedSignal; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }

        expect(observedSignal).not.toBeNull();
        expect(observedSignal.aborted).toBe(false);
        expect(typeof cancelCallback).toBe('function');

        token.isCancellationRequested = true;
        cancelCallback();
        expect(observedSignal.aborted).toBe(true);

        finishFetch();
        const result = await completionPromise;
        expect(result).toBeUndefined();
        expect(disposed).toBe(true);
        mgr.dispose();
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.localStorage = prevStorage;
        global.monaco = prevMonaco;
        global.ResizeObserver = prevResizeObserver;
      }
    });

    test('explorer prevents duplicate expand requests, rolls back failed expands, and reapplies active filter', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevDOMParser = global.DOMParser;

      const { makeEl, documentMock } = createRichMockDom();
      const searchInput = makeEl('input', 'fileSearchInput');
      searchInput.value = 'app';
      const fileTree = makeEl('div', 'fileTree');
      const explorerPath = makeEl('input', 'explorerPath');

      global.document = documentMock;
      global.window = { innerWidth: 1200, innerHeight: 800, dispatchEvent: () => {} };
      global.DOMParser = class {
        parseFromString() {
          return { documentElement: { tagName: 'svg', querySelector: () => null } };
        }
      };

      let listCallCount = 0;
      let rejectExpand;
      global.fetch = (url) => {
        listCallCount++;
        if (url === '/api/fs/list') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                dir: '/ws',
                items: [{ name: 'sub', isDirectory: true, path: '/ws/sub' }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        if (listCallCount === 2) {
          return new Promise((_resolve, reject) => {
            rejectExpand = () => reject(new Error('list boom'));
          });
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              dir: '/ws/sub',
              items: [
                { name: 'app.js', isDirectory: false, path: '/ws/sub/app.js' },
                { name: 'notes.txt', isDirectory: false, path: '/ws/sub/notes.txt' },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      };

      try {
        const { createExplorerManager } = await import('../public/js/explorer.js');
        const explorer = createExplorerManager({ fileTree, explorerPath }, () => {});
        await explorer.loadWorkspace();

        const folderNode = fileTree.querySelectorAll('.tree-node')[0];
        const childrenContainer = fileTree.querySelectorAll('.tree-children')[0];

        // Double click while first expand is in flight should issue only one request
        folderNode.click();
        folderNode.click();
        expect(listCallCount).toBe(2);

        rejectExpand();
        await new Promise((r) => setTimeout(r, 25));

        expect(folderNode.classList.contains('expanded')).toBe(false);
        expect(folderNode.getAttribute('aria-expanded')).toBe('false');
        expect(childrenContainer.classList.contains('is-expanded')).toBe(false);

        // Retry expand cleanly and verify active #fileSearchInput filter ("app") hides notes.txt
        folderNode.click();
        for (let i = 0; i < 40 && childrenContainer.childElementCount < 2; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }

        const loadedFiles = childrenContainer.querySelectorAll('.tree-node.file');
        expect(loadedFiles).toHaveLength(2);
        expect(loadedFiles[0].style.display).toBe('');
        expect(loadedFiles[1].style.display).toBe('none');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.DOMParser = prevDOMParser;
      }
    });

    test('image manager blocks concurrent generation calls and purges comparison CSS on card eviction', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevStorage = global.localStorage;
      const prevDOMParser = global.DOMParser;

      const { makeEl, documentMock } = createRichMockDom();
      const styleTag = makeEl('style', 'csp-dynamic-styles');
      documentMock.head = {
        contains: (n) => n === styleTag,
        appendChild: () => {},
      };
      const numOutputs = makeEl('input', 'numOutputs');
      numOutputs.value = '1';
      const aspectRatio = makeEl('input', 'aspectRatio');
      aspectRatio.value = '1:1';
      makeEl('input', 'assetInput');

      const gallery = makeEl('div', 'imageGallery');
      for (let i = 0; i < 50; i++) {
        const card = makeEl('div', '', 'imageCard');
        if (i === 49) {
          const cmp = makeEl('div', '', 'image-comparison-slider cmp-evicted');
          card.appendChild(cmp);
        }
        gallery.appendChild(card);
      }

      const dom = {
        imageGallery: gallery,
        editorImageUrl: makeEl('input', 'editorImageUrl'),
        imagePrompt: Object.assign(makeEl('textarea', 'imagePrompt'), { value: 'draw a cat' }),
        imageModel: Object.assign(makeEl('input', 'imageModel'), { value: 'gpt-image-2' }),
        imageModelLabel: makeEl('span', 'imageModelLabel'),
        generateImage: makeEl('button', 'generateImageBtn'),
        assetResult: makeEl('pre', 'assetResult'),
      };

      global.document = documentMock;
      global.window = { dispatchEvent: () => {} };
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };
      global.DOMParser = class {
        parseFromString() {
          return { documentElement: { tagName: 'svg', querySelector: () => null } };
        }
      };

      let fetchCalls = 0;
      let finishGen;
      global.fetch = () => {
        fetchCalls++;
        return new Promise((resolve) => {
          finishGen = () =>
            resolve(
              new Response(JSON.stringify({ images: ['https://example.com/generated.png'] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
            );
        });
      };

      try {
        const { setCriticalStyle, clearInjectedStyles } = await import('../public/js/dom-style.js');
        const { createImageManager } = await import('../public/js/image.js');

        clearInjectedStyles();
        setCriticalStyle('.cmp-evicted .image-before { clip-path: polygon(0 0); }');
        setCriticalStyle('.cmp-keep .slider-divider { left: 25%; }');
        expect(styleTag.textContent).toContain('.cmp-evicted');

        const mgr = createImageManager(dom);
        const p1 = mgr.generateImage();
        const p2 = mgr.generateImage();
        expect(fetchCalls).toBe(1);
        expect(dom.generateImage.disabled).toBe(true);

        finishGen();
        await Promise.all([p1, p2]);
        expect(dom.generateImage.disabled).toBe(false);
        expect(gallery.children.length).toBe(50);
        expect(styleTag.textContent).not.toContain('.cmp-evicted');
        expect(styleTag.textContent).toContain('.cmp-keep');

        // Clearing editor image on 1forall provider must fall back to a 1forall model, not gpt-image-2
        global.localStorage = { getItem: () => '1forall', setItem: () => {}, removeItem: () => {} };
        global.fetch = () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                providers: {
                  '1forall': {
                    imageModels: [
                      { id: 'flux-edit', label: 'Flux Edit', provider: '1forall', tags: ['editor'] },
                    ],
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        const { loadModels } = await import('../public/js/model-picker.js');
        await loadModels();
        dom.imageModel.value = 'flux-edit';
        mgr.clearImage();
        expect(dom.imageModel.value).toBe('black-forest-labs/flux-schnell');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.localStorage = prevStorage;
        global.DOMParser = prevDOMParser;
      }
    });

    test('agent-core search_files and find_files forward dir and maxResults query parameters', async () => {
      const prevStorage = global.localStorage;
      const { makeEl } = createRichMockDom();
      global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };

      const calledUrls = [];
      try {
        const { createAgentRuntime } = await import('../public/js/agent-core.js');
        const dom = {
          explorerPath: { value: '/workspace' },
          codeModel: { value: 'qwen3-coder-plus' },
          startAgentBtn: makeEl('button'),
          sendAgentFeedbackBtn: makeEl('button'),
          stopAgentBtn: makeEl('button'),
          resetAgentBtn: makeEl('button'),
          agentInstruction: makeEl('textarea'),
          agentStatus: makeEl('span'),
        };
        const state = {
          agent: { active: true, sessionId: null, history: [], abortController: null },
          editor: { activeFilePath: null },
        };

        let step = 0;
        const runtime = createAgentRuntime({
          dom,
          state,
          api: (url) => {
            calledUrls.push(url);
            if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-params' } });
            if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 5 });
            if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
            if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
            if (url === '/api/agent/chat') return Promise.resolve({ text: 'ok' });
            if (url.includes('/search?')) {
              return Promise.resolve({
                results: [{ file: '/workspace/src/a.js', line: 1, content: 'needle' }],
              });
            }
            if (url.includes('/find-files?')) {
              return Promise.resolve({ files: [{ relativePath: 'src/a.js' }] });
            }
            return Promise.resolve({});
          },
          t: (_k, fallback) => fallback || _k,
          parseXMLTags: () => {
            step++;
            if (step === 1) {
              return {
                toolCall: {
                  name: 'search_files',
                  params: { query: 'needle', dir: 'src', maxResults: 15 },
                },
              };
            }
            if (step === 2) {
              return {
                toolCall: {
                  name: 'find_files',
                  params: { pattern: '*.js', dir: 'src', maxResults: 10 },
                },
              };
            }
            return { finish: 'done' };
          },
          setAgentStatus: () => {},
          addAgentTimelineStep: () => {},
          addAgentApprovalStep: () => {},
        });

        await runtime.runAgentLoop('search with dir and maxResults');

        const searchCall = calledUrls.find((u) => u.includes('/search?'));
        expect(searchCall).toBeDefined();
        expect(searchCall).toContain(`dir=${encodeURIComponent('/workspace/src')}`);
        expect(searchCall).toContain('maxResults=15');

        const findCall = calledUrls.find((u) => u.includes('/find-files?'));
        expect(findCall).toBeDefined();
        expect(findCall).toContain('maxResults=10');
      } finally {
        global.localStorage = prevStorage;
      }
    });

    test('editor-tabs handlePathDeleted and handlePathRenamed sync open tabs and active editor model', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevMonaco = global.monaco;

      const { makeEl, documentMock } = createRichMockDom();
      const models = new Map();
      let activeModel = null;

      global.document = documentMock;
      global.window = { dispatchEvent: () => {} };
      global.monaco = {
        Uri: {
          from: ({ scheme, path: p }) => ({ scheme, path: p, toString: () => `${scheme}://${p}` }),
          file: (p) => ({ scheme: 'file', path: p, toString: () => `file://${p}` }),
        },
        editor: {
          getModel: (uri) => models.get(uri.toString()) || null,
          createModel: (val, _lang, uri) => {
            const key = uri.toString();
            const model = {
              uriKey: key,
              _value: val,
              _ver: 1,
              setValue: (v) => {
                model._value = v;
              },
              getValue: () => model._value,
              getAlternativeVersionId: () => model._ver,
              dispose: () => {
                models.delete(key);
              },
            };
            models.set(key, model);
            return model;
          },
        },
      };
      global.fetch = (url) => {
        const content = url.includes('keep.js') ? 'keep' : 'file-body';
        return Promise.resolve(
          new Response(JSON.stringify({ content, writable: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };

      try {
        const { createEditorTabManager } = await import('../public/js/editor-tabs.js');
        const editorState = {
          activeFilePath: null,
          openTabs: [],
          readOnlyFiles: {},
          originalVersions: {},
        };
        const editorManager = {
          instance: {
            updateOptions: () => {},
            setModel: (m) => {
              activeModel = m;
            },
          },
          getOrCreateModel: (filePath, content) => {
            const uri = global.monaco.Uri.file(filePath);
            return (
              global.monaco.editor.getModel(uri) ||
              global.monaco.editor.createModel(content, 'javascript', uri)
            );
          },
          markClean: (p) => {
            const m = global.monaco.editor.getModel(global.monaco.Uri.file(p));
            if (m) editorState.originalVersions[p] = m.getAlternativeVersionId();
          },
          disposeUnusedModels: () => {},
          isDirty: (filePath) => {
            const m = global.monaco.editor.getModel(global.monaco.Uri.file(filePath));
            if (!m) return false;
            const originalVersion = editorState.originalVersions[filePath];
            return originalVersion !== undefined && m.getAlternativeVersionId() !== originalVersion;
          },
        };
        const dom = {
          editorTabsBar: makeEl('div'),
          currentFileName: makeEl('span'),
          saveFileBtn: makeEl('button'),
        };

        const tabs = createEditorTabManager(editorState, editorManager, dom);
        await tabs.openFile('/ws/dir/a.js');
        await tabs.openFile('/ws/dir/b.js');
        await tabs.openFile('/ws/keep.js');

        // Mark /ws/dir/b.js dirty before parent directory rename
        const dirtyOldModel = global.monaco.editor.getModel(global.monaco.Uri.file('/ws/dir/b.js'));
        dirtyOldModel.setValue('edited-body');
        dirtyOldModel._ver = 2;
        expect(editorManager.isDirty('/ws/dir/b.js')).toBe(true);

        // Rename parent folder updates both nested tabs, preserves active tab and dirty state
        await tabs.switchToTab('/ws/dir/a.js');
        tabs.handlePathRenamed('/ws/dir', '/ws/renamed');
        expect(editorState.openTabs).toEqual(['/ws/renamed/a.js', '/ws/renamed/b.js', '/ws/keep.js']);
        expect(editorState.activeFilePath).toBe('/ws/renamed/a.js');
        expect(activeModel?.uriKey).toBe('file:///ws/renamed/a.js');
        expect(global.monaco.editor.getModel(global.monaco.Uri.file('/ws/dir/a.js'))).toBeNull();
        expect(editorManager.isDirty('/ws/renamed/a.js')).toBe(false);
        expect(editorManager.isDirty('/ws/renamed/b.js')).toBe(true);
        expect(editorState.originalVersions['/ws/dir/b.js']).toBeUndefined();
        expect(global.monaco.editor.getModel(global.monaco.Uri.file('/ws/renamed/b.js'))?.getValue()).toBe(
          'edited-body',
        );

        // Deleting renamed folder closes all tabs underneath it and switches cleanly to /ws/keep.js
        tabs.handlePathDeleted('/ws/renamed');
        await new Promise((r) => setTimeout(r, 20));
        expect(editorState.openTabs).toEqual(['/ws/keep.js']);
        expect(editorState.activeFilePath).toBe('/ws/keep.js');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.monaco = prevMonaco;
      }
    });

    test('model-picker prefers editor-tagged image model when switching providers in Image Editor mode', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;
      const prevStorage = global.localStorage;

      const { makeEl, documentMock } = createRichMockDom();
      const imageModel = makeEl('input', 'imageModel');
      imageModel.value = 'gpt-image-2';
      makeEl('span', 'imageModelLabel');
      const editorImageUrl = makeEl('input', 'editorImageUrl');
      editorImageUrl.value = 'https://example.com/input.png';

      let activeProvider = '1forall';
      global.document = documentMock;
      global.window = {
        dispatchEvent: () => {},
        addEventListener: () => {},
      };
      global.localStorage = { getItem: () => activeProvider, setItem: () => {}, removeItem: () => {} };
      global.fetch = (url) => {
        if (url === '/api/models') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                providers: {
                  '1forall': {
                    imageModels: [
                      {
                        id: 'black-forest-labs/flux-schnell',
                        label: 'FLUX Schnell',
                        provider: '1forall',
                        tags: ['image', 'fast'],
                      },
                      {
                        id: 'stable-diffusion-image',
                        label: 'SD Image Editor',
                        provider: '1forall',
                        tags: ['image', 'editor'],
                      },
                    ],
                  },
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      };

      try {
        const { loadModels } = await import('../public/js/model-picker.js');
        await loadModels();
        expect(imageModel.value).toBe('stable-diffusion-image');
      } finally {
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
        global.localStorage = prevStorage;
      }
    });

    test('explorer invokes onRenamePath and onDeletePath callbacks after successful rename and delete', async () => {
      const prevDoc = global.document;
      const prevWin = global.window;
      const prevFetch = global.fetch;

      const { makeEl, documentMock } = createRichMockDom();
      const fileTree = makeEl('div', 'fileTree');
      const explorerPath = makeEl('input', 'explorerPath');

      global.document = documentMock;
      global.window = { innerWidth: 1200, innerHeight: 800, dispatchEvent: () => {} };
      let currentName = 'old.js';
      global.fetch = (url) => {
        if (url.startsWith('/api/fs/list')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                dir: '/ws',
                items: [{ name: currentName, isDirectory: false, path: `/ws/${currentName}` }],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        if (url === '/api/fs/rename') {
          currentName = 'renamed.js';
        }
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      };

      const { toast } = await import('../public/js/toast.js');
      const promptSpy = jest.spyOn(toast, 'prompt').mockResolvedValueOnce('renamed.js');
      const confirmSpy = jest.spyOn(toast, 'confirm').mockResolvedValueOnce(true);
      const successSpy = jest.spyOn(toast, 'success').mockImplementation(() => {});
      const errorSpy = jest.spyOn(toast, 'error').mockImplementation(() => {});

      try {
        const { createExplorerManager } = await import('../public/js/explorer.js');
        const renamed = [];
        const deleted = [];
        const explorer = createExplorerManager({ fileTree, explorerPath }, () => {}, {
          onRenamePath: (oldPath, newPath) => renamed.push({ oldPath, newPath }),
          onDeletePath: (targetPath) => deleted.push(targetPath),
        });
        await explorer.loadWorkspace();

        const firstNode = fileTree.querySelectorAll('.tree-node')[0];
        await firstNode.onkeydown({ key: 'F2', preventDefault: () => {} });
        const reloadedNode = fileTree.querySelectorAll('.tree-node')[0];
        await reloadedNode.onkeydown({ key: 'Delete', preventDefault: () => {} });

        expect(errorSpy).not.toHaveBeenCalled();
        expect(renamed).toEqual([{ oldPath: '/ws/old.js', newPath: '/ws/renamed.js' }]);
        expect(deleted).toEqual(['/ws/renamed.js']);
      } finally {
        promptSpy.mockRestore();
        confirmSpy.mockRestore();
        successSpy.mockRestore();
        errorSpy.mockRestore();
        global.document = prevDoc;
        global.window = prevWin;
        global.fetch = prevFetch;
      }
    });
  });
});
