/**
 * Regression tests for the CSP `style-src` directive.
 *
 * The frontend ships Monaco editor which assigns to element.style.* and
 * dynamically creates CSS rules via CSSOM (insertRule). Those assignments
 * require 'unsafe-inline' in style-src-attr for element.style and
 * 'unsafe-inline' in style-src for CSSOM insertRule operations.
 * Our own dynamic styles go through the nonced <style> block in
 * `public/js/dom-style.js`. Note: mixing a per-request nonce with
 * 'unsafe-inline' in the same directive is forbidden by CSP (the nonce
 * wins, 'unsafe-inline' is ignored for <style> elements), but we keep
 * 'unsafe-inline' for Monaco's CSSOM operations that don't go through
 * <style> elements.
 */
import { jest } from '@jest/globals';
import request from 'supertest';

jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'mocked failure'),
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
  parseResponsePayload: jest.fn(async (response) => {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text };
    }
  }),
}));

const { createApp } = await import('../server.js');

function getStyleSrc(cspHeader) {
  if (!cspHeader) return null;
  for (const part of cspHeader.split(';')) {
    const trimmed = part.trim();
    // Match only the bare `style-src` directive, not `style-src-attr`.
    if (trimmed.startsWith('style-src') && !trimmed.startsWith('style-src-')) {
      return trimmed;
    }
  }
  return null;
}

describe('CSP style-src directive', () => {
  test("GET / sets a style-src WITH 'unsafe-inline' (required by Monaco CSSOM)", async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    const styleSrc = getStyleSrc(csp);
    expect(styleSrc).not.toBeNull();
    // style-src must contain 'unsafe-inline' — Monaco's CSSOM insertRule
    // operations are not covered by nonce or style-src-attr
    expect(styleSrc).toMatch(/'unsafe-inline'/);
  });

  test("GET / sets a style-src-attr with 'unsafe-inline' (required by Monaco)", async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'];
    const styleSrcAttr = csp
      .split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith('style-src-attr'));
    expect(styleSrcAttr).toBeDefined();
    expect(styleSrcAttr).toMatch(/'unsafe-inline'/);
  });

  test('GET / injects a <meta name="csp-nonce"> tag and a per-request nonce in <script> tags', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    const nonceMatch = res.text.match(/<meta name="csp-nonce" content="([^"]+)">/);
    expect(nonceMatch).not.toBeNull();
    const nonce = nonceMatch[1];
    expect(nonce.length).toBeGreaterThan(8);

    // At least one <script> tag should carry the nonce.
    // Build the pattern from an escaped string so the base64 "/" and "+"
    // characters in the nonce don't get interpreted as regex syntax.
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    expect(res.text).toMatch(new RegExp(`<script\\s+nonce="${escapedNonce}"`));
  });

  test('index.html no longer contains any inline style= attribute', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    // Sanity: the rendered HTML must not contain ` style="` or ` style='`
    expect(res.text).not.toMatch(/\sstyle="[^"]*"/);
    expect(res.text).not.toMatch(/\sstyle='[^']*'/);
  });

  // F-3: With DOMPurify and marked now vendored locally, the CSP must
  // no longer reference the jsdelivr CDN.
  test('CSP no longer permits cdn.jsdelivr.net', async () => {
    process.env.NODE_ENV = 'test';
    const app = createApp({ requireLocalAuth: false, enableRateLimit: false });

    const res = await request(app).get('/');
    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();
    expect(csp).not.toMatch(/cdn\.jsdelivr\.net/);
  });
});
