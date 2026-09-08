import { countTokens, countTokensMultiple } from '../utils/tokenizer.js';

describe('utils/tokenizer', () => {
  describe('countTokens', () => {
    test('returns 0 for empty, null, or undefined strings', () => {
      expect(countTokens('')).toBe(0);
      expect(countTokens(null)).toBe(0);
      expect(countTokens(undefined)).toBe(0);
    });

    test('counts tokens for ASCII strings correctly', () => {
      const text = 'Hello world!';
      const tokens = countTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(typeof tokens).toBe('number');
    });

    test('counts tokens for multilingual and Japanese text', () => {
      const text = 'こんにちは、世界！テストメッセージです。';
      const tokens = countTokens(text);
      expect(tokens).toBeGreaterThan(0);
    });

    test('counts tokens for code snippets', () => {
      const code = 'function add(a, b) {\n  return a + b;\n}';
      const tokens = countTokens(code);
      expect(tokens).toBeGreaterThan(5);
    });
  });

  describe('countTokensMultiple', () => {
    test('returns empty array when passed empty array', () => {
      expect(countTokensMultiple([])).toEqual([]);
    });

    test('handles non-array inputs gracefully by wrapping in an array', () => {
      const single = countTokensMultiple('Single string test');
      expect(Array.isArray(single)).toBe(true);
      expect(single.length).toBe(1);
      expect(single[0]).toBe(countTokens('Single string test'));
    });

    test('returns correct token counts for multiple text entries', () => {
      const texts = ['Hello', 'World', 'const x = 42;'];
      const counts = countTokensMultiple(texts);
      expect(counts.length).toBe(3);
      expect(counts[0]).toBe(countTokens('Hello'));
      expect(counts[1]).toBe(countTokens('World'));
      expect(counts[2]).toBe(countTokens('const x = 42;'));
    });

    test('handles null or undefined items in array', () => {
      const counts = countTokensMultiple(['Hello', null, undefined, '']);
      expect(counts).toEqual([countTokens('Hello'), 0, 0, 0]);
    });
  });
});
