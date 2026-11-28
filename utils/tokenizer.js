import { getEncoding } from 'js-tiktoken';

let tokenizerCache = null;

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
  return getTokenizer().encode(String(text || '')).length;
}

/**
 * Tokenize multiple text strings and return an array of token counts.
 *
 * @param {string[]} texts
 * @returns {number[]}
 */
export function countTokensMultiple(texts) {
  const tokenizer = getTokenizer();
  return (Array.isArray(texts) ? texts : [texts]).map((t) => tokenizer.encode(String(t || '')).length);
}
