/**
 * Regression tests for the frontend/backend-boundary fixes found during the
 * full-project review.
 *
 * Covered root causes:
 * - dom-style.js re-serialized the shared <style> element from dynamic rules
 *   only, silently erasing module-level static blocks (toast CSS).
 * - image.js compared absolute DOM .src/.href values against relative
 *   assetUrl() values, so cards were recreated on every render and stale
 *   comparison-slider CSS rules leaked.
 * - image.js acted on a completed polling response after the user cancelled.
 * - editor-diff.js referenced `monaco` unguarded on Android (Monaco omitted)
 *   from the theme toggle path.
 * - agent-core.js treated a non-OK raw command response as a command result.
 */
import fs from 'fs/promises';
import { jest } from '@jest/globals';

function makeElement(tag = 'div', id = '') {
  const attrs = new Map();
  const children = [];
  const listeners = new Map();
  let text = '';

  const matches = (node, selector) => {
    if (selector === 'img:not(.image-before)') {
      return node.tagName === 'IMG' && !node.classList.contains('image-before');
    }
    if (selector.startsWith('.')) {
      return selector
        .slice(1)
        .split('.')
        .every((cls) => node.classList.contains(cls));
    }
    if (selector.includes('.')) {
      const [tagName, ...classes] = selector.split('.');
      return node.tagName === tagName.toUpperCase() && classes.every((cls) => node.classList.contains(cls));
    }
    return node.tagName === selector.toUpperCase();
  };

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
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = String(value ?? '');
      children.length = 0;
    },
    classList: {
      add: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.add(name));
        el.className = [...set].join(' ');
      },
      remove: (...names) => {
        const set = new Set(el.className.split(/\s+/).filter(Boolean));
        names.forEach((name) => set.delete(name));
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
      [Symbol.iterator]: function* iterate() {
        yield* el.className.split(/\s+/).filter(Boolean);
      },
    },
    setAttribute: (key, value) => attrs.set(key, String(value)),
    getAttribute: (key) => (attrs.has(key) ? attrs.get(key) : null),
    removeAttribute: (key) => attrs.delete(key),
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
    prepend: (child) => {
      child.parentElement = el;
      children.unshift(child);
      return child;
    },
    removeChild: (child) => {
      const index = children.indexOf(child);
      if (index !== -1) {
        children.splice(index, 1);
        child.parentElement = null;
      }
    },
    remove: () => {
      el.parentElement?.removeChild(el);
    },
    contains: (other) => {
      if (other === el) return true;
      return children.some((child) => child.contains?.(other));
    },
    querySelector: (selector) => el.querySelectorAll(selector)[0] || null,
    querySelectorAll: (selector) => {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (matches(child, selector)) out.push(child);
          walk(child);
        }
      };
      walk(el);
      return out;
    },
    getBoundingClientRect: () => ({ width: 100, height: 100, top: 0, left: 0 }),
    focus: () => {},
    click: () => {
      if (typeof el.onclick === 'function') {
        el.onclick({ target: el, preventDefault: () => {}, stopPropagation: () => {} });
      }
    },
  };

  if (tag === 'img') {
    Object.defineProperty(el, 'src', {
      configurable: true,
      get: () => {
        const attr = el.getAttribute('src');
        return attr ? `http://localhost${attr}` : '';
      },
      set: (value) => {
        el.setAttribute('src', value);
      },
    });
  }
  if (tag === 'a') {
    Object.defineProperty(el, 'href', {
      configurable: true,
      get: () => {
        const attr = el.getAttribute('href');
        return attr ? `http://localhost${attr}` : '';
      },
      set: (value) => {
        el.setAttribute('href', value);
      },
    });
  }

  return el;
}

const createdElements = [];
let styleEl;
let prevDocument;
let prevWindow;
let prevLocalStorage;

function installDom() {
  styleEl = makeElement('style', 'csp-dynamic-styles');
  const head = makeElement('head');
  head.addEventListener = () => {};
  head.appendChild = (child) => {
    child.parentElement = head;
    head.children.push(child);
    return child;
  };
  head.contains = (node) => node === styleEl || node === head;
  const body = makeElement('body');
  const documentMock = {
    cookie: '',
    documentElement: { lang: 'en' },
    head,
    body,
    activeElement: null,
    createElement: (tag) => {
      const el = makeElement(tag);
      createdElements.push(el);
      return el;
    },
    getElementById: (id) => (id === 'csp-dynamic-styles' ? styleEl : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  };
  prevDocument = global.document;
  prevWindow = global.window;
  prevLocalStorage = global.localStorage;
  global.document = documentMock;
  global.window = { dispatchEvent: () => {}, matchMedia: () => ({ matches: false }) };
  global.localStorage = {
    // Only the provider preference is relevant to these tests; every other
    // key falls back to the modules' defaults.
    getItem: (key) => (key === 'monaco_client_active_provider' ? '1forall' : null),
    setItem: () => {},
    removeItem: () => {},
  };
  return documentMock;
}

function restoreDom() {
  global.document = prevDocument;
  global.window = prevWindow;
  global.localStorage = prevLocalStorage;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createImageDom() {
  return {
    imageGallery: makeElement('div', 'imageGallery'),
    editorImageUrl: makeElement('input', 'editorImageUrl'),
    imagePrompt: makeElement('textarea', 'imagePrompt'),
    imageModel: makeElement('input', 'imageModel'),
    imageModelLabel: makeElement('span', 'imageModelLabel'),
    generateImage: makeElement('button', 'generateImageBtn'),
    assetResult: makeElement('pre', 'assetResult'),
  };
}

describe('Frontend review fixes', () => {
  beforeEach(() => {
    installDom();
  });
  afterEach(() => {
    restoreDom();
  });

  test('static style blocks survive dynamic rule injection and clearing', async () => {
    const {
      injectStaticStyles,
      injectStyle,
      setCriticalStyle,
      removeCriticalStylesByPrefix,
      clearInjectedStyles,
    } = await import('../public/js/dom-style.js');

    injectStaticStyles('toast-styles-test', '.static-marker { color: red; }');
    expect(styleEl.textContent).toContain('.static-marker');

    injectStyle('.dynamic-a { color: blue; }');
    setCriticalStyle('.cmp-x .image-before { clip-path: none; }');
    expect(styleEl.textContent).toContain('.static-marker');
    expect(styleEl.textContent).toContain('.dynamic-a');

    removeCriticalStylesByPrefix('.cmp-x ');
    expect(styleEl.textContent).toContain('.static-marker');
    expect(styleEl.textContent).not.toContain('.cmp-x');

    clearInjectedStyles();
    expect(styleEl.textContent).not.toContain('.dynamic-a');
    expect(styleEl.textContent).toContain('.static-marker');
  });

  test('image cards are matched by authored URL, not the resolved absolute URL', async () => {
    const { createImageManager } = await import('../public/js/image.js');
    const dom = createImageDom();
    const gallery = dom.imageGallery;

    const card = makeElement('div');
    card.className = 'imageCard';
    const img = makeElement('img');
    img.setAttribute('src', '/api/assets/proxy?key=abc');
    card.appendChild(img);
    const link = makeElement('a');
    link.setAttribute('href', '/api/assets/proxy?key=abc');
    card.appendChild(link);
    gallery.appendChild(card);

    const manager = createImageManager(dom);
    manager.renderImages({ images: ['abc'] });

    expect(gallery.children).toHaveLength(1);
    expect(gallery.children[0]).toBe(card);
  });

  test('stale comparison-slider CSS is removed when its card is replaced', async () => {
    const { setCriticalStyle } = await import('../public/js/dom-style.js');
    const { createImageManager } = await import('../public/js/image.js');
    const dom = createImageDom();
    const gallery = dom.imageGallery;

    const oldCard = makeElement('div');
    oldCard.className = 'imageCard';
    const comparison = makeElement('div');
    comparison.className = 'image-comparison-slider cmp-old';
    oldCard.appendChild(comparison);
    const oldImg = makeElement('img');
    oldImg.setAttribute('src', '/api/assets/proxy?key=old');
    oldCard.appendChild(oldImg);
    gallery.appendChild(oldCard);

    setCriticalStyle('.cmp-old .image-before { clip-path: polygon(0 0); }');
    expect(styleEl.textContent).toContain('.cmp-old');

    const manager = createImageManager(dom);
    manager.renderImages({ images: ['new'] });

    expect(styleEl.textContent).not.toContain('.cmp-old');
    expect(gallery.querySelectorAll('.imageCard')).toHaveLength(1);
  });

  test('repeated empty responses replace the JSON fallback instead of stacking it', async () => {
    const { createImageManager } = await import('../public/js/image.js');
    const dom = createImageDom();
    const manager = createImageManager(dom);

    manager.renderImages({});
    manager.renderImages({});

    expect(dom.imageGallery.querySelectorAll('pre.json')).toHaveLength(1);
  });

  test('cancelling job polling discards a response that completes afterwards', async () => {
    jest.useFakeTimers();
    const { createImageManager } = await import('../public/js/image.js');
    const dom = createImageDom();
    dom.editorImageUrl.value = 'assets/source.png';
    dom.imagePrompt.value = 'edit it';

    let resolveJob = null;
    const prevFetch = global.fetch;
    const prevDOMParser = global.DOMParser;
    // Toast rendering parses its inline SVG icon through DOMParser.
    global.DOMParser = class {
      parseFromString() {
        return { documentElement: { tagName: 'svg', querySelector: () => null } };
      }
    };
    global.fetch = (url) => {
      if (url.startsWith('/api/images/text-editor')) {
        return Promise.resolve(jsonResponse({ aiRecord: { uuid: 'job-1' }, status: 'PROCESSING' }));
      }
      if (url.startsWith('/api/jobs/')) {
        return new Promise((resolve) => {
          resolveJob = () => resolve(jsonResponse({ status: 'completed', images: ['done-key'] }));
        });
      }
      return Promise.reject(new Error(`unexpected fetch: ${url}`));
    };

    try {
      const manager = createImageManager(dom);
      const generating = manager.generateImage();

      await jest.advanceTimersByTimeAsync(3000);
      expect(resolveJob).not.toBeNull();

      const pollingCard = dom.imageGallery.children.find((child) =>
        child.classList.contains('job-polling-card'),
      );
      expect(pollingCard).toBeTruthy();
      const cancelButton = pollingCard.children.find((child) => child.tagName === 'BUTTON');
      expect(cancelButton).toBeTruthy();
      cancelButton.onclick();

      resolveJob();
      await jest.advanceTimersByTimeAsync(0);
      await generating;

      // The cancelled migration must not render the completed job's image.
      expect(dom.imageGallery.querySelectorAll('.imageCard')).toHaveLength(0);
    } finally {
      global.fetch = prevFetch;
      global.DOMParser = prevDOMParser;
      jest.useRealTimers();
    }
  });

  test('diff dialog theme sync is a no-op when Monaco is not loaded', async () => {
    const prevMonaco = global.monaco;
    delete global.monaco;
    try {
      const { createDiffDialog } = await import('../public/js/editor-diff.js');
      const dialog = createDiffDialog({ t: (key) => key, getThemeName: () => 'vs-dark' });
      expect(() => dialog.syncTheme()).not.toThrow();
      await expect(dialog.showDiffDialog('/a.js', 'old', 'new')).resolves.toBe(false);
    } finally {
      global.monaco = prevMonaco;
    }
  });

  test('createConversation forwards the active provider to the BFF', async () => {
    const source = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf-8');
    expect(source).toMatch(/api\('\/api\/conversations'[\s\S]{0,240}provider: getActiveProvider\(\)/);
  });
});

describe('agent-core raw command error handling', () => {
  const prevDocument = global.document;
  const prevWindow = global.window;
  const prevLocalStorage = global.localStorage;

  beforeAll(() => {
    global.document = {
      cookie: '',
      getElementById: () => null,
      createElement: () => makeElement('div'),
      querySelector: () => null,
      addEventListener: () => {},
      dispatchEvent: () => {},
    };
    global.window = { dispatchEvent: () => {} };
    global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };
  });

  afterAll(() => {
    global.document = prevDocument;
    global.window = prevWindow;
    global.localStorage = prevLocalStorage;
  });

  test('a 403 JSON response is surfaced as an error, not as command output', async () => {
    const { createAgentRuntime } = await import('../public/js/agent-core.js');
    const steps = [];
    const dom = {
      explorerPath: { value: '/workspace' },
      codeModel: { value: 'qwen3-coder-plus' },
      startAgentBtn: makeElement('button'),
      sendAgentFeedbackBtn: makeElement('button'),
      stopAgentBtn: makeElement('button'),
      resetAgentBtn: makeElement('button'),
      agentInstruction: makeElement('textarea'),
      agentStatus: makeElement('span'),
    };
    const state = {
      agent: { active: true, sessionId: null, history: [], abortController: null },
      editor: { activeFilePath: null },
    };

    let chatCalls = 0;
    const runtime = createAgentRuntime({
      dom,
      state,
      api: (url, options = {}) => {
        if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-1' } });
        if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 5 });
        if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
        if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
        if (url === '/api/agent/chat') {
          return Promise.resolve(
            chatCalls === 0
              ? {
                  text: '<call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>',
                }
              : { text: '<finish>done</finish>' },
          );
        }
        if (url.includes('/commands?stream=true')) {
          return Promise.resolve(
            jsonResponse({ error: 'Command execution is disabled on this server.' }, 403),
          );
        }
        if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
        return Promise.reject(new Error(`unexpected api call: ${url} ${options.method || 'GET'}`));
      },
      t: (key, vars) => (typeof vars === 'string' ? vars : key),
      parseXMLTags: () => {
        chatCalls++;
        if (chatCalls === 1) {
          return { toolCall: { name: 'run_command', params: { command: 'npm test' } } };
        }
        return { finish: 'done' };
      },
      setAgentStatus: () => {},
      addAgentTimelineStep: (type, title, body, resultText) => {
        steps.push({ type, title, body, resultText });
      },
      addAgentApprovalStep: () => {
        throw new Error('approval must not be requested for a failed command request');
      },
    });

    await runtime.runAgentLoop('run the tests');

    const resultStep = steps.find((step) => step.title === 'ツール結果: run_command');
    expect(resultStep).toBeDefined();
    expect(resultStep.resultText).toContain('Command execution is disabled on this server.');
    expect(resultStep.resultText).not.toContain('undefined');
    expect(state.agent.active).toBe(false);
  });

  test('aborting during run_command approval unblocks pending promise immediately without hanging', async () => {
    const { createAgentRuntime } = await import('../public/js/agent-core.js');
    const dom = {
      explorerPath: { value: '/workspace' },
      codeModel: { value: 'qwen3-coder-plus' },
      startAgentBtn: makeElement('button'),
      sendAgentFeedbackBtn: makeElement('button'),
      stopAgentBtn: makeElement('button'),
      resetAgentBtn: makeElement('button'),
      agentInstruction: makeElement('textarea'),
      agentStatus: makeElement('span'),
    };
    const state = {
      agent: { active: true, sessionId: null, history: [], abortController: null },
      editor: { activeFilePath: null },
    };

    const runtime = createAgentRuntime({
      dom,
      state,
      api: (url) => {
        if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-abort' } });
        if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 3 });
        if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
        if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
        if (url === '/api/agent/chat') {
          return Promise.resolve({
            text: '<call_tool name="run_command"><parameter name="command">npm test</parameter></call_tool>',
          });
        }
        if (url.includes('/commands?stream=true')) {
          return Promise.resolve(jsonResponse({ requiresApproval: true, approvalToken: 'tok-1' }, 200));
        }
        if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
        return Promise.resolve({});
      },
      t: (key, vars) => (typeof vars === 'string' ? vars : key),
      parseXMLTags: () => ({ toolCall: { name: 'run_command', params: { command: 'npm test' } } }),
      setAgentStatus: () => {},
      addAgentTimelineStep: () => {},
      addAgentApprovalStep: () => {
        // Trigger abort immediately while awaiting approval
        state.agent.active = false;
        state.agent.abortController.abort();
      },
    });

    await expect(runtime.runAgentLoop('run and abort')).resolves.toBeUndefined();
    expect(state.agent.active).toBe(false);
  });

  test('does not retry deterministic 4xx client errors in runAgentLoop and caps oversized tool messages', async () => {
    const { createAgentRuntime } = await import('../public/js/agent-core.js');
    const dom = {
      explorerPath: makeElement('input'),
      agentStatus: makeElement('span'),
      agentActivityLog: makeElement('div'),
      startAgentBtn: makeElement('button'),
      sendAgentFeedbackBtn: makeElement('button'),
      stopAgentBtn: makeElement('button'),
      resetAgentBtn: makeElement('button'),
      agentInstruction: makeElement('textarea'),
    };
    dom.explorerPath.value = '/workspace';

    let chatCalls = 0;
    const state = {
      agent: { active: true, sessionId: null, history: [], abortController: null },
      editor: { activeFilePath: null },
    };

    const failFastRuntime = createAgentRuntime({
      dom,
      state,
      api: (url) => {
        if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-4xx' } });
        if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 3 });
        if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
        if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
        if (url === '/api/agent/chat') {
          chatCalls += 1;
          const err = new Error('Bad request');
          err.status = 400;
          return Promise.reject(err);
        }
        return Promise.resolve({});
      },
      t: (key, vars) => (typeof vars === 'string' ? vars : key),
      parseXMLTags: () => ({}),
      setAgentStatus: () => {},
      addAgentTimelineStep: () => {},
      addAgentApprovalStep: () => {},
    });

    await failFastRuntime.runAgentLoop('fail fast on 400');
    expect(chatCalls).toBe(1);

    // Oversized tool output + newest message preservation in trimHistory
    let secondTurnMessages = null;
    const bigText = 'X'.repeat(60000);
    let turn = 0;
    const trimRuntime = createAgentRuntime({
      dom,
      state: {
        agent: { active: true, sessionId: null, history: [], abortController: null },
        editor: { activeFilePath: null },
      },
      api: (url, opts) => {
        if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-big' } });
        if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 4, maxContextTokens: 100 });
        if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
        if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
        if (url.includes('/files?path=')) return Promise.resolve({ content: bigText });
        if (url === '/api/agent/tokenize') {
          const texts = JSON.parse(opts.body).texts;
          return Promise.resolve({ counts: texts.map(() => 200) });
        }
        if (url === '/api/agent/chat') {
          turn += 1;
          const payload = JSON.parse(opts.body);
          if (turn === 1) {
            return Promise.resolve({
              text: '<call_tool name="read_file"><parameter name="path">big.txt</parameter></call_tool>',
            });
          }
          secondTurnMessages = payload.messages;
          return Promise.resolve({ text: '<finish>done</finish>' });
        }
        return Promise.resolve({});
      },
      t: (key, vars) => (typeof vars === 'string' ? vars : key),
      parseXMLTags: (txt) => {
        if (txt.includes('read_file'))
          return { toolCall: { name: 'read_file', params: { path: 'big.txt' } } };
        if (txt.includes('<finish>')) return { finish: 'done' };
        return {};
      },
      setAgentStatus: () => {},
      addAgentTimelineStep: () => {},
      addAgentApprovalStep: () => {},
    });

    await trimRuntime.runAgentLoop('read huge file');
    const latestToolFeedback = secondTurnMessages[secondTurnMessages.length - 1];
    expect(latestToolFeedback.content).toContain('<tool_response>');
    expect(latestToolFeedback.content.length).toBeLessThanOrEqual(48000);
  });

  test('run_command executes auto-approved SSE stream and aborts cleanly mid-stream', async () => {
    const { createAgentRuntime } = await import('../public/js/agent-core.js');
    const dom = {
      explorerPath: makeElement('input'),
      agentStatus: makeElement('span'),
      agentActivityLog: makeElement('div'),
      startAgentBtn: makeElement('button'),
      sendAgentFeedbackBtn: makeElement('button'),
      stopAgentBtn: makeElement('button'),
      resetAgentBtn: makeElement('button'),
      agentInstruction: makeElement('textarea'),
    };
    dom.explorerPath.value = '/workspace';

    const encoder = new TextEncoder();
    let chatTurn = 0;
    let secondTurnMessages = null;
    const state = {
      agent: { active: true, sessionId: null, history: [], abortController: null },
      editor: { activeFilePath: null },
    };

    const sseRuntime = createAgentRuntime({
      dom,
      state,
      api: (url, opts) => {
        if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-sse-cmd' } });
        if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 3 });
        if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
        if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
        if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
        if (url.includes('/commands?stream=true')) {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(encoder.encode('event: stdout\ndata: {"text":"hi"}\n\n'));
                  controller.enqueue(
                    encoder.encode('event: done\ndata: {"exitCode":0,"stdout":"hi","stderr":""}\n\n'),
                  );
                  controller.close();
                },
              }),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            ),
          );
        }
        if (url === '/api/agent/chat') {
          chatTurn += 1;
          const payload = JSON.parse(opts.body);
          if (chatTurn === 1) {
            return Promise.resolve({
              text: '<call_tool name="run_command"><parameter name="command">node --version</parameter></call_tool>',
            });
          }
          secondTurnMessages = payload.messages;
          return Promise.resolve({ text: '<finish>done</finish>' });
        }
        return Promise.resolve({});
      },
      t: (key, vars) => (typeof vars === 'string' ? vars : key),
      parseXMLTags: (txt) => {
        if (txt.includes('run_command'))
          return { toolCall: { name: 'run_command', params: { command: 'node --version' } } };
        if (txt.includes('<finish>')) return { finish: 'done' };
        return {};
      },
      setAgentStatus: () => {},
      addAgentTimelineStep: () => 'step-1',
      addAgentApprovalStep: () => {},
    });

    await sseRuntime.runAgentLoop('run auto-approved sse command');
    expect(secondTurnMessages.at(-1).content).toContain('Exit Code: 0');
  });

  test('invalidates workspace file list cache after write_file executes', async () => {
    const prevDoc = global.document;
    const prevAddListener = global.document?.addEventListener;
    global.document = {
      dispatchEvent: (evt) => {
        if (evt.type === 'editor:show-diff') {
          evt.detail.resolve(true);
        }
      },
      querySelectorAll: () => [],
      addEventListener: prevAddListener || (() => {}),
    };

    try {
      const { createAgentRuntime } = await import('../public/js/agent-core.js');
      const dom = {
        explorerPath: makeElement('input'),
        agentStatus: makeElement('span'),
        agentActivityLog: makeElement('div'),
        startAgentBtn: makeElement('button'),
        sendAgentFeedbackBtn: makeElement('button'),
        stopAgentBtn: makeElement('button'),
        resetAgentBtn: makeElement('button'),
        agentInstruction: makeElement('textarea'),
      };
      dom.explorerPath.value = '/workspace-cache-test';

      let listCalls = 0;
      let runTurn = 0;
      const runtime = createAgentRuntime({
        dom,
        state: {
          agent: { active: true, sessionId: null, history: [], abortController: null },
          editor: { activeFilePath: null },
        },
        api: (url) => {
          if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-cache' } });
          if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 3 });
          if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
          if (url.startsWith('/api/fs/list')) {
            listCalls += 1;
            return Promise.resolve({ dir: '/workspace-cache-test', items: [] });
          }
          if (url.includes('/files?path=')) {
            return Promise.resolve(new Response('', { status: 404 }));
          }
          if (url.endsWith('/files')) return Promise.resolve({ ok: true });
          if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
          if (url === '/api/agent/chat') {
            runTurn += 1;
            if (runTurn === 1) {
              return Promise.resolve({
                text: '<call_tool name="write_file"><parameter name="path">new.js</parameter><parameter name="content">1</parameter></call_tool>',
              });
            }
            return Promise.resolve({ text: '<finish>done</finish>' });
          }
          return Promise.resolve({});
        },
        t: (key, vars) => (typeof vars === 'string' ? vars : key),
        parseXMLTags: (txt) => {
          if (txt.includes('write_file')) {
            return { toolCall: { name: 'write_file', params: { path: 'new.js', content: '1' } } };
          }
          if (txt.includes('<finish>')) return { finish: 'done' };
          return {};
        },
        setAgentStatus: () => {},
        addAgentTimelineStep: () => {},
        addAgentApprovalStep: () => {},
      });

      await runtime.runAgentLoop('create new.js');
      await runtime.runAgentLoop('check fresh listing');
      expect(listCalls).toBe(2);
    } finally {
      global.document = prevDoc;
    }
  });

  test('agent-core forwards webSearch, numOfSite, and maxWord when enabled and omits search prohibition lines', async () => {
    const prevStorage = global.localStorage;
    global.localStorage = { getItem: () => '1min', setItem: () => {}, removeItem: () => {} };

    try {
      const { createAgentRuntime } = await import('../public/js/agent-core.js');
      const dom = {
        explorerPath: { value: '/workspace' },
        codeModel: { value: 'qwen3-coder-plus' },
        codeWebSearch: { checked: true, disabled: false },
        codeNumOfSite: { value: '4' },
        codeMaxWord: { value: '1500' },
        startAgentBtn: makeElement('button'),
        sendAgentFeedbackBtn: makeElement('button'),
        stopAgentBtn: makeElement('button'),
        resetAgentBtn: makeElement('button'),
        agentInstruction: makeElement('textarea'),
        agentStatus: makeElement('span'),
      };
      const sentPayloads = [];
      const agentState = {
        agent: { active: true, sessionId: null, history: [], abortController: null },
        editor: { activeFilePath: null },
      };
      const runtime = createAgentRuntime({
        dom,
        state: agentState,
        api: (url, opts = {}) => {
          if (url === '/api/agent/sessions') return Promise.resolve({ session: { id: 'sess-ws' } });
          if (url === '/api/agent/config') return Promise.resolve({ maxLoops: 2 });
          if (url.endsWith('/project-info')) return Promise.resolve({ project: null });
          if (url.startsWith('/api/fs/list')) return Promise.resolve({ dir: '/workspace', items: [] });
          if (url === '/api/agent/tokenize') return Promise.resolve({ counts: [], total: 0 });
          if (url === '/api/agent/chat') {
            sentPayloads.push(JSON.parse(opts.body));
            return Promise.resolve({ text: '<finish>done</finish>' });
          }
          return Promise.resolve({});
        },
        t: (key, vars) => (typeof vars === 'string' ? vars : key),
        parseXMLTags: () => ({ finish: 'done' }),
        setAgentStatus: () => {},
        addAgentTimelineStep: () => {},
        addAgentApprovalStep: () => {},
      });

      await runtime.runAgentLoop('search docs');
      expect(sentPayloads).toHaveLength(1);
      expect(sentPayloads[0].webSearch).toBe(true);
      expect(sentPayloads[0].numOfSite).toBe(4);
      expect(sentPayloads[0].maxWord).toBe(1500);
      expect(sentPayloads[0].messages[0].content).not.toContain('Strictly do NOT perform web searches');

      // Disabled toggle forces webSearch: false
      agentState.agent.active = true;
      dom.codeWebSearch.disabled = true;
      await runtime.runAgentLoop('search disabled');
      expect(sentPayloads[1].webSearch).toBe(false);
      expect(sentPayloads[1].numOfSite).toBeUndefined();
      expect(sentPayloads[1].messages[0].content).toContain('Strictly do NOT perform web searches');
    } finally {
      global.localStorage = prevStorage;
    }
  });

  test('editor-tabs handles Windows drive-letter casing and trailing slashes cleanly on rename and delete', async () => {
    const prevDoc = global.document;
    const prevWin = global.window;
    const prevFetch = global.fetch;
    const prevMonaco = global.monaco;

    const doc = installDom();
    const models = new Map();
    global.monaco = {
      Uri: {
        from: ({ scheme, path: p }) => ({ toString: () => `${scheme}://${p}` }),
        file: (p) => ({ toString: () => `file://${p}` }),
      },
      editor: {
        getModel: (uri) => models.get(uri.toString()) || null,
        createModel: (val, _lang, uri) => {
          const m = {
            _v: val,
            getValue: () => m._v,
            setValue: (v) => {
              m._v = v;
            },
            dispose: () => models.delete(uri.toString()),
          };
          models.set(uri.toString(), m);
          return m;
        },
      },
    };
    global.fetch = () => Promise.resolve(jsonResponse({ content: 'hello', writable: true }));

    try {
      const { createEditorTabManager } = await import('../public/js/editor-tabs.js');
      const editorState = { activeFilePath: null, openTabs: [], readOnlyFiles: {} };
      const editorManager = {
        instance: { updateOptions: () => {}, setModel: () => {} },
        getOrCreateModel: (fp, c) =>
          global.monaco.editor.getModel(global.monaco.Uri.file(fp)) ||
          global.monaco.editor.createModel(c, 'javascript', global.monaco.Uri.file(fp)),
        markClean: () => {},
        disposeUnusedModels: () => {},
        isDirty: () => false,
      };
      const dom = {
        editorTabsBar: doc.createElement('div'),
        currentFileName: doc.createElement('span'),
        saveFileBtn: doc.createElement('button'),
      };
      const tabs = createEditorTabManager(editorState, editorManager, dom);

      await tabs.openFile('C:\\ws\\dir\\a.js');
      tabs.handlePathRenamed('c:\\ws\\dir\\', 'C:\\ws\\renamed\\');
      expect(editorState.openTabs).toEqual(['C:\\ws\\renamed\\a.js']);
      expect(editorState.activeFilePath).toBe('C:\\ws\\renamed\\a.js');

      tabs.handlePathDeleted('c:\\ws\\renamed\\');
      expect(editorState.openTabs).toEqual([]);
    } finally {
      global.document = prevDoc;
      global.window = prevWin;
      global.fetch = prevFetch;
      global.monaco = prevMonaco;
    }
  });

  test('image manager polls on PENDING, QUEUED, and IN_PROGRESS statuses', async () => {
    const prevFetch = global.fetch;
    const prevDOMParser = global.DOMParser;
    global.DOMParser = class {
      parseFromString() {
        return { documentElement: { tagName: 'svg', querySelector: () => null } };
      }
    };
    const { toast } = await import('../public/js/toast.js');
    const infoSpy = jest.spyOn(toast, 'info').mockImplementation(() => {});
    const successSpy = jest.spyOn(toast, 'success').mockImplementation(() => {});
    const { createImageManager } = await import('../public/js/image.js');

    let polled = 0;
    global.fetch = (url) => {
      if (url.startsWith('/api/jobs/')) {
        polled++;
        return Promise.resolve(jsonResponse({ status: 'completed', images: ['done-url'] }));
      }
      return Promise.resolve(jsonResponse({ status: 'IN_PROGRESS', aiRecord: { uuid: 'job-in-prog' } }));
    };

    try {
      const dom = createImageDom();
      dom.imagePrompt.value = 'a cat';
      dom.imageModel.value = 'gpt-image-2';
      // Run pollJobUntilComplete faster by mocking immediate completion
      jest.useFakeTimers();
      const mgr = createImageManager(dom);
      const genPromise = mgr.generateImage();
      await jest.advanceTimersByTimeAsync(3500);
      await genPromise;
      expect(polled).toBe(1);
    } finally {
      jest.useRealTimers();
      infoSpy.mockRestore();
      successSpy.mockRestore();
      global.fetch = prevFetch;
      global.DOMParser = prevDOMParser;
    }
  });

  test('settings clears monaco_client_lang when clearing locally saved data and explorer validates invalid names', async () => {
    const prevDoc = global.document;
    const prevWin = global.window;
    const prevFetch = global.fetch;
    const prevStorage = global.localStorage;
    const prevDOMParser = global.DOMParser;

    const doc = installDom();
    doc.documentElement.classList = { toggle: () => {} };
    const clearBtn = makeElement('button', 'clearLocalDataBtn');
    const removedKeys = [];
    const reloadSpy = jest.fn();

    doc.getElementById = (id) => {
      if (id === 'clearLocalDataBtn') return clearBtn;
      if (id === 'csp-dynamic-styles') return styleEl;
      return null;
    };
    global.window = {
      innerWidth: 1200,
      innerHeight: 800,
      dispatchEvent: () => {},
      location: { reload: reloadSpy },
    };
    global.localStorage = {
      getItem: () => 'ja',
      setItem: () => {},
      removeItem: (k) => removedKeys.push(k),
    };
    global.DOMParser = class {
      parseFromString() {
        return { documentElement: { tagName: 'svg', querySelector: () => null } };
      }
    };
    global.fetch = jest.fn(() => Promise.resolve(jsonResponse({ ok: true, providers: {} })));

    const { toast } = await import('../public/js/toast.js');
    const confirmSpy = jest.spyOn(toast, 'confirm').mockResolvedValueOnce(true);
    const promptSpy = jest.spyOn(toast, 'prompt').mockResolvedValueOnce('bad/name');
    const errorSpy = jest.spyOn(toast, 'error').mockImplementation(() => {});

    try {
      const { bootstrapSettings } = await import('../public/js/settings.js');
      bootstrapSettings();
      clearBtn.dispatchEvent({ type: 'click', preventDefault: () => {}, stopPropagation: () => {} });
      await new Promise((r) => setTimeout(r, 30));

      expect(removedKeys).toContain('monaco_client_lang');
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      // Explorer rejects path separator in rename prompt without hitting /api/fs/rename
      const { createExplorerManager } = await import('../public/js/explorer.js');
      const fileTree = makeElement('div', 'fileTree');
      const explorerPath = makeElement('input', 'explorerPath');
      global.fetch = jest.fn(() =>
        Promise.resolve(
          jsonResponse({
            dir: '/ws',
            items: [{ name: 'ok.js', isDirectory: false, path: '/ws/ok.js' }],
          }),
        ),
      );
      const explorer = createExplorerManager({ fileTree, explorerPath }, () => {});
      await explorer.loadWorkspace();
      global.fetch.mockClear();

      const node = fileTree.querySelectorAll('.tree-node')[0];
      await node.onkeydown({ key: 'F2', preventDefault: () => {} });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
      promptSpy.mockRestore();
      errorSpy.mockRestore();
      global.document = prevDoc;
      global.window = prevWin;
      global.fetch = prevFetch;
      global.localStorage = prevStorage;
      global.DOMParser = prevDOMParser;
    }
  });
});
