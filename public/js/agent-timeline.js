/**
 * Agent timeline rendering module.
 *
 * Extracted from app.js to isolate the DOM-heavy timeline step/approval
 * card creation logic. All functions accept their dependencies (dom, t,
 * appendStepIcon, renderMarkdownSafely) via the factory parameter.
 */

import { appendStepIcon, renderMarkdownSafely } from './utils.js';
import { t } from './i18n.js';

/**
 * Create an agent timeline factory bound to a specific log container.
 * @param {{ agentActivityLog: HTMLElement|null }} dom
 */
export function createAgentTimeline(dom) {
  function toggleTimelineResult(stepId) {
    const box = document.getElementById(`result-${stepId}`);
    if (!box) return;
    const toggle = box.previousElementSibling;
    const toggleSpan = toggle.querySelector('span');
    const willBeHidden = !box.classList.contains('u-hidden');
    box.classList.toggle('u-hidden', willBeHidden);
    if (toggleSpan) {
      toggleSpan.textContent = willBeHidden ? t('show_output') : t('hide_output');
    }
  }

  function addStep(type, title, body, resultText = null) {
    const log = dom.agentActivityLog;
    if (!log) return;

    const placeholder = log.querySelector('.timeline-placeholder');
    if (placeholder) placeholder.remove();

    const stepId = 'step-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

    const step = document.createElement('div');
    step.className = `agent-step ${type}`;
    step.id = stepId;

    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const card = document.createElement('div');
    card.className = 'agent-step-card';

    const header = document.createElement('div');
    header.className = 'agent-step-header';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'agent-step-icon';
    appendStepIcon(iconSpan, type);
    iconSpan.appendChild(document.createTextNode(title));
    header.appendChild(iconSpan);

    const timeSpan = document.createElement('span');
    timeSpan.className = 'agent-step-time';
    timeSpan.textContent = time;
    header.appendChild(timeSpan);

    card.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'agent-step-body';

    const isLongThought = type === 'thought' && body && body.length > 100;
    if (isLongThought) {
      const toggleDiv = document.createElement('div');
      toggleDiv.className = 'agent-step-thought-toggle';
      const toggleSpan = document.createElement('span');
      toggleSpan.textContent = t('thought_expand');
      toggleDiv.appendChild(toggleSpan);

      const thoughtBox = document.createElement('div');
      thoughtBox.className = 'agent-step-thought-box u-hidden';
      thoughtBox.appendChild(bodyEl);

      toggleDiv.onclick = () => {
        const willBeHidden = !thoughtBox.classList.contains('u-hidden');
        thoughtBox.classList.toggle('u-hidden', willBeHidden);
        toggleSpan.textContent = willBeHidden ? t('thought_expand') : t('thought_collapse');
      };

      card.appendChild(toggleDiv);
      card.appendChild(thoughtBox);
    } else {
      card.appendChild(bodyEl);
    }

    if (resultText !== null) {
      const MAX_RESULT_VISIBLE = 10000;
      const isTruncated = resultText.length > MAX_RESULT_VISIBLE;
      const displayText = isTruncated
        ? resultText.slice(0, MAX_RESULT_VISIBLE) +
          `\n\n... [出力が ${(resultText.length - MAX_RESULT_VISIBLE).toLocaleString()} 文字を超過したため切り詰められました]`
        : resultText;

      const toggleDiv = document.createElement('div');
      toggleDiv.className = 'agent-step-result-toggle';
      const rToggleSpan = document.createElement('span');
      rToggleSpan.textContent = '▶ 実行出力を表示';
      toggleDiv.appendChild(rToggleSpan);
      if (isTruncated) {
        const warnSpan = document.createElement('span');
        warnSpan.className = 'result-truncated-badge';
        warnSpan.textContent = '切詰';
        toggleDiv.appendChild(warnSpan);
      }
      toggleDiv.onclick = () => toggleTimelineResult(stepId);
      card.appendChild(toggleDiv);

      const resultPre = document.createElement('pre');
      resultPre.id = 'result-' + stepId;
      resultPre.className = 'agent-step-result-box u-hidden';
      resultPre.textContent = displayText;
      card.appendChild(resultPre);
    }

    step.appendChild(card);
    if (bodyEl) {
      renderMarkdownSafely(bodyEl, body);
    }

    log.appendChild(step);
    log.scrollTop = log.scrollHeight;
    return stepId;
  }

  function addApprovalStep(command, cwd, approvalToken, onApprove, onReject) {
    const log = dom.agentActivityLog;
    if (!log) return;
    const placeholder = log.querySelector('.timeline-placeholder');
    if (placeholder) placeholder.remove();

    const stepId = 'step-approval-' + Date.now();

    const step = document.createElement('div');
    step.className = 'agent-step approval';
    step.id = stepId;
    step.setAttribute('role', 'alertdialog');
    step.setAttribute('aria-label', t('cmd_approval_label'));

    const time = new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const card = document.createElement('div');
    card.className = 'agent-step-card';

    const header = document.createElement('div');
    header.className = 'agent-step-header';

    const iconSpan = document.createElement('span');
    iconSpan.className = 'agent-step-icon';
    appendStepIcon(iconSpan, 'approval');
    iconSpan.appendChild(document.createTextNode(t('cmd_approval')));

    const timeSpan = document.createElement('span');
    timeSpan.className = 'agent-step-time';
    timeSpan.textContent = time;

    header.appendChild(iconSpan);
    header.appendChild(timeSpan);

    const body = document.createElement('div');
    body.className = 'agent-step-body';
    body.textContent = t('cmd_approval_desc');

    const details = document.createElement('div');
    details.className = 'approval-details';

    const cmdLabel = document.createElement('strong');
    cmdLabel.textContent = t('cmd_label');
    const cmdCode = document.createElement('code');
    cmdCode.textContent = command;

    const dirLabel = document.createElement('strong');
    dirLabel.textContent = t('cmd_dir_label');
    const dirCode = document.createElement('code');
    dirCode.textContent = cwd;

    details.appendChild(cmdLabel);
    details.appendChild(cmdCode);
    details.appendChild(document.createElement('br'));
    details.appendChild(dirLabel);
    details.appendChild(dirCode);

    const feedbackInput = document.createElement('input');
    feedbackInput.type = 'text';
    feedbackInput.id = `feedback-${stepId}`;
    feedbackInput.className = 'approval-feedback-input';
    feedbackInput.placeholder = t('cmd_reject_reason');

    const actions = document.createElement('div');
    actions.className = 'approval-actions';

    const approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'approval-btn approve';
    approveBtn.id = `approve-${stepId}`;
    approveBtn.textContent = t('btn_approve');

    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'approval-btn reject';
    rejectBtn.id = `reject-${stepId}`;
    rejectBtn.textContent = t('btn_reject');

    actions.appendChild(approveBtn);
    actions.appendChild(rejectBtn);

    body.appendChild(details);
    body.appendChild(feedbackInput);
    body.appendChild(actions);

    card.appendChild(header);
    card.appendChild(body);

    step.textContent = '';
    step.appendChild(card);

    log.appendChild(step);
    log.scrollTop = log.scrollHeight;

    // M-9: Fade out the approval step once it has been resolved.
    let finalized = false;
    const finalizeStep = () => {
      if (finalized) return;
      finalized = true;
      setTimeout(() => {
        step.classList.add('is-fading');
        setTimeout(() => {
          step.remove();
        }, 450);
      }, 1500);
    };
    // M-2: Expose finalizeStep on the step element so external flows
    // (reset, stop) can clean up pending approval cards.
    step.__finalizeApproval = finalizeStep;

    approveBtn.onclick = () => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      feedbackInput.disabled = true;
      approveBtn.textContent = t('btn_approved');
      approveBtn.classList.add('is-disabled');
      onApprove();
      finalizeStep();
    };

    rejectBtn.onclick = () => {
      approveBtn.disabled = true;
      rejectBtn.disabled = true;
      feedbackInput.disabled = true;
      rejectBtn.textContent = t('btn_rejected');
      rejectBtn.classList.add('is-disabled');
      const reason = feedbackInput.value.trim() || 'ユーザーによって却下されました';
      onReject(reason);
      finalizeStep();
    };
  }

  return { addStep, addApprovalStep, toggleTimelineResult };
}
