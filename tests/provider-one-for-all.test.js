import { jest } from '@jest/globals';
import {
  buildOneForAllTitle,
  normalizeOneForAllJobStatus,
  oneForAllProvider,
  registerOneForAllModelLimits,
  resolveOneForAllMaxTokens,
} from '../providers/one-for-all/index.js';
import { consumeOpenAiSseStream } from '../utils/sse.js';
import { isTrustedAssetUrl } from '../services/asset-proxy.js';

describe('1forall.ai provider adapter and SSE/Asset handling', () => {
  let originalFetch;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.ONE_FOR_ALL_API_KEY = 'sk_live_1forall_test_key';
    process.env.ONE_MIN_AI_API_KEY = 'secret_1min_should_not_leak';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...savedEnv };
    jest.restoreAllMocks();
  });

  test('sends ONLY Authorization: Bearer and never sends API-KEY header', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Bakery slogan!' } }],
          usage: { total_tokens: 12 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await oneForAllProvider.chat({
      prompt: 'Write a slogan',
      model: 'gpt-4o-mini',
    });

    expect(result.text).toBe('Bakery slogan!');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.1forall.ai/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk_live_1forall_test_key');
    expect(opts.headers['API-KEY']).toBeUndefined();
    const sent = JSON.parse(opts.body);
    expect(sent.max_tokens).toBe(4096);
  });

  test('resolveOneForAllMaxTokens respects task defaults and clamps to min_max_tokens', () => {
    registerOneForAllModelLimits([{ id: 'strict-model', meta: { minMaxTokens: 512 } }]);
    expect(resolveOneForAllMaxTokens({ task: 'autocomplete', model: 'gpt-4o-mini' })).toBe(256);
    expect(resolveOneForAllMaxTokens({ task: 'inline', model: 'gpt-4o-mini' })).toBe(1024);
    expect(resolveOneForAllMaxTokens({ task: 'autocomplete', model: 'strict-model' })).toBe(512);
  });

  test('openChatStream falls back to non-streaming when model returns 400 stream unsupported', async () => {
    globalThis.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: 'This model does not support streaming',
              type: 'invalid_request_error',
              param: 'model',
              code: 'unsupported_parameter',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Non-stream fallback answer' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    const { response, format } = await oneForAllProvider.openChatStream({
      prompt: 'Hi',
      model: 'non-stream-model',
    });

    expect(format).toBe('1min-sse');
    const body = await response.text();
    expect(body).toContain('event: content');
    expect(body).toContain('Non-stream fallback answer');
    expect(body).toContain('event: final-result');
    expect(body).toContain('data: [DONE]');
  });

  test('consumeOpenAiSseStream flags streams terminating without [DONE]', async () => {
    const encoder = new TextEncoder();
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n'));
          controller.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

    const chunks = [];
    const errors = [];
    await consumeOpenAiSseStream(res, {
      onContent: (c) => chunks.push(c),
      onError: (e) => errors.push(e),
    });

    expect(chunks.join('')).toBe('Partial');
    expect(errors[0]).toContain('without [DONE]');
  });

  test('generateImage, editImage, generateVideo, and getJob map 1forall native & OpenAI endpoints', async () => {
    globalThis.fetch = jest.fn(async (url) => {
      const u = String(url);
      if (u.endsWith('/v1/images/generations')) {
        return new Response(
          JSON.stringify({ data: [{ url: 'https://voicegen-storage.s3.amazonaws.com/out.png' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }
      if (u.endsWith('/v1/external/image/image-to-image/')) {
        return new Response(JSON.stringify({ code_ref: 'img_ref_1', status: 'pending' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/v1/external/video/convert-to-video/')) {
        return new Response(JSON.stringify({ code_ref: 'vid_ref_1', status: 'pending' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.endsWith('/v1/external/video/check-status/vid_ref_1/')) {
        return new Response(
          JSON.stringify({
            status: 'completed',
            url_file: 'https://tts-clariteia.s3.eu-west-1.amazonaws.com/video/clip.mp4',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    });

    const img = await oneForAllProvider.generateImage({
      prompt: 'Lighthouse',
      model: 'dall-e-3',
      num_outputs: 10, // clamped to 4
    });
    expect(img.urls).toEqual(['https://voicegen-storage.s3.amazonaws.com/out.png']);
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body).n).toBe(4);

    const edit = await oneForAllProvider.editImage({
      imageUrl: 'https://voicegen-storage.s3.amazonaws.com/media/images/src.png',
      prompt: 'Add label',
      model: 'stable-diffusion-image',
    });
    expect(edit).toMatchObject({ status: 'PROCESSING', jobId: 'img_ref_1', provider: '1forall' });

    const vid = await oneForAllProvider.generateVideo({
      prompt: 'A flying drone',
      model: 'google-veo3',
      aspect_ratio: '16:9',
    });
    expect(vid).toMatchObject({ status: 'PROCESSING', jobId: 'vid_ref_1', kind: 'video' });

    const job = await oneForAllProvider.getJob('vid_ref_1', 'video');
    expect(job).toMatchObject({
      status: 'completed',
      urls: ['https://tts-clariteia.s3.eu-west-1.amazonaws.com/video/clip.mp4'],
    });
  });

  test('isTrustedAssetUrl allows 1min storage and 1forall S3 buckets while blocking evil hosts', () => {
    expect(isTrustedAssetUrl(new URL('https://storage.1min.ai/videos/a.mp4'))).toBe(true);
    expect(isTrustedAssetUrl(new URL('https://voicegen-storage.s3.amazonaws.com/media/a.png'))).toBe(true);
    expect(isTrustedAssetUrl(new URL('https://tts-clariteia.s3.eu-west-1.amazonaws.com/video/a.mp4'))).toBe(
      true,
    );
    expect(isTrustedAssetUrl(new URL('https://evil-bucket.s3.amazonaws.com/x.png'))).toBe(false);
    expect(buildOneForAllTitle('Line 1\nLine 2')).toBe('Line 1');
  });

  test('uploadAsset sends title, format, and file to /v1/external/image/upload/', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify({
          uploaded_image_url: 'https://voicegen-storage.s3.amazonaws.com/media/images/2026/uploaded.png',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    });

    const blob = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
    const uploaded = await oneForAllProvider.uploadAsset({ blob, filename: 'sample.jpg' });

    expect(uploaded).toEqual({
      key: 'https://voicegen-storage.s3.amazonaws.com/media/images/2026/uploaded.png',
      url: 'https://voicegen-storage.s3.amazonaws.com/media/images/2026/uploaded.png',
    });
    const [url, opts] = globalThis.fetch.mock.calls[0];
    expect(url).toBe('https://api.1forall.ai/v1/external/image/upload/');
    expect(opts.headers.Authorization).toBe('Bearer sk_live_1forall_test_key');
    expect(opts.body).toBeInstanceOf(FormData);
    expect(opts.body.get('title')).toBe('sample.jpg');
    expect(opts.body.get('format')).toBe('jpeg');
    expect(opts.body.get('file')).toBeTruthy();
  });

  test('consumeOpenAiSseStream cancels upstream reader when exiting early on [DONE]', async () => {
    const cancelSpy = jest.fn(async () => {});
    const encoder = new TextEncoder();
    const res = {
      body: {
        getReader: () => {
          let sent = false;
          return {
            read: async () => {
              if (!sent) {
                sent = true;
                return {
                  done: false,
                  value: encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: [DONE]\n\n'),
                };
              }
              return { done: true, value: undefined };
            },
            cancel: cancelSpy,
            releaseLock: () => {},
          };
        },
      },
    };

    const chunks = [];
    await consumeOpenAiSseStream(res, { onContent: (c) => chunks.push(c) });
    expect(chunks.join('')).toBe('Hi');
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  test('openChatStream classifies charset=utf-8 OpenAI SSE responses as openai-sse even with empty response.url', async () => {
    const encoder = new TextEncoder();
    globalThis.fetch = jest.fn(async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
      );
    });

    const { format } = await oneForAllProvider.openChatStream({
      prompt: 'Hi',
      model: 'gpt-4o-mini',
    });
    expect(format).toBe('openai-sse');
  });

  test('openChatStream does not retry invalid-model 400 errors that are unrelated to streaming', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: 'The model nonexistent-model does not exist',
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    });

    await expect(
      oneForAllProvider.openChatStream({
        prompt: 'Hi',
        model: 'nonexistent-model',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test('generateImage (async) throws 502 when initial upstream response already reports failed', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(
        JSON.stringify({
          code_ref: 'img-fail-1',
          status: 'failed',
          error: 'Prompt rejected by safety filter',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    await expect(
      oneForAllProvider.generateImage({
        prompt: 'test',
        model: 'flux-1',
        async: true,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  test('chat falls back to prompt when messages array contains only whitespace entries', async () => {
    globalThis.fetch = jest.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fallback prompt ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await oneForAllProvider.chat({
      prompt: 'Actual user prompt',
      messages: [{ role: 'user', content: '   ' }],
      model: 'gpt-4o-mini',
    });
    const sent = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
    expect(sent.messages).toEqual([{ role: 'user', content: 'Actual user prompt' }]);
  });

  test('normalizeOneForAllJobStatus treats cancelled, expired, timeout, aborted, and error payloads as failed', () => {
    for (const status of ['cancelled', 'canceled', 'expired', 'timeout', 'timed_out', 'aborted']) {
      expect(normalizeOneForAllJobStatus({ status }, 'ref-1', 'video')).toMatchObject({
        status: 'failed',
        jobId: 'ref-1',
        provider: '1forall',
        kind: 'video',
        urls: [],
      });
    }

    expect(
      normalizeOneForAllJobStatus({ status: 'processing', error: 'Worker crashed' }, 'ref-2', 'image'),
    ).toMatchObject({
      status: 'failed',
      error: 'Worker crashed',
      urls: [],
    });

    expect(normalizeOneForAllJobStatus({ status: 'queued' }, 'ref-3', 'image')).toMatchObject({
      status: 'pending',
      urls: [],
    });
  });
});
