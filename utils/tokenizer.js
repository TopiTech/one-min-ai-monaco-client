import { getEncoding } from 'js-tiktoken';

let tokenizerCache = null;

// nodejs-mobile ships a Node.js binary built without ICU, and V8 only supports
// Unicode property escapes (\p{...}) when ICU is available. js-tiktoken builds
// its splitter pattern with those escapes, so detect support up front and use a
// deterministic estimate on runtimes where loading the encoder would throw.
const SUPPORTS_UNICODE_PROPERTY_ESCAPES = (() => {
  try {
    new RegExp('\\p{L}', 'u');
    return true;
  } catch {
    return false;
  }
})();

function estimateTokens(text) {
  const value = String(text || '');
  let ascii = 0;
  let nonAscii = 0;
  for (const char of value) {
    if (char.codePointAt(0) < 0x80) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  // cl100k averages roughly four ASCII characters per token. Non-ASCII text
  // (CJK, emoji) usually costs at least one token per code point; rounding up
  // keeps context budgeting on the conservative side.
  return Math.ceil(ascii / 4) + nonAscii;
}

function getTokenizer() {
  if (!tokenizerCache) {
    tokenizerCache = getEncoding('cl100k_base');
  }
  return tokenizerCache;
}

/**
 * Tokenize a single text string and return the token count.
 *
 * @param {string} text
 * @returns {number}
 */
export function countTokens(text) {
  if (!SUPPORTS_UNICODE_PROPERTY_ESCAPES) {
    return estimateTokens(text);
  }
  return getTokenizer().encode(String(text || '')).length;
}

/**
 * Tokenize multiple text strings and return an array of token counts.
 *
 * @param {string[]} texts
 * @returns {number[]}
 */
export function countTokensMultiple(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (!SUPPORTS_UNICODE_PROPERTY_ESCAPES) {
    return list.map((text) => estimateTokens(text));
  }
  const tokenizer = getTokenizer();
  return list.map((t) => tokenizer.encode(String(t || '')).length);
}
