import { isFailedResponse, extractFailureMessage } from '../utils/api-client.js';
import { isPendingStatusResponse } from '../utils/http-client.js';
import { buildOneMinVideoPayload } from '../providers/one-min/video.js';
import {
  buildOneMinOpenAiChatPayload,
  shouldUseOneMinOpenAiCompat,
  supportsSamplingControls,
} from '../providers/one-min/openai-compat.js';
import { normalizeOneMinJobStatus } from '../providers/one-min/index.js';

describe('1min.ai provider helpers and latest spec compliance', () => {
  test('isPendingStatusResponse and isFailedResponse distinguish PROCESSING from FAILURE', () => {
    const processing = { aiRecord: { uuid: 'u1', status: 'PROCESSING' } };
    const failure = {
      aiRecord: {
        uuid: 'u2',
        status: 'FAILURE',
        aiRecordDetail: {
          resultObject: {
            code: 'PIAPI_TASK_RESPONSE_ERROR',
            message: 'The piapi service is busy',
          },
        },
      },
    };
    const success = { aiRecord: { uuid: 'u3', status: 'SUCCESS' } };

    expect(isPendingStatusResponse(processing)).toBe(true);
    expect(isFailedResponse(processing)).toBe(false);

    expect(isPendingStatusResponse(failure)).toBe(false);
    expect(isFailedResponse(failure)).toBe(true);
    expect(extractFailureMessage(failure)).toBe('The piapi service is busy');

    expect(isPendingStatusResponse(success)).toBe(false);
    expect(isFailedResponse(success)).toBe(false);
  });

  test('normalizeOneMinJobStatus handles PROCESSING, SUCCESS with temporaryUrl, FAILURE, and null aiRecord', () => {
    expect(
      normalizeOneMinJobStatus({ aiRecord: { uuid: 'j1', status: 'PROCESSING' } }, 'j1', 'video'),
    ).toMatchObject({
      status: 'pending',
      jobId: 'j1',
      provider: '1min',
      kind: 'video',
      urls: [],
    });

    expect(
      normalizeOneMinJobStatus(
        {
          aiRecord: {
            uuid: 'j2',
            status: 'SUCCESS',
            temporaryUrl: 'https://storage.1min.ai/videos/out.mp4?sig=abc',
            aiRecordDetail: { resultObject: ['videos/out.mp4'] },
          },
        },
        'j2',
        'video',
      ),
    ).toMatchObject({
      status: 'completed',
      urls: ['https://storage.1min.ai/videos/out.mp4?sig=abc'],
      temporaryUrl: 'https://storage.1min.ai/videos/out.mp4?sig=abc',
    });

    expect(() => normalizeOneMinJobStatus({ aiRecord: null }, 'missing-id', 'image')).toThrow(
      'Job missing-id not found',
    );
  });

  test('shouldUseOneMinOpenAiCompat routes eligible models and respects webSearch and size limits', () => {
    expect(
      shouldUseOneMinOpenAiCompat({
        model: 'gpt-4.1-mini',
        webSearch: false,
        prompt: 'hello',
      }),
    ).toBe(true);

    expect(
      shouldUseOneMinOpenAiCompat({
        model: 'claude-sonnet-4-6',
        webSearch: false,
        prompt: 'hello',
      }),
    ).toBe(false);

    expect(
      shouldUseOneMinOpenAiCompat({
        model: 'gpt-4.1-mini',
        webSearch: true,
        prompt: 'hello',
      }),
    ).toBe(false);

    expect(
      shouldUseOneMinOpenAiCompat({
        model: 'gpt-4.1-mini',
        webSearch: false,
        prompt: 'x'.repeat(100_001),
      }),
    ).toBe(false);
  });

  test('buildOneMinOpenAiChatPayload clamps max_completion_tokens and preserves messages', () => {
    expect(supportsSamplingControls('o3-mini')).toBe(false);
    expect(supportsSamplingControls('gpt-5')).toBe(false);
    expect(supportsSamplingControls('deepseek-flash')).toBe(false);
    expect(supportsSamplingControls('glm-5')).toBe(false);
    expect(supportsSamplingControls('gpt-4.1-mini')).toBe(true);

    const payload = buildOneMinOpenAiChatPayload({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'usr' },
      ],
      maxTokens: 32000,
    });
    expect(payload.max_completion_tokens).toBe(16384);
    expect(payload.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  test('buildOneMinVideoPayload adapts parameters per model family (Kling, Veo3, Sora, Wan)', () => {
    const kling = buildOneMinVideoPayload({
      model: 'kling',
      prompt: 'cyberpunk street',
      aspect_ratio: '16:9',
      duration: 5,
    });
    expect(kling).toMatchObject({
      type: 'TEXT_TO_VIDEO',
      async: true,
      promptObject: { prompt: 'cyberpunk street', duration: 5, mode: 'std', version: '1.0' },
    });

    const klingI2V = buildOneMinVideoPayload({
      model: 'kling',
      prompt: 'animate',
      imageUrl: 'https://asset.1min.ai/images/src.png',
    });
    expect(klingI2V.type).toBe('IMAGE_TO_VIDEO');
    expect(klingI2V.promptObject.imageUrl).toBe('images/src.png');

    const veo3 = buildOneMinVideoPayload({
      model: 'veo3-video',
      prompt: 'eagle soaring',
      resolution: '1080p',
      audio: true,
    });
    expect(veo3.promptObject).toMatchObject({
      veo3_duration: '8s',
      resolution: '1080p',
      generate_audio: true,
    });

    const sora = buildOneMinVideoPayload({
      model: 'sora-2-pro',
      prompt: 'kite',
      aspect_ratio: '9:16',
      resolution: '1080p',
      duration: 8,
    });
    expect(sora.promptObject).toMatchObject({ seconds: 8, size: '1024x1792' });

    const wan = buildOneMinVideoPayload({
      model: 'wan3.0-video',
      prompt: 'river',
      resolution: '720p',
      aspect_ratio: '16:9',
    });
    expect(wan.promptObject).toMatchObject({ resolution: '720P', ratio: '16:9', audio: true });
  });
});
