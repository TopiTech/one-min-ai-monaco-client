import { jest } from '@jest/globals';

function createMockElement(attributes = {}) {
  const el = {
    attributes,
    getAttribute: (name) => attributes[name] || null,
    setAttribute: jest.fn((name, value) => { attributes[name] = value; }),
    textContent: '',
    innerHTML: '',
    placeholder: '',
    title: '',
    value: '',
  };
  return el;
}

async function loadI18nModule({
  readyState = 'complete',
  savedLang = null,
  translationsJa = { status_done: '完了', nested: { val: 'ネスト' } },
  translationsEn = { status_done: 'Done', greeting: 'Hello {name}!' },
  fetchFail = false,
  fetchJaFail = false,
  fetchEnFail = false,
} = {}) {
  jest.resetModules();

  let store = {};
  if (savedLang !== null) {
    store['monaco_client_lang'] = savedLang;
  }
  global.localStorage = {
    getItem: jest.fn((key) => store[key] || null),
    setItem: jest.fn((key, value) => { store[key] = value; }),
  };

  const elements = {
    '[data-i18n]': [],
    '[data-i18n-html]': [],
    '[data-i18n-placeholder]': [],
    '[data-i18n-title]': [],
    '[data-i18n-aria]': [],
  };

  const documentElement = { lang: '' };
  const langSelector = createMockElement();

  global.document = {
    readyState,
    documentElement,
    addEventListener: jest.fn(),
    querySelectorAll: jest.fn((selector) => elements[selector] || []),
    getElementById: jest.fn((id) => (id === 'langSelector' ? langSelector : null)),
  };

  global.window = {
    dispatchEvent: jest.fn(),
  };
  global.CustomEvent = class CustomEvent {
    constructor(name, init) {
      this.type = name;
      this.detail = init?.detail;
    }
  };

  global.fetch = jest.fn((url) => {
    if (fetchFail) {
      return Promise.reject(new Error('Fetch error'));
    }
    if (url.includes('ja.json')) {
      if (fetchJaFail) {
        return Promise.resolve({
          ok: false,
          status: 500,
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(translationsJa),
      });
    }
    if (url.includes('en.json')) {
      if (fetchEnFail) {
        return Promise.resolve({
          ok: false,
          status: 500,
        });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(translationsEn),
      });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  const module = await import('../public/js/i18n.js');
  return { ...module, elements, documentElement, langSelector };
}

describe('i18n utility module', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete global.fetch;
    delete global.document;
    delete global.window;
    delete global.localStorage;
    delete global.CustomEvent;
  });

  test('t() returns values, support deep nested dot notation and fallback', async () => {
    const { t, initI18n } = await loadI18nModule();
    await initI18n();

    expect(t('status_done')).toBe('完了');
    expect(t('nested.val')).toBe('ネスト');
    expect(t('missing.key')).toBe('missing.key');
  });

  test('t() interpolates parameters correctly', async () => {
    const { t, initI18n, setLanguage } = await loadI18nModule();
    await initI18n();
    await setLanguage('en');

    expect(t('greeting', { name: 'Bob' })).toBe('Hello Bob!');
    expect(t('greeting')).toBe('Hello {name}!');
  });

  test('initI18n uses ja as default or reads saved lang', async () => {
    const { initI18n, getLanguage } = await loadI18nModule();
    await initI18n();
    expect(getLanguage()).toBe('ja');
    expect(global.fetch).toHaveBeenCalledWith('./i18n/ja.json');

    const { initI18n: initEn, getLanguage: getLangEn } = await loadI18nModule({ savedLang: 'en' });
    await initEn();
    expect(getLangEn()).toBe('en');
    expect(global.fetch).toHaveBeenCalledWith('./i18n/en.json');
  });

  test('initI18n waits for DOMContentLoaded if DOM is loading', async () => {
    const { initI18n } = await loadI18nModule({ readyState: 'loading' });
    await initI18n();

    expect(global.document.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      { once: true }
    );
  });

  test('setLanguage switches language, updates localStorage and dispatches window event', async () => {
    const { initI18n, setLanguage, getLanguage, langSelector } = await loadI18nModule();
    await initI18n();
    
    // Ignore unsupported language
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await setLanguage('fr');
    expect(consoleWarnSpy).toHaveBeenCalledWith('[i18n] Unsupported language: "fr"');
    expect(getLanguage()).toBe('ja');

    // Switch to en
    await setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(global.localStorage.setItem).toHaveBeenCalledWith('monaco_client_lang', 'en');
    expect(global.window.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'language-changed',
        detail: { lang: 'en' },
      })
    );
    expect(langSelector.value).toBe('en');
  });

  test('getSupportedLanguages returns list copy', async () => {
    const { getSupportedLanguages } = await loadI18nModule();
    const list = getSupportedLanguages();
    expect(list).toEqual(['ja', 'en']);
    list.push('fr');
    expect(getSupportedLanguages()).toEqual(['ja', 'en']); // verify copy
  });

  test('applyTranslations maps data-i18n attributes onto elements', async () => {
    const { initI18n, elements, documentElement } = await loadI18nModule();
    
    const elText = createMockElement({ 'data-i18n': 'status_done' });
    const elHtml = createMockElement({ 'data-i18n-html': 'nested.val' });
    const elPlaceholder = createMockElement({ 'data-i18n-placeholder': 'status_done' });
    const elTitle = createMockElement({ 'data-i18n-title': 'status_done' });
    const elAria = createMockElement({ 'data-i18n-aria': 'status_done' });

    elements['[data-i18n]'].push(elText);
    elements['[data-i18n-html]'].push(elHtml);
    elements['[data-i18n-placeholder]'].push(elPlaceholder);
    elements['[data-i18n-title]'].push(elTitle);
    elements['[data-i18n-aria]'].push(elAria);

    await initI18n();

    expect(elText.textContent).toBe('完了');
    expect(elHtml.innerHTML).toBe('ネスト');
    expect(elPlaceholder.placeholder).toBe('完了');
    expect(elTitle.title).toBe('完了');
    expect(elAria.setAttribute).toHaveBeenCalledWith('aria-label', '完了');
    expect(documentElement.lang).toBe('ja');
  });

  test('falls back gracefully on translation load failure', async () => {
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // 1. English fails -> falls back to Japanese (which succeeds)
    const { initI18n: initEnFail, getLanguage: getLangEnFail } = await loadI18nModule({
      savedLang: 'en',
      fetchEnFail: true,
    });
    await initEnFail();
    expect(getLangEnFail()).toBe('ja');

    // 2. Both English and Japanese fail -> default to empty translations
    const { initI18n: initBothFail, getLanguage: getLangBothFail } = await loadI18nModule({
      savedLang: 'en',
      fetchFail: true,
    });
    await initBothFail();
    expect(getLangBothFail()).toBe('en');

    // 3. Default language (ja) fails
    const { initI18n: initJaFail, getLanguage: getLangJaFail } = await loadI18nModule({
      savedLang: 'ja',
      fetchJaFail: true,
    });
    await initJaFail();
    expect(getLangJaFail()).toBe('ja');

    consoleErrorSpy.mockRestore();
  });
});
