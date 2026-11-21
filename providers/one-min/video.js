import { extractAssetKey } from '../../utils/asset-utils.js';
import { serverConfig } from '../../config/server.js';

/**
 * Maps generic aspect_ratio / resolution pairs into Sora 2 supported WxH sizes.
 * @param {string} [aspectRatio]
 * @param {string} [resolution]
 * @returns {string}
 */
function mapAspectToSoraSize(aspectRatio, resolution) {
  const isHd = String(resolution || '').toLowerCase() === '1080p';
  if (aspectRatio === '9:16') {
    return isHd ? '1024x1792' : '720x1280';
  }
  return isHd ? '1792x1024' : '1280x720';
}

/**
 * Normalizes a VideoRequest into a 1min.ai /api/features payload for
 * TEXT_TO_VIDEO or IMAGE_TO_VIDEO depending on whether `imageUrl` is provided.
 *
 * Different 1min.ai video model families (kling, veo3, sora, wan) expect
 * distinct parameter names inside `promptObject`.
 *
 * @param {object} params
 * @param {string} [params.model]
 * @param {string} [params.prompt]
 * @param {string} [params.imageUrl]
 * @param {string} [params.aspect_ratio]
 * @param {number} [params.duration]
 * @param {string} [params.resolution]
 * @param {boolean} [params.audio]
 * @param {string} [params.negativePrompt]
 * @param {string} [params.mode]
 * @param {string} [params.version]
 */
export function buildOneMinVideoPayload({
  model,
  prompt = '',
  imageUrl,
  aspect_ratio = '16:9',
  duration = 5,
  resolution = '720p',
  audio = true,
  negativePrompt,
  mode,
  version,
}) {
  const selectedModel = model || serverConfig.defaultVideoModel || 'kling';
  const lowerModel = selectedModel.toLowerCase();
  const assetKey = imageUrl ? extractAssetKey(imageUrl) : '';
  const type = assetKey ? 'IMAGE_TO_VIDEO' : 'TEXT_TO_VIDEO';

  /** @type {Record<string, any>} */
  let promptObject;

  if (lowerModel.startsWith('kling')) {
    const selectedVersion = version || (assetKey ? '2.0' : '1.0');
    const isV3 = selectedVersion.startsWith('3.0');
    const isOmni = selectedVersion === '3.0-omni';
    const numericDuration = Number(duration) || 5;
    const validDuration = isV3
      ? Math.min(Math.max(Math.round(numericDuration), 3), 15)
      : numericDuration >= 8
        ? 10
        : 5;
    const resolvedMode = mode || (selectedVersion === '2.0' || selectedVersion === '2.5' ? 'pro' : 'std');

    promptObject = {
      ...(prompt ? { prompt } : {}),
      duration: validDuration,
      aspect_ratio: aspect_ratio || '16:9',
      version: selectedVersion,
      ...(isOmni ? { resolution: String(resolution || '720p').toLowerCase() } : { mode: resolvedMode }),
      ...(isV3 && audio !== undefined ? { enable_audio: Boolean(audio) } : {}),
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(assetKey ? { imageUrl: assetKey } : {}),
    };
  } else if (lowerModel.startsWith('veo3')) {
    promptObject = {
      prompt: prompt || 'Animate this scene smoothly',
      aspect_ratio: aspect_ratio || '16:9',
      veo3_duration: '8s',
      resolution: String(resolution || '720p').toLowerCase() === '1080p' ? '1080p' : '720p',
      generate_audio: Boolean(audio),
      ...(negativePrompt ? { negativePrompt } : {}),
      ...(assetKey ? { imageUrl: assetKey } : {}),
    };
  } else if (lowerModel.startsWith('sora')) {
    const d = Number(duration) || 8;
    const seconds = d <= 4 ? 4 : d <= 8 ? 8 : 12;
    const effectiveResolution = lowerModel.includes('pro') ? resolution : '720p';
    promptObject = {
      prompt: prompt || 'Animate this scene smoothly',
      seconds,
      size: mapAspectToSoraSize(aspect_ratio, effectiveResolution),
      ...(assetKey ? { reference_image_path: assetKey } : {}),
    };
  } else if (lowerModel.startsWith('wan')) {
    const resUpper = String(resolution || '720P').toUpperCase();
    const validRes = ['480P', '720P', '1080P'].includes(resUpper) ? resUpper : '720P';
    const numericDuration = Math.min(Math.max(Math.round(Number(duration) || 5), 2), 30);
    promptObject = {
      prompt: prompt || 'Animate this scene smoothly',
      duration: numericDuration,
      ratio: aspect_ratio || '16:9',
      resolution: validRes,
      audio: Boolean(audio),
      ...(assetKey ? { imageUrl: assetKey } : {}),
    };
  } else {
    promptObject = {
      ...(prompt ? { prompt } : {}),
      duration: Number(duration) || 5,
      aspect_ratio: aspect_ratio || '16:9',
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(assetKey ? { imageUrl: assetKey } : {}),
    };
  }

  return {
    type,
    model: selectedModel,
    conversationId: type,
    async: true,
    promptObject,
  };
}
