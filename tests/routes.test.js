import { jest } from '@jest/globals';
import request from 'supertest';

// Mock the api-client module before importing anything that uses it
jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => {
    if (!data) return '';
    if (typeof data.result === 'string') return data.result;
    if (data.aiRecord?.aiRecordDetail?.resultObject) return data.aiRecord.aiRecordDetail.resultObject;
    return JSON.stringify(data);
  }),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'mocked failure'),
  normalizeOneMinRawResponse: jest.fn(async (data) => data),
  normalizeAssetResponse: jest.fn((data) => {
    const key = data?.asset?.key || data?.fileContent?.path || '';
    return { key, url: key ? `https://asset.1min.ai/${key}` : '', raw: data };
  }),
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

// Re-import mocked client and other helpers after mocking
const { callOneMin } = await import('../utils/api-client.js');
const { createTestApp, testPayloads, mockResponses } = await import('./test-helper.js');

describe('AI Routes Integration Tests', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createTestApp();
    process.env.ONE_MIN_AI_API_KEY = 'test-api-key';
  });

  describe('GET /api/models', () => {
    test('should return available models lists', async () => {
      const response = await request(app).get('/api/models');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('chatModels');
      expect(response.body).toHaveProperty('codeModels');
      expect(response.body).toHaveProperty('imageModels');
    });
  });

  describe('POST /api/chat', () => {
    test('should call callOneMin and return chat response data', async () => {
      callOneMin.mockResolvedValue(mockResponses.chat);

      const response = await request(app).post('/api/chat').send(testPayloads.chat);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.chat);
      expect(callOneMin).toHaveBeenCalledWith('/api/chat-with-ai', expect.any(Object));
    });

    test('should return 400 if prompt is missing or empty', async () => {
      const response = await request(app).post('/api/chat').send({ model: 'gpt-4o-mini' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('prompt is required');
    });
  });

  describe('POST /api/images/generate', () => {
    test('should return generated image response', async () => {
      callOneMin.mockResolvedValue(mockResponses.image);

      const response = await request(app).post('/api/images/generate').send(testPayloads.image);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.image);
      expect(callOneMin).toHaveBeenCalledWith('/api/features', expect.any(Object));
    });

    test('should return 400 if image prompt is missing', async () => {
      const response = await request(app).post('/api/images/generate').send({ model: 'gpt-image-2' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('prompt is required');
    });
  });

  describe('POST /api/code/generate', () => {
    test('should return generated code response', async () => {
      callOneMin.mockResolvedValue(mockResponses.code);

      const response = await request(app).post('/api/code/generate').send(testPayloads.codeGenerate);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.code);
      expect(callOneMin).toHaveBeenCalledWith(
        '/api/features?isStreaming=true',
        expect.objectContaining({
          body: expect.stringContaining('"type":"CODE_GENERATOR"'),
          raw: true,
        }),
      );

      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.promptObject).toEqual(
        expect.objectContaining({
          prompt: expect.stringContaining('ユーザー指示:'),
          webSearch: false,
        }),
      );
      // Per 1min.ai CODE_GENERATOR docs, webSearch/numOfSite/maxWord live
      // directly on promptObject — there should be no `settings` wrapper.
      expect(sentBody.promptObject).not.toHaveProperty('settings');
    });

    test('should return 400 if instruction is missing', async () => {
      const response = await request(app).post('/api/code/generate').send({ code: 'console.log()' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('instruction is required');
    });
  });

  describe('POST /api/assets/upload', () => {
    test('should not return raw upstream payload', async () => {
      callOneMin.mockResolvedValue({
        asset: { key: 'uploads/test.txt' },
      });

      const response = await request(app)
        .post('/api/assets/upload')
        .attach('asset', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        key: 'uploads/test.txt',
        url: 'https://asset.1min.ai/uploads/test.txt',
      });
      expect(response.body).not.toHaveProperty('raw');
    });
  });

  describe('POST /api/code/autocomplete', () => {
    test('should return suggestion code', async () => {
      callOneMin.mockResolvedValue({
        result: 'console.log("world");',
      });

      const response = await request(app).post('/api/code/autocomplete').send(testPayloads.codeAutocomplete);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('suggestion');
      expect(response.body.suggestion).toBe('console.log("world");');
      expect(callOneMin).toHaveBeenCalledWith(
        '/api/features?isStreaming=true',
        expect.objectContaining({
          body: expect.stringContaining('"type":"CODE_GENERATOR"'),
          raw: true,
        }),
      );
    });
  });

  describe('POST /api/code/inline-chat', () => {
    test('should call CODE_GENERATOR through the streaming feature endpoint', async () => {
      callOneMin.mockResolvedValue({
        result: 'return a + b;',
      });

      const response = await request(app).post('/api/code/inline-chat').send({
        prompt: 'simplify this return statement',
        code: 'function add(a, b) {\n  return Number(a) + Number(b);\n}',
        line: 2,
        column: 3,
        fileName: 'math.js',
        language: 'javascript',
      });

      expect(response.status).toBe(200);
      expect(response.body.code).toBe('return a + b;');
      expect(callOneMin).toHaveBeenCalledWith(
        '/api/features?isStreaming=true',
        expect.objectContaining({
          body: expect.stringContaining('"type":"CODE_GENERATOR"'),
          raw: true,
        }),
      );
    });
  });

  describe('POST /api/images/text-editor', () => {
    test('should return edited image response', async () => {
      callOneMin.mockResolvedValue({
        aiRecord: {
          uuid: 'edit-uuid-123',
          aiRecordDetail: {
            resultObject: ['images/edited-result.png'],
          },
        },
      });

      const response = await request(app).post('/api/images/text-editor').send({
        imageUrl: 'images/source.png',
        prompt: 'change background to sunset',
        model: 'gpt-image-2',
      });

      expect(response.status).toBe(200);
      expect(callOneMin).toHaveBeenCalledWith('/api/features', expect.any(Object));
    });

    test('should normalize various imageUrl formats to relative asset key before calling 1min.ai features', async () => {
      const mockResult = {
        aiRecord: {
          uuid: 'edit-uuid-123',
          aiRecordDetail: { resultObject: ['images/edited-result.png'] },
        },
      };

      const imageUrlsToTest = [
        // S3 path-style URL
        'https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/docusaurus.png?X-Amz-Signature=123',
        // Direct domain / Virtual-host style URL
        'https://asset.1min.ai/images/docusaurus.png',
        // Local proxy URL
        '/api/assets/proxy?key=images%2Fdocusaurus.png',
        // Local proxy with nested S3 URL
        '/api/assets/proxy?url=https%3A%2F%2Fs3.us-east-1.amazonaws.com%2Fasset.1min.ai%2Fimages%2Fdocusaurus.png',
        // Relative key
        'images/docusaurus.png',
        // Relative key with leading slash
        '/images/docusaurus.png',
      ];

      for (const imgUrl of imageUrlsToTest) {
        callOneMin.mockReset();
        callOneMin.mockResolvedValue(mockResult);

        const response = await request(app).post('/api/images/text-editor').send({
          imageUrl: imgUrl,
          prompt: 'change background to sunset',
          model: 'gpt-image-2',
        });

        expect(response.status).toBe(200);
        expect(callOneMin).toHaveBeenCalledTimes(1);
        const sentPayload = JSON.parse(callOneMin.mock.calls[0][1].body);
        expect(sentPayload.promptObject.imageUrl).toBe('images/docusaurus.png');
      }
    });

    test('should return 400 if imageUrl is missing', async () => {
      const response = await request(app)
        .post('/api/images/text-editor')
        .send({ prompt: 'edit', model: 'gpt-image-2' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('imageUrl');
    });

    test('should return 400 if WxH size is malformed for gpt-image', async () => {
      const response = await request(app).post('/api/images/text-editor').send({
        imageUrl: 'images/source.png',
        prompt: 'edit',
        model: 'gpt-image-2',
        size: 'invalid-size',
      });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('size must be in WxH format');
    });
  });

  describe('POST /api/agent/chat', () => {
    test('should accept prompt string and return agent response using CODE_GENERATOR', async () => {
      callOneMin.mockResolvedValue({
        result: 'I will fix this bug.',
      });

      const response = await request(app).post('/api/agent/chat').send({
        prompt: 'Fix the bug in the code',
        model: 'claude-sonnet-4-6',
        webSearch: false,
      });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('text');
      expect(response.body.text).toBe('I will fix this bug.');
      expect(response.body).toHaveProperty('raw');
      expect(callOneMin).toHaveBeenCalledWith('/api/features?isStreaming=true', expect.any(Object));
      expect(callOneMin.mock.calls.at(-1)[1]).toMatchObject({ raw: true });

      // Verify payload uses CODE_GENERATOR type
      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.type).toBe('CODE_GENERATOR');
      expect(sentBody.model).toBe('claude-sonnet-4-6');
      expect(sentBody).not.toHaveProperty('conversationId');
      expect(sentBody.promptObject).toBeDefined();
      expect(sentBody.promptObject.prompt).toBe('Fix the bug in the code');
      // CODE_GENERATOR uses flat webSearch on promptObject (no settings wrapper)
      expect(sentBody.promptObject.webSearch).toBe(false);
      expect(sentBody.promptObject).not.toHaveProperty('settings');
    });

    test('should accept messages array and flatten into prompt', async () => {
      callOneMin.mockResolvedValue({
        result: 'Based on the conversation, here is the fix.',
      });

      const response = await request(app)
        .post('/api/agent/chat')
        .send({
          messages: [
            { role: 'user', content: 'Read the file utils/helper.js' },
            { role: 'assistant', content: 'I read the file. It exports an add function.' },
            { role: 'user', content: 'Add a multiply function' },
          ],
          model: 'claude-sonnet-4-6',
        });

      expect(response.status).toBe(200);
      expect(response.body.text).toBe('Based on the conversation, here is the fix.');

      // Verify that the flattened prompt contains role markers and uses CODE_GENERATOR
      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.type).toBe('CODE_GENERATOR');
      expect(sentBody).not.toHaveProperty('conversationId');
      expect(sentBody.promptObject.prompt).toContain('<message role="user">');
      expect(sentBody.promptObject.prompt).toContain('<message role="assistant">');
      expect(sentBody.promptObject.prompt).toContain('Read the file');
      expect(sentBody.promptObject.prompt).toContain('Add a multiply function');
    });

    test('should return 400 when both prompt and messages are missing', async () => {
      const response = await request(app).post('/api/agent/chat').send({ model: 'claude-sonnet-4-6' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('prompt');
    });

    test('should return 400 when messages is an empty array', async () => {
      const response = await request(app)
        .post('/api/agent/chat')
        .send({ messages: [], model: 'claude-sonnet-4-6' });

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('prompt');
    });

    test('should not include conversationId in payload (CODE_GENERATOR has no conversation concept)', async () => {
      callOneMin.mockResolvedValue({
        result: 'ok',
      });

      const response = await request(app).post('/api/agent/chat').send({
        prompt: 'Hello',
        conversationId: 'session-123',
      });

      expect(response.status).toBe(200);
      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      // CODE_GENERATOR does not use conversation ID
      expect(sentBody).not.toHaveProperty('conversationId');
    });
  });

  describe('GET /api/assets/proxy', () => {
    let originalFetch;
    beforeAll(() => {
      originalFetch = global.fetch;
    });
    afterAll(() => {
      global.fetch = originalFetch;
    });

    test('should proxy asset from 1min.ai and return it', async () => {
      const mockResponseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('fake image data'));
          controller.close();
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        body: mockResponseBody,
      });

      const response = await request(app).get('/api/assets/proxy').query({ key: 'images/test.png' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      const receivedText = response.text || (response.body && response.body.toString()) || '';
      expect(receivedText).toBe('fake image data');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://asset.1min.ai/images/test.png',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('should reject oversized upstream assets by Content-Length', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'image/png',
          'content-length': String(50 * 1024 * 1024 + 1),
        }),
        body: new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
      });

      const response = await request(app).get('/api/assets/proxy').query({ key: 'images/too-large.png' });

      expect(response.status).toBe(413);
      expect(response.body.error).toContain('too large');
    });

    test('should return 504 when upstream asset fetch is aborted', async () => {
      const abortError = new Error('aborted');
      abortError.name = 'AbortError';
      global.fetch = jest.fn().mockRejectedValue(abortError);

      const response = await request(app).get('/api/assets/proxy').query({ key: 'images/slow.png' });

      expect(response.status).toBe(504);
      expect(response.body.error).toContain('timed out');
    });

    test('should reject untrusted hosts', async () => {
      const response = await request(app)
        .get('/api/assets/proxy')
        .query({ url: 'https://evil.com/malicious.png' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Untrusted asset host');
    });

    test('should reject untrusted Amazon S3 hosts', async () => {
      const response = await request(app)
        .get('/api/assets/proxy')
        .query({ url: 'https://evil-bucket.s3.amazonaws.com/malicious.png' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Untrusted asset host');
    });

    test('should allow path-style Amazon S3 URLs for trusted bucket', async () => {
      const mockResponseBody = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('fake s3 image data'));
          controller.close();
        },
      });
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        body: mockResponseBody,
      });

      const response = await request(app)
        .get('/api/assets/proxy')
        .query({ url: 'https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/test.png' });

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      const receivedText = response.text || (response.body && response.body.toString()) || '';
      expect(receivedText).toBe('fake s3 image data');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://s3.us-east-1.amazonaws.com/asset.1min.ai/images/test.png',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('should reject path-style Amazon S3 URLs for untrusted bucket', async () => {
      const response = await request(app)
        .get('/api/assets/proxy')
        .query({ url: 'https://s3.us-east-1.amazonaws.com/evil-bucket/malicious.png' });

      expect(response.status).toBe(403);
      expect(response.body.error).toContain('Untrusted asset host');
    });
  });
});
