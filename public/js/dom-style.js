/**
 * CSP-safe dynamic style injection
 *
 * The server's `style-src` directive intentionally does NOT include a
 * nonce (mixing a nonce with 'unsafe-inline' would make the nonce win
 * and silently disable 'unsafe-inline', breaking Monaco). Our own
 * dynamic styles are still funnelled through a single <style> element
 * on document.head — the optional nonce attribute is harmless when no
 * nonce is required by the policy, and keeps this helper resilient if
 * style-src is later tightened again.
 *
 * Usage:
 *   injectStyle("#modelPickerDropdown { top: 100px; }");
 *   injectStyle(".cmp-abc .image-before { clip-path: polygon(...); }");
 *
 * Rules are keyed by a stable id (the first selector in the rule) and
 * replaced on subsequent calls so we don't leak duplicate rules.
 */

const STYLE_ELEMENT_ID = 'csp-dynamic-styles';
const ruleIndex = new Map(); // selector -> raw rule
let styleEl = null;

function ensureStyleElement() {
  if (styleEl && document.head.contains(styleEl)) return styleEl;
  const nonce = document.querySelector('meta[name="csp-nonce"]')?.content || undefined;
  styleEl = document.getElementById(STYLE_ELEMENT_ID);
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    if (nonce) styleEl.setAttribute('nonce', nonce);
    document.head.appendChild(styleEl);
  } else if (nonce && !styleEl.getAttribute('nonce')) {
    styleEl.setAttribute('nonce', nonce);
  }
  return styleEl;
}

function ruleKey(css) {
  // Use the first selector-like token (text before "{") as the dedup key.
  const idx = css.indexOf('{');
  if (idx === -1) return css;
  return css.slice(0, idx).trim();
}

function serialize() {
  let out = '';
  for (const rule of ruleIndex.values()) {
    out += rule + '\n';
  }
  return out;
}

export function injectStyle(css) {
  if (typeof css !== 'string' || !css.trim()) return;
  const key = ruleKey(css);
  if (!key) return;
  ruleIndex.set(key, css);
  const el = ensureStyleElement();
  el.textContent = serialize();
}

export function clearInjectedStyles() {
  ruleIndex.clear();
  if (styleEl && document.head.contains(styleEl)) {
    styleEl.textContent = '';
  }
}
