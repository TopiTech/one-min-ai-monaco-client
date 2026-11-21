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
});
