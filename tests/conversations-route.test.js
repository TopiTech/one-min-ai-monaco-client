/**
 * Route-handler-level coverage for POST /api/conversations.
 *
 * The frontend now sends the active provider with the conversation-create
 * request. This suite verifies the BFF contract end to end:
 * - the provider is parsed and validated by the shared request schema,
 * - it is used to select the provider/capability (not silently dropped),
 * - an unsupported provider is rejected without creating anything upstream,
 * - omitting the field still uses the configured default (backward compat).
 *
 * There is no local conversation table in this BFF: 1min.ai owns conversation
 * persistence, so "persisted" here means the upstream /api/conversations call
 * is actually made for the resolved, capable provider.
 */
import { jest } from '@jest/globals';
import request from 'supertest';

jest.unstable_mockModule('../utils/api-client.js', () => ({
  callOneMin: jest.fn(),
  extractText: jest.fn((data) => data?.result || JSON.stringify(data)),
  isFailedResponse: jest.fn(() => false),
  extractFailureMessage: jest.fn(() => 'mocked failure'),
  normalizeOneMinRawResponse: jest.fn(async (data) => data),
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

const { callOneMin } = await import('../utils/api-client.js');
const { createApp } = await import('../server.js');
const { serverConfig } = await import('../config/server.js');

describe('POST /api/conversations provider boundary', () => {
  let app;
  let previousDefaultProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ONE_MIN_AI_API_KEY = 'test-api-key';
    previousDefaultProvider = serverConfig.defaultProvider;
    serverConfig.defaultProvider = '1min';
    app = createApp({ requireLocalAuth: false, enableRateLimit: false });
    callOneMin.mockResolvedValue({
      aiRecord: { uuid: 'conv-123', conversationId: 'conv-123' },
    });
  });

  afterEach(() => {
    serverConfig.defaultProvider = previousDefaultProvider;
  });

  test('an explicit 1min provider is accepted and creates the upstream conversation', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .send({ provider: '1min', title: 'Review session', model: 'gpt-4o-mini' });

    expect(res.status).toBe(200);
    expect(res.body.aiRecord.conversationId).toBe('conv-123');

    expect(callOneMin).toHaveBeenCalledTimes(1);
    const [pathname, options] = callOneMin.mock.calls[0];
    expect(pathname).toBe('/api/conversations');
    expect(options.idempotent).toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const sent = JSON.parse(options.body);
    expect(sent).toEqual({
      type: 'UNIFY_CHAT_WITH_AI',
      title: 'Review session',
      model: 'gpt-4o-mini',
    });
    // `provider` is a BFF routing/capability selector: the upstream 1min.ai
    // conversation schema has no provider field, so it must not be forwarded.
    expect(sent).not.toHaveProperty('provider');
  });

  test('an unsupported provider is rejected and no upstream conversation is created', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .send({ provider: '1forall', title: 'Should not exist' });

    // If the route dropped or ignored `provider`, this would default to 1min
    // and return 200 with an upstream call.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FOR_PROVIDER');
    expect(callOneMin).not.toHaveBeenCalled();
  });

  test('omitting provider keeps backward compatibility by using the default provider', async () => {
    const res = await request(app).post('/api/conversations').send({ title: 'Legacy client' });

    expect(res.status).toBe(200);
    expect(callOneMin).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(callOneMin.mock.calls[0][1].body);
    expect(sent.title).toBe('Legacy client');
    expect(sent.model).toBe(serverConfig.defaultChatModel);
  });

  test('an invalid provider id fails request validation before any upstream call', async () => {
    const res = await request(app)
      .post('/api/conversations')
      .send({ provider: 'openai', title: 'Invalid provider' });

    expect(res.status).toBe(400);
    expect(callOneMin).not.toHaveBeenCalled();
  });

  test('omitting provider never silently downgrades away from a 1forall default', async () => {
    serverConfig.defaultProvider = '1forall';

    const res = await request(app).post('/api/conversations').send({ title: 'Default is 1forall' });

    // The resolved default is honored: conversations are unsupported on
    // 1forall, so this fails instead of silently creating a 1min conversation.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_FOR_PROVIDER');
    expect(callOneMin).not.toHaveBeenCalled();
  });
});
