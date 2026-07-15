/**
 * CSP-safe dynamic style injection
 *
 * The server's `style-src` directive includes 'unsafe-inline' for
 * Monaco's CSSOM operations (insertRule). Our own dynamic styles are
 * funnelled through a single <style> element with the per-request nonce
 * attribute for defense-in-depth, keeping this helper resilient if
 * style-src is later tightened.
 *
 * Usage:
 *   injectStyle("#modelPickerDropdown { top: 100px; }");
 *   injectStyle(".cmp-abc .image-before { clip-path: polygon(...); }");
 *
 * Rules are keyed by a stable id (the first selector in the rule) and
 * replaced on subsequent calls so we don't leak duplicate rules.
 *
 * Rate limiting: Max MAX_INJECTS_PER_SECOND calls per second to mitigate
 * CSS-based exfiltration via rapid dynamic style generation.
 */

const STYLE_ELEMENT_ID = 'csp-dynamic-styles';
const MAX_INJECTS_PER_SECOND = 5;
const MAX_STYLE_CONTENT_LENGTH = 16_384; // 16KB safety limit

const ruleIndex = new Map(); // selector -> raw rule
let styleEl = null;

// --- Rate limiter state ---
let injectTimestamps = [];

function canInject() {
  const now = performance.now();
  const oneSecondAgo = now - 1000;
  // Remove timestamps older than 1 second
  while (injectTimestamps.length > 0 && injectTimestamps[0] < oneSecondAgo) {
    injectTimestamps.shift();
  }
  return injectTimestamps.length < MAX_INJECTS_PER_SECOND;
}

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

  // SEC: Rate limit to prevent CSS-based exfiltration via rapid injection
  if (!canInject()) return;

  // SEC: Cap total CSS content length to prevent memory abuse
  if (css.length > MAX_STYLE_CONTENT_LENGTH) return;

  const key = ruleKey(css);
  if (!key) return;

  injectTimestamps.push(performance.now());
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

/**
 * Inject a style that MUST be applied immediately (e.g. a drag/animation
 * callback that fires faster than MAX_INJECTS_PER_SECOND). Unlike
 * `injectStyle`, this bypasses the per-second rate limiter so continuous
 * updates (image comparison slider position, resize handles, etc.) are
 * never dropped mid-interaction.
 *
 * Safety invariants preserved:
 * - Still capped by MAX_STYLE_CONTENT_LENGTH (no memory abuse).
 * - Still keyed by selector so repeated updates for the same target replace
 *   rather than accumulate.
 * - Uses the same CSP-nonced <style> element as injectStyle().
 *
 * @param {string} css - The CSS rule to inject.
 */
export function setCriticalStyle(css) {
  if (typeof css !== 'string' || !css.trim()) return;
  if (css.length > MAX_STYLE_CONTENT_LENGTH) return;

  const key = ruleKey(css);
  if (!key) return;

  ruleIndex.set(key, css);
  const el = ensureStyleElement();
  el.textContent = serialize();
}

/**
 * Inject a static block of CSS exactly once, bypassing the per-second
 * rate limit that protects `injectStyle`. Use this for module-load-time
 * styles (e.g. toast notifications) that need to be present on every
 * page render and are not subject to user-triggered rate amplification.
 *
 * The block is keyed by `id` so subsequent calls with the same id are
 * a no-op. The id should be unique to your component.
 *
 * @param {string} id - Stable identifier (e.g. "toast-styles").
 * @param {string} css - The full CSS text to inject.
 */
export function injectStaticStyles(id, css) {
  if (typeof id !== 'string' || !id || typeof css !== 'string' || !css.trim()) return;
  if (css.length > MAX_STYLE_CONTENT_LENGTH) return;

  const el = ensureStyleElement();
  if (el.__staticIds && el.__staticIds.has(id)) return;

  // Append the static block after dynamic rules so rule order is preserved.
  el.textContent = (el.textContent || '') + '\n' + css;
  if (!el.__staticIds) el.__staticIds = new Set();
  el.__staticIds.add(id);
}
