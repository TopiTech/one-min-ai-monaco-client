/**
 * Regression tests for HEAD review findings (R1–R6).
 *
 * R1: callOneMin must not compute a NaN retry delay when upstream sends an
 *     HTTP-date Retry-After header (delay(NaN) fires immediately, hammering
 *     the rate-limited upstream).
 * R2: /api/chat/stream must surface mid-stream upstream failures as SSE
 *     `event: error` instead of silently ending the response (clients would
 *     otherwise treat a truncated answer as complete), and must cancel the
 *     oversized upstream body when the 50MB limit trips.
 */
import { jest } from '@jest/globals';
import request from 'supertest';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('R1: Retry-After HTTP-date handling in callOneMin', () => {
  test('falls back to exponential backoff instead of NaN delay on HTTP-date Retry-After', async () => {
    process.env.ONE_MIN_AI_API_KEY = 'test-api-key';
    const { callOneMin } = await import('../utils/api-client.js');

    let fetchCount = 0;
    const start = Date.now();
    globalThis.fetch = jest.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', 'Wed, 21 Oct 2015 07:28:00 GMT']]),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ ok: true }),
      };
    });

    await callOneMin('/api/models', { method: 'GET' });

    // apiRetryDelay default is 2000ms; exponential backoff for attempt 0 is
    // ~2s. A NaN delay would have fired immediately (<100ms gap).
    const gapMs = Date.now() - start;
    expect(fetchCount).toBe(2);
    expect(gapMs).toBeGreaterThanOrEqual(500);
  }, 15_000);

  test('still honors numeric Retry-After seconds', async () => {
    process.env.ONE_MIN_AI_API_KEY = 'test-api-key';
    const { callOneMin } = await import('../utils/api-client.js');
    let fetchCount = 0;
    globalThis.fetch = jest.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: false,
          status: 429,
          headers: new Map([['retry-after', '0']]),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ ok: true }),
      };
    });
    await callOneMin('/api/models', { method: 'GET' });
    expect(fetchCount).toBe(2);
  }, 15_000);
});

describe('R2: chat stream error propagation', () => {
  let app;

  beforeAll(async () => {
    jest.unstable_mockModule('../utils/api-client.js', () => ({
      callOneMin: jest.fn(),
      extractText: jest.fn((data) => data?.result || ''),
      isFailedResponse: jest.fn(() => false),
      extractFailureMessage: jest.fn(() => 'mocked failure'),
      normalizeOneMinRawResponse: jest.fn(async (data) => data),
      normalizeAssetResponse: jest.fn((data) => ({ key: '', url: '', raw: data })),
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
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  test('emits event:error instead of silently ending when upstream stream fails mid-flight', async () => {
    const { callOneMin } = await import('../utils/api-client.js');
    const encoder = new TextEncoder();
    callOneMin.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: content\ndata: {"content":"Hel"}\n\n'));
          // Simulate an upstream connection failure mid-stream.
          controller.error(new Error('ECONNRESET mid-stream'));
        },
      }),
    });

    const response = await request(app).post('/api/chat/stream').send({
      prompt: 'Hello AI',
      model: 'gpt-4o-mini',
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('Upstream stream interrupted');
  });
});
