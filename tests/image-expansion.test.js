/**
 * Coverage for the per-model image expansion:
 * - docs-driven 1min promptObject shapes (flux-2, ideogram-4, gpt-image-2, ...)
 * - the generic 1min image feature endpoint (inpainter, variator, upscaler)
 * - 1forall sizes / additional_fields / upload hand-off / multi-output jobs
 * - the capabilities endpoint both providers expose to the UI
 */
import { jest } from '@jest/globals';
import fs from 'fs';
import request from 'supertest';

const { createApp } = await import('../server.js');
const { fetchOneForAllModels } = await import('../config/models.js');

const ONE_FOR_ALL_CATALOG = [
  {
    code: 'black-forest-labs/flux-2-pro',
    name: 'flux-2-pro',
    mode: 'TEXT_TO_IMAGE',
    enabled: true,
    recommended: true,
    credits_at_defaults: 15,
    sizes: [
      { code: '1:1', ratio: '1:1', default: true, enabled: true },
      { code: '16:9', ratio: '16:9', enabled: true },
    ],
    additional_fields: [
      {
        code: 'steps',
        name: 'Steps',
        type: 'SLIDER',
        min: '15.00',
        max: '50.00',
        step: '1.00',
        default_value: '25',
        required: false,
        enabled: true,
        options: '',
      },
      {
        code: 'negative_prompt',
        name: 'Negative Prompt',
        type: 'TEXT',
        required: false,
        enabled: true,
        options: '',
      },
      {
        code: 'output_format',
        name: 'Output Format',
        type: 'SELECT',
        default_value: 'png',
        required: false,
        enabled: true,
        options: 'png,jpg,webp',
      },
    ],
  },
  {
    code: 'qwen/qwen-image-edit',
    name: 'qwen-image-edit',
    mode: 'IMAGE_TO_IMAGE',
    enabled: true,
    sizes: [],
    additional_fields: [{ code: 'image', name: 'Image', type: 'IMAGE', required: true, enabled: true }],
  },
];

function mockOneMinFeature(captured) {
  return jest.fn(async (url, opts) => {
    if (String(url).includes('api.1min.ai/api/features')) {
      captured.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ aiRecord: { uuid: 'img-record-1', status: 'SUCCESS' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  });
}

describe('Image generation expansion', () => {
  let app;
  let originalFetch;
  const savedEnv = { ...process.env };

  beforeAll(async () => {
    process.env.ONE_MIN_AI_API_KEY = 'test_1min_key_12345';
    process.env.ONE_FOR_ALL_API_KEY = 'sk_live_1forall_test_12345';
    globalThis.fetch = jest.fn(async (url) => {
      const target = String(url);
      if (target.endsWith('/v1/external/image/models/')) {
        return new Response(JSON.stringify(ONE_FOR_ALL_CATALOG), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (target.includes('/v1/external/')) {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    await fetchOneForAllModels();
  });

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

  describe('GET /api/images/capabilities', () => {
    test('describes a 1min model with the parameters its docs declare', async () => {
      const res = await request(app).get(
        '/api/images/capabilities?provider=1min&feature=IMAGE_GENERATOR&model=black-forest-labs/flux-2-pro',
      );

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('1min');
      expect(res.body.feature).toBe('IMAGE_GENERATOR');
      const byKey = Object.fromEntries(res.body.params.map((param) => [param.key, param]));
      expect(byKey.prompt.required).toBe(true);
      expect(byKey.aspect_ratio.type).toBe('select');
      expect(byKey.aspect_ratio.options).toContain('16:9');
      expect(byKey.steps).toMatchObject({ type: 'number', min: 15, max: 50 });
      expect(byKey.guidance.min).toBe(2);
      expect(byKey.prompt_upsampling.type).toBe('boolean');
      expect(Array.isArray(res.body.models)).toBe(true);
      expect(res.body.features.some((feature) => feature.feature === 'IMAGE_INPAINTER')).toBe(true);
    });

    test('gpt-image models expose the custom size and quality controls', async () => {
      const res = await request(app).get(
        '/api/images/capabilities?provider=1min&feature=IMAGE_GENERATOR&model=gpt-image-2',
      );

      expect(res.status).toBe(200);
      const byKey = Object.fromEntries(res.body.params.map((param) => [param.key, param]));
      expect(byKey.size.type).toBe('text');
      expect(byKey.size.pattern).toBe('^\\d+x\\d+$');
      expect(byKey.quality.options).toEqual(expect.arrayContaining(['low', 'medium', 'high']));
      expect(byKey.n.type).toBe('number');
      expect(byKey.output_compression).toMatchObject({ min: 0, max: 100 });
    });

    test('rejects an unknown feature and a model that does not support the feature', async () => {
      const unknown = await request(app).get('/api/images/capabilities?provider=1min&feature=NOPE');
      expect(unknown.status).toBe(400);

      const wrongModel = await request(app).get(
        '/api/images/capabilities?provider=1min&feature=IMAGE_GENERATOR&model=black-forest-labs/flux-kontext-pro',
      );
      expect(wrongModel.status).toBe(400);
      expect(wrongModel.body.code).toBe('UNSUPPORTED_IMAGE_MODEL');
    });

    test('describes a 1forall model from the live catalog (sizes + additional_fields)', async () => {
      const res = await request(app).get(
        '/api/images/capabilities?provider=1forall&model=black-forest-labs/flux-2-pro',
      );

      expect(res.status).toBe(200);
      expect(res.body.provider).toBe('1forall');
      expect(res.body.sizes.map((size) => size.code)).toEqual(['1:1', '16:9']);
      const byKey = Object.fromEntries(res.body.params.map((param) => [param.key, param]));
      expect(byKey.steps).toMatchObject({ type: 'number', min: 15, max: 50, step: 1 });
      expect(byKey.output_format).toMatchObject({ type: 'select', options: ['png', 'jpg', 'webp'] });
      expect(byKey.negative_prompt.type).toBe('text');
    });
  });

  describe('1min model-specific payloads', () => {
    test('maps canonical fields and model extras onto flux-2-pro params', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const res = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'black-forest-labs/flux-2-pro',
        prompt: 'a lighthouse at dawn',
        aspect_ratio: '16:9',
        num_outputs: 2,
        params: { steps: 30, guidance: 3.5, prompt_upsampling: true, output_format: 'jpg' },
      });

      expect(res.status).toBe(200);
      expect(captured[0].type).toBe('IMAGE_GENERATOR');
      // flux-2-pro does not document a count parameter, so num_outputs is not
      // forwarded rather than being sent as an unknown key.
      expect(captured[0].promptObject).toEqual({
        prompt: 'a lighthouse at dawn',
        aspect_ratio: '16:9',
        steps: 30,
        guidance: 3.5,
        prompt_upsampling: true,
        output_format: 'jpg',
      });
    });

    test('translates aspect_ratio into a gpt-image size and keeps required defaults', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const res = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'gpt-image-2',
        prompt: 'a cat',
        aspect_ratio: '16:9',
        num_outputs: 3,
      });

      expect(res.status).toBe(200);
      expect(captured[0].promptObject).toMatchObject({
        prompt: 'a cat',
        size: '1536x1024',
        n: 3,
        quality: 'medium',
      });
    });

    test('rejects parameters the model does not declare and models that do not support the feature', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const unknownParam = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'gpt-image-2',
        prompt: 'a cat',
        params: { steps: 30 },
      });
      expect(unknownParam.status).toBe(400);
      expect(unknownParam.body.code).toBe('INVALID_IMAGE_PARAMS');
      expect(unknownParam.body.error).toContain('steps');

      const wrongFeature = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'black-forest-labs/flux-kontext-pro',
        prompt: 'a cat',
      });
      expect(wrongFeature.status).toBe(400);
      expect(wrongFeature.body.code).toBe('UNSUPPORTED_IMAGE_MODEL');
      expect(captured).toHaveLength(0);
    });

    test('enforces the gpt-image dimension rules on generate', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const res = await request(app).post('/api/images/generate').send({
        provider: '1min',
        model: 'gpt-image-2',
        prompt: 'a cat',
        size: '1000x1000',
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('divisible by 16');
    });
  });

  describe('1min extra image features', () => {
    test('IMAGE_INPAINTER forwards the mask and doc-declared params', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const res = await request(app).post('/api/images/feature').send({
        provider: '1min',
        feature: 'IMAGE_INPAINTER',
        model: 'gpt-image-2',
        imageUrl: 'images/source.png',
        maskUrl: 'images/mask.png',
        prompt: 'replace the car',
        size: '1024x1024',
        quality: 'high',
      });

      expect(res.status).toBe(200);
      expect(captured[0].type).toBe('IMAGE_INPAINTER');
      expect(captured[0].promptObject).toMatchObject({
        imageUrl: 'images/source.png',
        maskUrl: 'images/mask.png',
        prompt: 'replace the car',
        size: '1024x1024',
        quality: 'high',
      });
    });

    test('IMAGE_VARIATOR and IMAGE_UPSCALER use their own parameter sets', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const variator = await request(app).post('/api/images/feature').send({
        provider: '1min',
        feature: 'IMAGE_VARIATOR',
        model: 'black-forest-labs/flux-redux-dev',
        imageUrl: 'images/source.png',
        params: { num_outputs: 2, seed: 42, aspect_ratio: '4:3' },
      });
      expect(variator.status).toBe(200);
      expect(captured[0].type).toBe('IMAGE_VARIATOR');
      expect(captured[0].promptObject).toMatchObject({
        imageUrl: 'images/source.png',
        num_outputs: 2,
        seed: 42,
        aspect_ratio: '4:3',
      });

      const upscaler = await request(app).post('/api/images/feature').send({
        provider: '1min',
        feature: 'IMAGE_UPSCALER',
        model: 'recraft',
        imageUrl: 'images/source.png',
        params: { upscale_type: 'creative' },
      });
      expect(upscaler.status).toBe(200);
      expect(captured[1].promptObject).toEqual({
        imageUrl: 'images/source.png',
        upscale_type: 'creative',
      });
    });

    test('rejects the generate/edit features on the generic route', async () => {
      const captured = [];
      globalThis.fetch = mockOneMinFeature(captured);

      const res = await request(app).post('/api/images/feature').send({
        provider: '1min',
        feature: 'IMAGE_GENERATOR',
        model: 'gpt-image-2',
        prompt: 'a cat',
      });

      expect(res.status).toBe(400);
      expect(captured).toHaveLength(0);
    });
  });

  describe('1forall payloads', () => {
    test('sends catalog size codes and additional_fields to the native endpoint', async () => {
      const captured = [];
      globalThis.fetch = jest.fn(async (url, opts) => {
        if (String(url).includes('/v1/external/image/text-to-image/')) {
          captured.push(JSON.parse(opts.body));
          return new Response(JSON.stringify({ code_ref: 'fa-img-1', status: 'pending' }), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      });

      const res = await request(app).post('/api/images/generate').send({
        provider: '1forall',
        model: 'black-forest-labs/flux-2-pro',
        prompt: 'a lighthouse',
        async: true,
        aspect_ratio: '16:9',
        params: { steps: 30, negative_prompt: 'blurry' },
      });

      expect(res.status).toBe(200);
      expect(captured[0].size).toBe('16:9');
      expect(captured[0].additional_fields).toEqual({ steps: 30, negative_prompt: 'blurry' });
      expect(res.body.jobId).toBe('fa-img-1');
    });

    test('rejects additional_fields the catalog does not declare', async () => {
      globalThis.fetch = jest.fn(async () => {
        return new Response(JSON.stringify({ code_ref: 'x', status: 'pending' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      });

      const res = await request(app).post('/api/images/generate').send({
        provider: '1forall',
        model: 'black-forest-labs/flux-2-pro',
        prompt: 'a lighthouse',
        async: true,
        params: { cfg_scale: 7 },
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IMAGE_PARAMS');
    });

    test('sync path clamps n to 4 and converts ratio sizes to pixels', async () => {
      const captured = [];
      globalThis.fetch = jest.fn(async (url, opts) => {
        if (String(url).includes('/v1/images/generations')) {
          captured.push(JSON.parse(opts.body));
          return new Response(
            JSON.stringify({ data: [{ url: 'https://voicegen-storage.s3.amazonaws.com/out.png' }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      });

      const res = await request(app).post('/api/images/generate').send({
        provider: '1forall',
        model: 'black-forest-labs/flux-2-pro',
        prompt: 'a lighthouse',
        num_outputs: 9,
        aspect_ratio: '16:9',
      });

      expect(res.status).toBe(200);
      expect(captured[0].n).toBe(4);
      expect(captured[0].size).toBe('1792x1024');
      expect(res.body.urls).toEqual(['https://voicegen-storage.s3.amazonaws.com/out.png']);
    });

    test('blocks image editing on a text-to-image model', async () => {
      const res = await request(app).post('/api/images/text-editor').send({
        provider: '1forall',
        model: 'black-forest-labs/flux-2-pro',
        imageUrl: 'images/source.png',
        prompt: 'make it brighter',
      });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNSUPPORTED_IMAGE_MODEL');
    });
  });

  describe('1forall multi-output polling', () => {
    test('flattens url_file, urls and child_conversions into the job URL list', async () => {
      globalThis.fetch = jest.fn(async () => {
        return new Response(
          JSON.stringify({
            status: 'completed',
            url_file: 'https://voicegen-storage.s3.amazonaws.com/first.png',
            urls: 'https://voicegen-storage.s3.amazonaws.com/second.png',
            child_conversions: [{ url_file: 'https://voicegen-storage.s3.amazonaws.com/third.png' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });

      const res = await request(app).get('/api/jobs/1forall/image/job-ref-1');

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('completed');
      expect(res.body.urls).toEqual([
        'https://voicegen-storage.s3.amazonaws.com/first.png',
        'https://voicegen-storage.s3.amazonaws.com/second.png',
        'https://voicegen-storage.s3.amazonaws.com/third.png',
      ]);
      expect(res.body.aiRecord.aiRecordDetail.resultObject).toHaveLength(3);
    });
  });

  describe('docs transcription integrity', () => {
    const spec = JSON.parse(fs.readFileSync('config/image-specs/1min.json', 'utf8'));

    test('covers every documented image feature and model family', () => {
      expect(Object.keys(spec.features).length).toBeGreaterThanOrEqual(14);
      expect(Object.keys(spec.features.IMAGE_GENERATOR.models).length).toBeGreaterThanOrEqual(40);
      expect(Object.keys(spec.features.IMAGE_EDITOR.models).length).toBeGreaterThanOrEqual(25);
      expect(Object.keys(spec.features.IMAGE_INPAINTER.models).length).toBeGreaterThanOrEqual(5);
      expect(Object.keys(spec.features.IMAGE_VARIATOR.models).length).toBeGreaterThanOrEqual(8);
      // The only pages without a parameter table are the sketch-to-image ones;
      // their shapes live in config/image-specs/1min-overrides.json.
      const unexpectedFailures = (spec.failures || []).filter(
        (failure) => !failure.url.includes('sketch-to-image'),
      );
      expect(unexpectedFailures).toEqual([]);
    });

    test('every generating/editing model documents prompt and imageUrl respectively', () => {
      for (const [model, entry] of Object.entries(spec.features.IMAGE_GENERATOR.models)) {
        expect({ model, prompt: entry.params.some((param) => param.name === 'prompt') }).toEqual({
          model,
          prompt: true,
        });
      }
      for (const [model, entry] of Object.entries(spec.features.IMAGE_EDITOR.models)) {
        expect({ model, imageUrl: entry.params.some((param) => param.name === 'imageUrl') }).toEqual({
          model,
          imageUrl: true,
        });
      }
    });
  });

  describe('frontend wiring', () => {
    const html = fs.readFileSync('public/index.html', 'utf8');
    const ja = JSON.parse(fs.readFileSync('public/i18n/ja.json', 'utf8'));
    const en = JSON.parse(fs.readFileSync('public/i18n/en.json', 'utf8'));

    test('exposes the capability containers image.js drives', () => {
      for (const id of ['imageFeature', 'imageFeatureWrap', 'modelParamsSection', 'modelParamsGrid']) {
        expect(html).toContain(`id="${id}"`);
      }
      for (const i18nKey of [
        'img_feature_label',
        'img_model_params_title',
        'img_feature_inpaint',
        'img_feature_variate',
      ]) {
        expect(html).toContain(`data-i18n="${i18nKey}"`);
      }
    });

    test('every data-i18n key added for the image panel exists in both locales', () => {
      const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]);
      const missing = keys.filter((key) => ja[key] === undefined || en[key] === undefined);
      expect(missing).toEqual([]);
    });
  });
});
