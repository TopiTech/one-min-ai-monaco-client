/**
 * Inline chat widget for Monaco Editor
 *
 * Provides a Copilot-style inline chat dialog that lets users prompt
 * the AI for code modifications at the cursor position.
 */

import { api } from './api.js';
import { t } from './i18n.js';
import { toast } from './toast.js';

const WIDGET_ID = 'inline.chat.widget';

/**
 * Create the inline chat content widget and its control functions.
 * @param {object} editorState - Reference to state.editor
 * @param {object} editorManager - The editor manager instance
 * @param {object} dom - DOM element references
 * @returns {{ widget: object, submit: () => Promise<void>, toggle: () => void, close: () => void }}
 */
export function createInlineChatManager(editorState, editorManager, dom) {
  let widgetDom = null;
  let isOpen = false;

  function getOrCreateDomNode() {
    if (widgetDom) return widgetDom;

    widgetDom = document.createElement('div');
    widgetDom.className = 'inline-chat-widget';
    widgetDom.setAttribute('role', 'dialog');
    widgetDom.setAttribute('aria-label', t('inline_chat_label'));

    const inputRow = document.createElement('div');
    inputRow.className = 'inline-chat-input-row';

    const promptInput = document.createElement('input');
    promptInput.type = 'text';
    promptInput.id = 'inlineChatPrompt';
    promptInput.placeholder = t('inline_chat_placeholder');
    promptInput.setAttribute('aria-label', t('inline_chat_prompt_label'));

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.id = 'inlineChatSubmit';
    submitBtn.textContent = t('btn_send');
    submitBtn.setAttribute('aria-label', t('btn_send'));

    inputRow.appendChild(promptInput);
    inputRow.appendChild(submitBtn);

    const statusDiv = document.createElement('div');
    statusDiv.id = 'inlineChatStatus';
    statusDiv.className = 'inline-chat-status';
    statusDiv.textContent = t('inline_chat_generating');
    statusDiv.setAttribute('role', 'status');
    statusDiv.setAttribute('aria-live', 'polite');

    widgetDom.appendChild(inputRow);
    widgetDom.appendChild(statusDiv);

    promptInput.onkeydown = async (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        await submitInlineChat();
      } else if (e.key === 'Escape') {
        closeInlineChat();
      }
    };

    submitBtn.onclick = async () => {
      await submitInlineChat();
    };

    return widgetDom;
  }

  const widget = {
    getId: () => WIDGET_ID,
    getDomNode: getOrCreateDomNode,
    getPosition: () => {
      const instance = editorManager.instance;
      if (!instance) return null;
      return {
        position: instance.getPosition(),
        preference: [
          monaco.editor.ContentWidgetPositionPreference.BELOW,
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
        ],
      };
    },
  };

  async function submitInlineChat() {
    if (!editorState.activeFilePath || !editorManager.instance) return;
    const domNode = getOrCreateDomNode();
    const input = domNode.querySelector('#inlineChatPrompt');
    const statusDiv = domNode.querySelector('#inlineChatStatus');
    const prompt = input.value.trim();
    if (!prompt) return;

    statusDiv.classList.add('is-shown');
    statusDiv.className = 'inline-chat-status is-shown loading';
    input.disabled = true;

    const code = editorManager.instance.getValue();
    const position = editorManager.instance.getPosition();
    const fileName = editorState.activeFilePath.split(/[\\/]/).pop();
    const language = editorManager.instance.getModel()?.getLanguageId() || 'plaintext';

    try {
      const data = await api('/api/code/inline-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt,
          code,
          line: position.lineNumber,
          column: position.column,
          fileName,
          language,
          model: dom.codeModel.value,
          webSearch: dom.codeWebSearch?.checked || false,
          numOfSite: dom.codeNumOfSite?.value ? parseInt(dom.codeNumOfSite.value) : undefined,
          maxWord: dom.codeMaxWord?.value ? parseInt(dom.codeMaxWord.value) : undefined,
        }),
      });

      if (data.code) {
        const accepted = await toast.confirm(t('inline_chat_apply_confirm'), {
          confirmText: t('btn_apply'),
          cancelText: t('btn_discard'),
          type: 'info',
        });

        if (accepted) {
          const range = new monaco.Range(
            position.lineNumber,
            position.column,
            position.lineNumber,
            position.column,
          );
          const id = { major: 1, minor: 1 };
          const op = { identifier: id, range, text: data.code, forceMoveMarkers: true };
          editorManager.instance.executeEdits('copilot-inline-chat', [op]);
          toast.success(t('inline_chat_applied'));
        } else {
          toast.info(t('inline_chat_discarded'));
        }
      }
    } catch (e) {
      toast.error(t('inline_chat_failed', { error: e.message }));
    } finally {
      statusDiv.classList.remove('is-shown', 'loading');
      statusDiv.className = 'inline-chat-status';
      input.disabled = false;
      input.value = '';
      closeInlineChat();
    }
  }

  function toggleInlineChat() {
    if (!editorState.activeFilePath) {
      toast.warning(t('inline_chat_no_file'));
      return;
    }
    if (isOpen) {
      closeInlineChat();
    } else {
      editorManager.instance.addContentWidget(widget);
      isOpen = true;
      setTimeout(() => {
        const input = getOrCreateDomNode().querySelector('#inlineChatPrompt');
        if (input) input.focus();
      }, 50);
    }
  }

  function closeInlineChat() {
    if (isOpen) {
      editorManager.instance.removeContentWidget(widget);
      isOpen = false;
      editorManager.instance.focus();
    }
  }

  editorState.inlineChatDom = getOrCreateDomNode();

  return { widget, submitInlineChat, toggleInlineChat, closeInlineChat };
}
