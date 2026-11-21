import { jest } from '@jest/globals';
import request from 'supertest';

const { createApp } = await import('../server.js');

describe('Video, Jobs, and Multi-Provider Route Integration Tests', () => {
  let app;
  let originalFetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.ONE_MIN_AI_API_KEY = 'test_1min_key_12345';
    process.env.ONE_FOR_ALL_API_KEY = 'sk_live_1forall_test_12345';
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  test('POST /api/videos/generate validates prompt/imageUrl and routes to 1min or 1forall', async () => {
    const badRes = await request(app).post('/api/videos/generate').send({ provider: '1min' });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error).toContain('prompt or imageUrl');

    globalThis.fetch = jest.fn(async (url, opts) => {
      if (String(url).includes('api.1min.ai/api/features')) {
        const sent = JSON.parse(opts.body);
        expect(sent.type).toBe('TEXT_TO_VIDEO');
        expect(sent.async).toBe(true);
        return new Response(JSON.stringify({ aiRecord: { uuid: '1min-vid-uuid-1', status: 'PROCESSING' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('api.1forall.ai/v1/external/video/convert-to-video/')) {
        const sent = JSON.parse(opts.body);
        expect(sent.source_image_path).toBe('https://voicegen-storage.s3.amazonaws.com/src.png');
        return new Response(JSON.stringify({ code_ref: '1fa-vid-ref-1', status: 'pending' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });

    const minRes = await request(app).post('/api/videos/generate').send({
      provider: '1min',
      model: 'veo3-video',
      prompt: 'Ocean waves at sunrise',
    });
    expect(minRes.status).toBe(200);
    expect(minRes.body).toMatchObject({ status: 'PROCESSING', jobId: '1min-vid-uuid-1', provider: '1min' });

    const faRes = await request(app).post('/api/videos/generate').send({
      provider: '1forall',
      model: 'kling_standard',
      prompt: 'Zoom effect',
      imageUrl: 'https://voicegen-storage.s3.amazonaws.com/src.png',
    });
    expect(faRes.status).toBe(200);
    expect(faRes.body).toMatchObject({ status: 'PROCESSING', jobId: '1fa-vid-ref-1', provider: '1forall' });
  });

  test('GET /api/jobs/:provider/:kind/:jobId polls status and rejects malformed IDs', async () => {
    const badId = await request(app).get('/api/jobs/1min/video/bad$id!');
    expect(badId.status).toBe(400);

    globalThis.fetch = jest.fn(async (url) => {
      if (String(url).includes('/api/results/uuid-123')) {
        return new Response(
          JSON.stringify({
            aiRecord: {
              uuid: 'uuid-123',
              status: 'SUCCESS',
              temporaryUrl: 'https://storage.1min.ai/videos/done.mp4',
              aiRecordDetail: { resultObject: ['videos/done.mp4'] },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const res = await request(app).get('/api/jobs/1min/video/uuid-123');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'completed',
      jobId: 'uuid-123',
      urls: ['https://storage.1min.ai/videos/done.mp4'],
    });
  });

  test('POST /api/chat rejects unsupported 1min features on 1forall and accepts messages array', async () => {
    const unsupported = await request(app).post('/api/chat').send({
      provider: '1forall',
      prompt: 'Hello',
      webSearch: true,
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body.code).toBe('UNSUPPORTED_FOR_PROVIDER');

    globalThis.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Multi-turn reply' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const okRes = await request(app)
      .post('/api/chat')
      .send({
        provider: '1forall',
        model: 'gpt-4o-mini',
        messages: [
          { role: 'user', content: 'Remember my name is Ken' },
          { role: 'assistant', content: 'Got it, Ken.' },
          { role: 'user', content: 'What is my name?' },
        ],
      });
    expect(okRes.status).toBe(200);
    expect(okRes.body.text).toBe('Multi-turn reply');
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.messages).toHaveLength(3);
  });

  test('POST /api/conversations rejects 1forall with UNSUPPORTED_FOR_PROVIDER', async () => {
    const res = await request(app).post('/api/conversations').send({ provider: '1forall', title: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FOR_PROVIDER');
  });
});
