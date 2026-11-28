/**
 * Regression tests for re-opening a file that is already open in the editor.
 *
 * Root cause covered here: openFile() only short-circuited to the existing tab
 * when that tab was dirty. For a clean open tab it re-fetched the file and
 * called model.setValue(), which silently reset the undo stack and the cursor
 * position of the tab the user had just clicked.
 */
import { jest } from '@jest/globals';

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

function createFakeElement() {
  const classes = new Set();
  const element = {
    className: '',
    textContent: '',
    title: '',
    value: '',
    disabled: false,
    type: '',
    dataset: {},
    children: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    appendChild(child) {
      element.children.push(child);
      return child;
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
  };
  return element;
}

let apiMock;
let createEditorTabManager;
let monacoModel;
const previousDocument = global.document;
const previousMonaco = global.monaco;

beforeAll(async () => {
  global.document = {
    createElement: () => createFakeElement(),
    querySelectorAll: () => [],
  };
  monacoModel = {
    uri: { toString: () => 'file:///repo/a.js' },
    getAlternativeVersionId: () => 1,
  };
  global.monaco = {
    Uri: { file: (value) => ({ path: value, toString: () => `file://${value}` }) },
    editor: { getModel: () => monacoModel },
  };

  ({ createEditorTabManager } = await import('../public/js/editor-tabs.js'));
  ({ api: apiMock } = await import('../public/js/api.js'));
});

afterAll(() => {
  if (previousDocument === undefined) delete global.document;
  else global.document = previousDocument;
  if (previousMonaco === undefined) delete global.monaco;
  else global.monaco = previousMonaco;
});

function createManager(overrides = {}) {
  const editorState = {
    activeFilePath: '/repo/b.js',
    openTabs: ['/repo/a.js', '/repo/b.js'],
    readOnlyFiles: {},
    originalVersions: {},
    ...overrides.editorState,
  };
  const instance = {
    setModel: jest.fn(),
    updateOptions: jest.fn(),
    getValue: () => '',
    ...overrides.instance,
  };
  const editorManager = {
    instance,
    isDirty: () => false,
    markClean: jest.fn(),
    getOrCreateModel: jest.fn(() => monacoModel),
    disposeUnusedModels: jest.fn(),
    ...overrides.editorManager,
  };
  const dom = {
    currentFileName: createFakeElement(),
    saveFileBtn: createFakeElement(),
    editorTabsBar: createFakeElement(),
  };
  const manager = createEditorTabManager(editorState, editorManager, dom, {});
  return { manager, editorState, instance, editorManager, dom };
}

describe('openFile on an already open tab', () => {
  beforeEach(() => {
    apiMock.mockReset();
  });

  test('switches to the existing model without re-reading the file', async () => {
    const { manager, editorState, instance, editorManager } = createManager();

    await manager.openFile('/repo/a.js');

    expect(apiMock).not.toHaveBeenCalled();
    expect(editorManager.getOrCreateModel).not.toHaveBeenCalled();
    expect(instance.setModel).toHaveBeenCalledWith(monacoModel);
    expect(editorState.activeFilePath).toBe('/repo/a.js');
    expect(editorManager.markClean).not.toHaveBeenCalled();
  });

  test('keeps a dirty open tab untouched as well', async () => {
    const { manager, editorState, instance } = createManager({
      editorManager: { isDirty: () => true },
    });

    await manager.openFile('/repo/a.js');

    expect(apiMock).not.toHaveBeenCalled();
    expect(instance.setModel).toHaveBeenCalledWith(monacoModel);
    expect(editorState.activeFilePath).toBe('/repo/a.js');
  });

  test('still reads a file that is not open yet', async () => {
    apiMock.mockResolvedValue({ path: '/repo/c.js', content: 'const c = 1;\n', writable: true });
    const { manager, editorState } = createManager();

    await manager.openFile('/repo/c.js');

    expect(apiMock).toHaveBeenCalledWith('/api/fs/read?path=%2Frepo%2Fc.js');
    expect(editorState.openTabs).toContain('/repo/c.js');
    expect(editorState.activeFilePath).toBe('/repo/c.js');
  });
});
