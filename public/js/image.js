/**
 * Image generation and editing module
 */

import { api, assetUrl, extractImages } from './api.js';
import { injectStyle } from './dom-style.js';
import { getAllImageModels } from './models.js';

const MAX_CARDS = 50;

export function createImageState() {
  return {};
}

export function createImageManager(dom) {
  function pruneImageGallery() {
    const gallery = dom.imageGallery;
    if (!gallery) return;
    while (gallery.children.length > MAX_CARDS) {
      gallery.removeChild(gallery.lastChild);
    }
  }

  function renderImages(data, sourceImageUrl = null) {
    const images = extractImages(data);
    const gallery = dom.imageGallery;
    if (!gallery) return;

    if (!images.length) {
      const pre = document.createElement('pre');
      pre.className = 'json';
      pre.textContent = JSON.stringify(data, null, 2);
      gallery.prepend(pre);
      return;
    }

    const existingCards = new Map();
    gallery.querySelectorAll('.imageCard').forEach((card) => {
      const imgEl = card.querySelector('img:not(.image-before)');
      const link = card.querySelector('a');
      const key = (imgEl && imgEl.src) || (link && link.href) || '';
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
        range.setAttribute('aria-label', '画像比較スライダー');
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

        injectStyle(
          `.${cmpId} .image-before { clip-path: polygon(0 0, 50% 0, 50% 100%, 0 100%); } ` +
            `.${cmpId} .slider-divider { left: 50%; }`,
        );

        range.addEventListener('input', (e) => {
          const val = e.target.value;
          injectStyle(
            `.${cmpId} .image-before { clip-path: polygon(0 0, ${val}% 0, ${val}% 100%, 0 100%); } ` +
              `.${cmpId} .slider-divider { left: ${val}%; }`,
          );
        });
        card.appendChild(slider);
      } else {
        const imgEl = document.createElement('img');
        imgEl.src = url;
        imgEl.alt = 'AI生成画像';
        imgEl.onerror = function () {
          this.classList.add('is-error-hidden');
          const errorSpan = document.createElement('span');
          errorSpan.className = 'img-error-placeholder';
          errorSpan.textContent = '⚠️ 画像の読み込みに失敗しました';
          this.after(errorSpan);
        };
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
        modelLabel.textContent = `編集モデル: ${modelName}`;
        modelLabel.className = 'image-card-model';
        infoRow.appendChild(modelLabel);
      }

      card.appendChild(infoRow);
      gallery.prepend(card);
    }

    existingCards.forEach((card, url) => {
      if (!newUrls.has(url)) card.remove();
    });

    pruneImageGallery();
  }

  async function generateImage() {
    const imageUrl = dom.editorImageUrl.value.trim();
    const prompt = dom.imagePrompt.value.trim();
    const model = dom.imageModel.value;

    if (!prompt) {
      if (typeof toast !== 'undefined') {
        toast.warning('プロンプトを入力してください');
      }
      return;
    }

    const isEditMode = !!imageUrl;

    try {
      let data;
      if (isEditMode) {
        data = await api('/api/images/text-editor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            imageUrl,
            prompt,
            model,
            size: document.getElementById('editorSize').value.trim(),
            quality: document.getElementById('editorQuality').value,
            n: document.getElementById('editorN').value,
            background: document.getElementById('editorBackground').value,
            output_format: document.getElementById('editorOutputFormat').value,
            output_compression: document.getElementById('editorOutputCompression').value || undefined,
          }),
        });
        if (typeof toast !== 'undefined') {
          toast.success('画像を編集しました');
        }
        dom.assetResult.textContent = JSON.stringify(data, null, 2);
        renderImages(data, imageUrl);
      } else {
        data = await api('/api/images/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            model,
            num_outputs: document.getElementById('numOutputs').value,
            aspect_ratio: document.getElementById('aspectRatio').value,
          }),
        });
        if (typeof toast !== 'undefined') {
          toast.success('画像を生成しました');
        }
        dom.assetResult.textContent = JSON.stringify(data, null, 2);
        renderImages(data);
      }
    } catch (e) {
      if (typeof toast !== 'undefined') {
        toast.error(`処理に失敗しました: ${e.message}`);
      }
    }
  }

  async function performAssetUpload(file, onStatusChange) {
    if (!file) return;
    const generateBtn = dom.generateImage;
    const assetInput = document.getElementById('assetInput');

    if (generateBtn) generateBtn.disabled = true;
    if (assetInput) assetInput.disabled = true;
    if (onStatusChange) onStatusChange('アップロード中...', 'warn');

    const fd = new FormData();
    fd.append('asset', file);
    try {
      const data = await api('/api/assets/upload', { method: 'POST', body: fd });
      dom.assetResult.textContent = JSON.stringify(data, null, 2);
      const key = data?.key || data?.asset?.key || data?.fileContent?.path || data?.asset?.location || '';
      const url = data?.url || (key ? assetUrl(key) : '');
      if (key) {
        dom.editorImageUrl.value = url || key;
        updateEditorImagePreview(url || key);
      }
      if (typeof toast !== 'undefined') {
        toast.success('アップロード完了');
      }
    } catch (e) {
      if (typeof toast !== 'undefined') {
        toast.error(`アセットのアップロードに失敗しました: ${e.message}`);
      }
    } finally {
      if (generateBtn) generateBtn.disabled = false;
      if (assetInput) assetInput.disabled = false;
      if (onStatusChange) onStatusChange('準備完了', 'ok');
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

    const currentModelId = dom.imageModel.value;
    const modelObj = getAllImageModels().find((m) => m.id === currentModelId) || null;

    if (!value) {
      if (preview) preview.classList.remove('is-shown');
      if (clearBtn) clearBtn.classList.remove('is-shown');
      if (imgToImgParams) imgToImgParams.classList.remove('is-shown');
      if (textToImgParams) textToImgParams.classList.remove('is-hidden');
      if (btnText) btnText.textContent = '画像を生成';

      if (modelObj && modelObj.tags && modelObj.tags.includes('editor') && !modelObj.tags.includes('image')) {
        const defaultGen = getAllImageModels().find(
          (m) => !m.tags || !m.tags.includes('editor') || m.id.startsWith('gpt-image'),
        ) || { id: 'gpt-image-2', label: 'GPT Image 2' };
        dom.imageModel.value = defaultGen.id;
        dom.imageModelLabel.textContent = defaultGen.label;
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
    if (btnText) btnText.textContent = '画像を編集';

    const isEditorModel = modelObj && modelObj.tags && modelObj.tags.includes('editor');
    if (!isEditorModel) {
      const defaultEditor = getAllImageModels().find((m) => m.tags && m.tags.includes('editor')) || {
        id: 'gpt-image-2',
        label: 'GPT Image 2',
      };
      dom.imageModel.value = defaultEditor.id;
      dom.imageModelLabel.textContent = defaultEditor.label;
    }
  }

  function clearImage() {
    dom.editorImageUrl.value = '';
    document.getElementById('assetInput').value = '';
    updateEditorImagePreview();
  }

  return {
    renderImages,
    generateImage,
    performAssetUpload,
    updateEditorImagePreview,
    clearImage,
    pruneImageGallery,
  };
}
