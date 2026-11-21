/**
 * Image and Video generation/editing module
 */

import { api, assetUrl, extractImages } from './api.js';
import { setCriticalStyle, removeCriticalStylesByPrefix } from './dom-style.js';
import { getAllImageModels, getAllVideoModels } from './model-picker.js';
import { getActiveProvider } from './settings.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

const MAX_CARDS = 50;
const JOB_POLL_INTERVAL_MS = 3000;
const JOB_POLL_MAX_MS = 10 * 60 * 1000;

let _lazyImageObserver = null;
function getLazyImageObserver() {
  if (_lazyImageObserver) return _lazyImageObserver;
  if (typeof IntersectionObserver === 'undefined') {
    return {
      observe: (el) => {
        if (el.dataset.src) {
          el.src = el.dataset.src;
          delete el.dataset.src;
        }
      },
    };
  }
  _lazyImageObserver = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        if (el.dataset && el.dataset.src) {
          el.src = el.dataset.src;
          delete el.dataset.src;
        }
        obs.unobserve(el);
      }
    },
    { rootMargin: '200px 0px', threshold: 0.01 },
  );
  return _lazyImageObserver;
}
const lazyImageObserver = getLazyImageObserver();

export function createImageState() {
  return {
    mediaMode: 'image',
  };
}

export function createImageManager(dom) {
  let _mediaMode = 'image';
  let _isGenerating = false;

  function removeCardCriticalStyles(card) {
    const cmpEl = card?.querySelector?.('.image-comparison-slider');
    if (!cmpEl) return;
    for (const cls of cmpEl.classList) {
      if (cls.startsWith('cmp-')) {
        removeCriticalStylesByPrefix(`.${cls} `);
      }
    }
  }

  function pruneImageGallery() {
    const gallery = dom.imageGallery;
    if (!gallery) return;
    while (gallery.children.length > MAX_CARDS) {
      const removed = gallery.lastChild;
      removeCardCriticalStyles(removed);
      gallery.removeChild(removed);
    }
  }

  function renderJsonFallback(gallery, data) {
    // Replace rather than append: repeated empty/unsupported responses used
    // to grow an unbounded stack of identical <pre> blocks.
    gallery.querySelector('pre.json')?.remove();
    const pre = document.createElement('pre');
    pre.className = 'json';
    pre.textContent = JSON.stringify(data, null, 2);
    gallery.prepend(pre);
    pruneImageGallery();
  }

  function setMediaMode(mode) {
    _mediaMode = mode === 'video' ? 'video' : 'image';
    const tabImage = document.getElementById('mediaTabImage');
    const tabVideo = document.getElementById('mediaTabVideo');
    const imageModelWrap = document.getElementById('imageModelPickerWrap');
    const videoModelWrap = document.getElementById('videoModelPickerWrap');
    const imageParamsBox = document.getElementById('imageParamsSection');
    const videoParamsBox = document.getElementById('videoParams');
    const btnText = document.getElementById('generateImageBtnText');

    tabImage?.classList.toggle('active', _mediaMode === 'image');
    tabImage?.setAttribute('aria-selected', String(_mediaMode === 'image'));
    tabVideo?.classList.toggle('active', _mediaMode === 'video');
    tabVideo?.setAttribute('aria-selected', String(_mediaMode === 'video'));

    imageModelWrap?.classList.toggle('u-hidden', _mediaMode === 'video');
    videoModelWrap?.classList.toggle('u-hidden', _mediaMode !== 'video');
    imageParamsBox?.classList.toggle('u-hidden', _mediaMode === 'video');
    videoParamsBox?.classList.toggle('u-hidden', _mediaMode !== 'video');

    if (btnText) {
      if (_mediaMode === 'video') {
        btnText.textContent = t('btn_generate_video');
      } else {
        const hasSource = Boolean(dom.editorImageUrl?.value?.trim());
        btnText.textContent = hasSource ? t('img_edit_btn') : t('img_generate_btn');
      }
    }
  }

  function initMediaModeTabs() {
    const tabImage = document.getElementById('mediaTabImage');
    const tabVideo = document.getElementById('mediaTabVideo');
    tabImage?.addEventListener('click', () => setMediaMode('image'));
    tabVideo?.addEventListener('click', () => setMediaMode('video'));
  }

  initMediaModeTabs();

  function renderVideos(data) {
    const urls = extractImages(data);
    const gallery = dom.imageGallery;
    if (!gallery) return;

    if (!urls.length) {
      renderJsonFallback(gallery, data);
      return;
    }

    for (const rawUrl of urls) {
      const proxied = assetUrl(rawUrl);
      const card = document.createElement('div');
      card.className = 'imageCard videoCard';

      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.className = 'generated-video';
      video.src = proxied;
      card.appendChild(video);

      const infoRow = document.createElement('div');
      infoRow.className = 'image-card-info';

      const link = document.createElement('a');
      link.href = proxied;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = rawUrl.length > 36 ? rawUrl.slice(0, 33) + '...' : rawUrl;
      link.title = rawUrl;
      link.className = 'image-card-link';
      infoRow.appendChild(link);

      const modelName = document.getElementById('videoModelLabel')?.textContent?.trim() || 'Video AI';
      const badge = document.createElement('span');
      badge.className = 'image-card-model';
      badge.textContent = modelName;
      infoRow.appendChild(badge);

      card.appendChild(infoRow);
      gallery.prepend(card);
    }

    pruneImageGallery();
  }

  function renderImages(data, sourceImageUrl = null) {
    const images = extractImages(data);
    const gallery = dom.imageGallery;
    if (!gallery) return;

    if (!images.length) {
      renderJsonFallback(gallery, data);
      return;
    }

    const existingCards = new Map();
    gallery.querySelectorAll('.imageCard').forEach((card) => {
      const imgEl = card.querySelector('img:not(.image-before)');
      const link = card.querySelector('a');
      // Compare the authored (relative/proxied) URLs. The .src/.href DOM
      // properties resolve to absolute URLs, while assetUrl() returns a
      // relative /api/assets/proxy URL — using the properties never matched
      // and recreated (or leaked comparison styles from) every card render.
      const key =
        (imgEl && (imgEl.getAttribute?.('src') || imgEl.dataset?.src)) ||
        (link && (link.getAttribute?.('href') || link.href)) ||
        '';
      if (key) existingCards.set(key, card);
    });

    const newUrls = new Set();
    for (const img of images) {
      const url = assetUrl(img);
      newUrls.add(url);

      if (existingCards.has(url)) continue;

      const card = document.createElement('div');
      card.className = 'imageCard';

      if (sourceImageUrl) {
        const sourceUrl = assetUrl(sourceImageUrl);
        const cmpId = `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const slider = document.createElement('div');
        slider.className = `image-comparison-slider ${cmpId}`;

        const afterImg = document.createElement('img');
        afterImg.src = url;
        afterImg.alt = 'After';
        afterImg.className = 'image-after';
        slider.appendChild(afterImg);

        const beforeImg = document.createElement('img');
        beforeImg.src = sourceUrl;
        beforeImg.alt = 'Before';
        beforeImg.className = 'image-before';
        slider.appendChild(beforeImg);

        const range = document.createElement('input');
        range.type = 'range';
        range.min = '0';
        range.max = '100';
        range.value = '50';
        range.className = 'slider-range';
        range.setAttribute('aria-label', t('img_compare_slider'));
        range.setAttribute('role', 'slider');
        range.setAttribute('tabindex', '0');
        range.addEventListener('keydown', (e) => {
          const step = e.shiftKey ? 10 : 5;
          let val = parseInt(range.value, 10);
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
            e.preventDefault();
            val = Math.max(0, val - step);
          } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
            e.preventDefault();
            val = Math.min(100, val + step);
          } else {
            return;
          }
          range.value = val;
          range.dispatchEvent(new Event('input', { bubbles: true }));
        });
        slider.appendChild(range);

        const divider = document.createElement('div');
        divider.className = 'slider-divider';
        const handle = document.createElement('div');
        handle.className = 'slider-handle';
        divider.appendChild(handle);
        slider.appendChild(divider);

        setCriticalStyle(
          `.${cmpId} .image-before { clip-path: polygon(0 0, 50% 0, 50% 100%, 0 100%); } ` +
            `.${cmpId} .slider-divider { left: 50%; }`,
        );

        let _sliderRaf = null;
        const applySlider = (val) => {
          setCriticalStyle(
            `.${cmpId} .image-before { clip-path: polygon(0 0, ${val}% 0, ${val}% 100%, 0 100%); } ` +
              `.${cmpId} .slider-divider { left: ${val}%; }`,
          );
        };
        range.addEventListener('input', (e) => {
          const val = e.target.value;
          if (_sliderRaf) cancelAnimationFrame(_sliderRaf);
          _sliderRaf = requestAnimationFrame(() => applySlider(val));
        });
        range.addEventListener('change', (e) => {
          if (_sliderRaf) {
            cancelAnimationFrame(_sliderRaf);
            _sliderRaf = null;
          }
          applySlider(e.target.value);
        });
        card.appendChild(slider);
      } else {
        const imgEl = document.createElement('img');
        imgEl.dataset.src = url;
        imgEl.alt = t('img_generated');
        imgEl.loading = 'lazy';
        imgEl.decoding = 'async';
        imgEl.classList.add('lazy-image');
        imgEl.onerror = function () {
          this.classList.add('is-error-hidden');
          const errorSpan = document.createElement('span');
          errorSpan.className = 'img-error-placeholder';
          errorSpan.textContent = t('img_load_failed');
          this.after(errorSpan);
        };
        lazyImageObserver.observe(imgEl);
        card.appendChild(imgEl);
      }

      const infoRow = document.createElement('div');
      infoRow.className = 'image-card-info';

      const link = document.createElement('a');
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = img.length > 30 ? img.slice(0, 27) + '...' : img;
      link.title = img;
      link.className = 'image-card-link';
      infoRow.appendChild(link);

      if (sourceImageUrl) {
        const modelName = document.getElementById('imageModelLabel')?.textContent?.trim() || 'AI Model';
        const modelLabel = document.createElement('span');
        modelLabel.textContent = t('img_edit_model', { model: modelName });
        modelLabel.className = 'image-card-model';
        infoRow.appendChild(modelLabel);
      }

      card.appendChild(infoRow);
      gallery.prepend(card);
    }

    existingCards.forEach((card, url) => {
      if (!newUrls.has(url)) {
        removeCardCriticalStyles(card);
        card.remove();
      }
    });

    pruneImageGallery();
  }

  async function pollJobUntilComplete({ provider, kind, jobId }) {
    const gallery = dom.imageGallery;
    const progressCard = document.createElement('div');
    progressCard.className = 'imageCard job-polling-card';

    const statusText = document.createElement('div');
    statusText.className = 'job-polling-status';
    statusText.textContent = t('job_polling_progress', { sec: 0 });
    progressCard.appendChild(statusText);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghost small';
    cancelBtn.textContent = t('btn_cancel');
    progressCard.appendChild(cancelBtn);

    if (gallery) {
      gallery.prepend(progressCard);
    }

    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      progressCard.remove();
    };

    const startedAt = Date.now();
    try {
      while (!cancelled) {
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        statusText.textContent = t('job_polling_progress', { sec: elapsedSec });

        if (Date.now() - startedAt > JOB_POLL_MAX_MS) {
          throw new Error(t('job_polling_timeout'));
        }

        await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
        if (cancelled) break;

        const job = await api(
          `/api/jobs/${encodeURIComponent(provider)}/${encodeURIComponent(kind)}/${encodeURIComponent(jobId)}`,
        );
        // The request may complete after the user pressed Cancel. Re-check
        // before acting on the payload so a cancelled job is not rendered.
        if (cancelled) break;
        if (dom.assetResult) {
          dom.assetResult.textContent = JSON.stringify(job, null, 2);
        }

        if (job.status === 'completed') {
          progressCard.remove();
          return job;
        }
        if (job.status === 'failed') {
          throw new Error(job.error || t('job_failed_generic'));
        }
      }
      throw new Error(t('job_cancelled'));
    } catch (err) {
      progressCard.remove();
      throw err;
    }
  }

  async function generateVideo() {
    if (_isGenerating) return;
    const imageUrl = dom.editorImageUrl?.value?.trim() || '';
    const prompt = dom.imagePrompt?.value?.trim() || '';
    const model = document.getElementById('videoModel')?.value || getAllVideoModels()[0]?.id || 'kling';
    const provider = getActiveProvider();

    if (!prompt && !imageUrl) {
      toast.warning(t('video_enter_prompt_or_image'));
      return;
    }

    const generateBtn = dom.generateImage;
    _isGenerating = true;
    if (generateBtn) generateBtn.disabled = true;

    try {
      let data = await api('/api/videos/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          prompt,
          imageUrl: imageUrl || undefined,
          model,
          aspect_ratio: document.getElementById('videoAspectRatio')?.value || '16:9',
          duration: Number(document.getElementById('videoDuration')?.value || 5),
          resolution: document.getElementById('videoResolution')?.value || '720p',
          audio: Boolean(document.getElementById('videoAudio')?.checked ?? true),
          negativePrompt: document.getElementById('videoNegativePrompt')?.value?.trim() || undefined,
        }),
      });
      if (dom.assetResult) dom.assetResult.textContent = JSON.stringify(data, null, 2);

      const jobId = data?.jobId || data?.code_ref || data?.aiRecord?.uuid;
      const isPending =
        String(data?.status || data?.aiRecord?.status || '').toUpperCase() === 'PROCESSING' ||
        (jobId && extractImages(data).length === 0);

      if (isPending && jobId) {
        toast.info(t('video_job_started'));
        data = await pollJobUntilComplete({ provider, kind: 'video', jobId });
      }

      toast.success(t('video_generated_toast'));
      if (dom.assetResult) dom.assetResult.textContent = JSON.stringify(data, null, 2);
      renderVideos(data);
    } catch (e) {
      toast.error(t('video_process_failed', { error: e.message }));
    } finally {
      _isGenerating = false;
      if (generateBtn) generateBtn.disabled = false;
    }
  }

  async function generateImage() {
    if (_mediaMode === 'video') {
      return generateVideo();
    }
    if (_isGenerating) return;

    const imageUrl = dom.editorImageUrl?.value?.trim() || '';
    const prompt = dom.imagePrompt?.value?.trim() || '';
    const model = dom.imageModel?.value;
    const provider = getActiveProvider();

    if (!prompt) {
      toast.warning(t('img_enter_prompt'));
      return;
    }

    const isEditMode = !!imageUrl;
    const generateBtn = dom.generateImage;
    _isGenerating = true;
    if (generateBtn) generateBtn.disabled = true;

    try {
      let data;
      if (isEditMode) {
        data = await api('/api/images/text-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            imageUrl,
            prompt,
            model,
            size: document.getElementById('editorSize')?.value?.trim() || '1024x1024',
            quality: document.getElementById('editorQuality')?.value || 'medium',
            n: document.getElementById('editorN')?.value || '1',
            background: document.getElementById('editorBackground')?.value || 'auto',
            output_format: document.getElementById('editorOutputFormat')?.value || 'webp',
            output_compression: document.getElementById('editorOutputCompression')?.value || undefined,
          }),
        });
      } else {
        data = await api('/api/images/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider,
            prompt,
            model,
            num_outputs: document.getElementById('numOutputs')?.value || '1',
            aspect_ratio: document.getElementById('aspectRatio')?.value || '1:1',
          }),
        });
      }

      const jobId = data?.jobId || data?.code_ref || data?.aiRecord?.uuid;
      const isPending =
        String(data?.status || data?.aiRecord?.status || '').toUpperCase() === 'PROCESSING' ||
        (jobId && extractImages(data).length === 0 && provider === '1forall' && isEditMode);

      if (isPending && jobId) {
        data = await pollJobUntilComplete({ provider, kind: 'image', jobId });
      }

      toast.success(isEditMode ? t('img_edited') : t('img_generated_toast'));
      if (dom.assetResult) dom.assetResult.textContent = JSON.stringify(data, null, 2);
      renderImages(data, isEditMode ? imageUrl : null);
    } catch (e) {
      toast.error(t('img_process_failed', { error: e.message }));
    } finally {
      _isGenerating = false;
      if (generateBtn) generateBtn.disabled = false;
    }
  }

  async function performAssetUpload(file, onStatusChange) {
    if (!file) return;
    const generateBtn = dom.generateImage;
    const assetInput = document.getElementById('assetInput');
    const provider = getActiveProvider();

    if (generateBtn) generateBtn.disabled = true;
    if (assetInput) assetInput.disabled = true;
    if (onStatusChange) onStatusChange(t('img_upload_status'), 'warn');

    const fd = new FormData();
    fd.append('asset', file);
    try {
      const data = await api(`/api/assets/upload?provider=${encodeURIComponent(provider)}`, {
        method: 'POST',
        body: fd,
      });
      if (dom.assetResult) dom.assetResult.textContent = JSON.stringify(data, null, 2);
      const key = data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || '';
      const url = data?.url || (key ? assetUrl(key) : '');
      if (key || url) {
        const val = url || key;
        if (dom.editorImageUrl) dom.editorImageUrl.value = val;
        updateEditorImagePreview(val);
      }
      toast.success(t('img_upload_complete'));
    } catch (e) {
      toast.error(t('img_upload_failed', { error: e.message }));
    } finally {
      if (generateBtn) generateBtn.disabled = false;
      if (assetInput) assetInput.disabled = false;
      if (onStatusChange) onStatusChange(t('status_ready'), 'ok');
    }
  }

  function updateEditorImagePreview(imageUrl) {
    const input = dom.editorImageUrl;
    const preview = dom.editorImagePreview;
    const clearBtn = dom.clearImageBtn;
    const imgToImgParams = document.getElementById('imageToImageParams');
    const textToImgParams = document.getElementById('textToImageParams');
    const btnText = document.getElementById('generateImageBtnText');
    const value = (imageUrl || input?.value || '').trim();

    const currentModelId = dom.imageModel?.value;
    const modelObj = getAllImageModels().find((m) => m.id === currentModelId) || null;

    if (!value) {
      if (preview) preview.classList.remove('is-shown');
      if (clearBtn) clearBtn.classList.remove('is-shown');
      if (imgToImgParams) imgToImgParams.classList.remove('is-shown');
      if (textToImgParams) textToImgParams.classList.remove('is-hidden');
      if (btnText) {
        btnText.textContent = _mediaMode === 'video' ? t('btn_generate_video') : t('img_generate_btn');
      }

      if (
        modelObj &&
        modelObj.tags &&
        modelObj.tags.includes('editor') &&
        !modelObj.tags.includes('flagship') &&
        !modelObj.tags.includes('fast')
      ) {
        const defaultGen = getAllImageModels().find(
          (m) => m.tags && (m.tags.includes('flagship') || m.tags.includes('fast')),
        ) || { id: 'gpt-image-2', label: 'GPT Image 2' };
        if (dom.imageModel) dom.imageModel.value = defaultGen.id;
        if (dom.imageModelLabel) dom.imageModelLabel.textContent = defaultGen.label;
      }
      return;
    }

    if (preview) {
      preview.src = assetUrl(value);
      preview.classList.add('is-shown');
    }
    if (clearBtn) clearBtn.classList.add('is-shown');
    if (imgToImgParams) imgToImgParams.classList.add('is-shown');
    if (textToImgParams) textToImgParams.classList.add('is-hidden');
    if (btnText) {
      btnText.textContent = _mediaMode === 'video' ? t('btn_generate_video') : t('img_edit_btn');
    }

    const isEditorModel = modelObj && modelObj.tags && modelObj.tags.includes('editor');
    if (!isEditorModel) {
      const defaultEditor = getAllImageModels().find((m) => m.tags && m.tags.includes('editor'));
      if (defaultEditor) {
        if (dom.imageModel) dom.imageModel.value = defaultEditor.id;
        if (dom.imageModelLabel) dom.imageModelLabel.textContent = defaultEditor.label;
      }
    }
  }

  function clearImage() {
    if (dom.editorImageUrl) dom.editorImageUrl.value = '';
    const assetInput = document.getElementById('assetInput');
    if (assetInput) assetInput.value = '';
    updateEditorImagePreview();
  }

  return {
    renderImages,
    renderVideos,
    generateImage,
    generateVideo,
    setMediaMode,
    performAssetUpload,
    updateEditorImagePreview,
    clearImage,
    pruneImageGallery,
  };
}
