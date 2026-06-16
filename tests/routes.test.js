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
  normalizeAssetResponse: jest.fn((data) => ({ key: data?.asset?.key || '', url: '', raw: data })),
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

      const response = await request(app)
        .post('/api/chat')
        .send(testPayloads.chat);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.chat);
      expect(callOneMin).toHaveBeenCalledWith('/api/chat-with-ai', expect.any(Object));
    });

    test('should return 400 if prompt is missing or empty', async () => {
      const response = await request(app)
        .post('/api/chat')
        .send({ model: 'gpt-4o-mini' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('prompt is required');
    });
  });

  describe('POST /api/images/generate', () => {
    test('should return generated image response', async () => {
      callOneMin.mockResolvedValue(mockResponses.image);

      const response = await request(app)
        .post('/api/images/generate')
        .send(testPayloads.image);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.image);
      expect(callOneMin).toHaveBeenCalledWith('/api/features', expect.any(Object));
    });

    test('should return 400 if image prompt is missing', async () => {
      const response = await request(app)
        .post('/api/images/generate')
        .send({ model: 'gpt-image-2' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('prompt is required');
    });
  });

  describe('POST /api/code/generate', () => {
    test('should return generated code response', async () => {
      callOneMin.mockResolvedValue(mockResponses.code);

      const response = await request(app)
        .post('/api/code/generate')
        .send(testPayloads.codeGenerate);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockResponses.code);
      expect(callOneMin).toHaveBeenCalledWith(
        '/api/features',
        expect.objectContaining({
          body: expect.stringContaining('"type":"CODE_GENERATOR"'),
        }),
      );

      const sentBody = JSON.parse(callOneMin.mock.calls.at(-1)[1].body);
      expect(sentBody.promptObject).toEqual(
        expect.objectContaining({
          prompt: expect.stringContaining('ユーザー指示:'),
          webSearch: false,
        }),
      );
      expect(sentBody.promptObject).not.toHaveProperty('settings');
    });

    test('should return 400 if instruction is missing', async () => {
      const response = await request(app)
        .post('/api/code/generate')
        .send({ code: 'console.log()' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('instruction is required');
    });
  });

  describe('POST /api/code/autocomplete', () => {
    test('should return suggestion code', async () => {
      callOneMin.mockResolvedValue({
        result: 'console.log("world");',
      });

      const response = await request(app)
        .post('/api/code/autocomplete')
        .send(testPayloads.codeAutocomplete);

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('suggestion');
      expect(response.body.suggestion).toBe('console.log("world");');
    });
  });
});
