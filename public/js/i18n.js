/**
 * Lightweight i18n module for 1min.ai Monaco Client
 *
 * Usage:
 *   import { t, initI18n, setLanguage, getLanguage } from './i18n.js';
 *   await initI18n();          // loads saved language (default: 'ja')
 *   t('key')                   // returns translated string
 *   t('key', { count: 5 })    // interpolates {count} placeholders
 */

const I18N_STORAGE_KEY = 'monaco_client_lang';
const SUPPORTED_LANGS = ['ja', 'en'];
const DEFAULT_LANG = 'ja';

let _currentLang = DEFAULT_LANG;
let _translations = {};
/** @type {Promise<void>|null} */
let _loadingPromise = null;

/**
 * Get nested value from object by dot-separated key.
 * e.g. deepGet({ a: { b: 'val' } }, 'a.b') => 'val'
 */
function deepGet(obj, keyPath) {
  return keyPath.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

/**
 * Load translation JSON for the given language.
 */
async function loadTranslations(lang) {
  try {
    const resp = await fetch(`./i18n/${lang}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    _translations = await resp.json();
  } catch (err) {
    console.error(`[i18n] Failed to load translations for "${lang}":`, err);
    // If English fails, fall back to embedded empty (keys will be returned as-is)
    if (lang !== DEFAULT_LANG) {
      try {
        const resp = await fetch(`./i18n/${DEFAULT_LANG}.json`);
        _translations = await resp.json();
        _currentLang = DEFAULT_LANG;
      } catch (_) {
        _translations = {};
      }
    }
  }
}

/**
 * Apply translations to all elements with `data-i18n` attribute.
 * Supports:
 *   data-i18n="key"           → sets textContent
 *   data-i18n-html="key"      → sets innerHTML (for rich content)
 *   data-i18n-placeholder="key" → sets placeholder
 *   data-i18n-title="key"     → sets title
 *   data-i18n-aria="key"      → sets aria-label
 */
function applyTranslations() {
  // Standard text content
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val !== key) el.textContent = val;
  });

  // Inner HTML (for elements with code tags, etc.)
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    const val = t(key);
    if (val !== key) el.innerHTML = val;
  });

  // Placeholder
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val !== key) el.placeholder = val;
  });

  // Title
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const val = t(key);
    if (val !== key) el.title = val;
  });

  // aria-label
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const key = el.getAttribute('data-i18n-aria');
    const val = t(key);
    if (val !== key) el.setAttribute('aria-label', val);
  });

  // Update html lang attribute
  document.documentElement.lang = _currentLang;
}

/**
 * Translate a key. If translation is missing, returns the key itself.
 * Supports simple {placeholder} interpolation.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 */
export function t(key, params) {
  let val = deepGet(_translations, key);
  if (val === undefined) val = key;
  if (params && typeof val === 'string') {
    for (const [k, v] of Object.entries(params)) {
      val = val.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    }
  }
  return val;
}

/**
 * Initialize i18n system. Loads saved language and applies translations.
 * Call this once at application startup.
 */
export async function initI18n() {
  const saved = localStorage.getItem(I18N_STORAGE_KEY);
  _currentLang = SUPPORTED_LANGS.includes(saved) ? saved : DEFAULT_LANG;

  _loadingPromise = loadTranslations(_currentLang);
  await _loadingPromise;

  // Apply once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTranslations, { once: true });
  } else {
    applyTranslations();
  }
}

/**
 * Switch language at runtime.
 * @param {string} lang - Language code ('ja' or 'en')
 */
export async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) {
    console.warn(`[i18n] Unsupported language: "${lang}"`);
    return;
  }
  _currentLang = lang;
  localStorage.setItem(I18N_STORAGE_KEY, lang);
  await loadTranslations(lang);
  applyTranslations();

  // Dispatch custom event so other modules can react
  window.dispatchEvent(new CustomEvent('language-changed', { detail: { lang } }));
}

/**
 * Get the current language code.
 * @returns {string}
 */
export function getLanguage() {
  return _currentLang;
}

/**
 * Get list of supported languages.
 * @returns {string[]}
 */
export function getSupportedLanguages() {
  return [...SUPPORTED_LANGS];
}
