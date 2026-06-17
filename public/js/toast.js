/**
 * Toast notification system
 * Replaces native alert() with styled notifications
 */

const toastContainer = document.createElement('div');
toastContainer.id = 'toast-container';
toastContainer.setAttribute('role', 'alert');
toastContainer.setAttribute('aria-live', 'polite');
document.body.appendChild(toastContainer);

const toastStyles = document.createElement('style');
const cspNonce = document.querySelector('meta[name="csp-nonce"]')?.content;
if (cspNonce) toastStyles.nonce = cspNonce;
toastStyles.textContent = `
  #toast-container {
    position: fixed;
    top: 20px;
    right: 20px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 10px;
    pointer-events: none;
  }

  .toast {
    min-width: 280px;
    max-width: 420px;
    padding: 14px 18px;
    border-radius: 14px;
    background: rgba(15, 23, 42, 0.95);
    backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255, 255, 255, 0.05);
    color: #fff;
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.5;
    display: flex;
    align-items: flex-start;
    gap: 12px;
    pointer-events: auto;
    animation: toast-in 0.3s cubic-bezier(0.22, 1, 0.36, 1);
    cursor: default;
    transition: all 0.2s ease;
  }

  .toast:hover {
    transform: translateY(-2px);
    box-shadow: 0 24px 50px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.08);
  }

  .toast.removing {
    animation: toast-out 0.25s cubic-bezier(0.22, 1, 0.36, 1) forwards;
  }

  .toast-icon {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .toast-content {
    flex: 1;
    word-break: break-word;
  }

  .toast-close {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.05);
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.5);
    cursor: pointer;
    transition: all 0.2s ease;
    padding: 0;
  }

  .toast-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: #fff;
  }

  /* Toast types */
  .toast-success {
    border-left: 3px solid #10b981;
  }
  .toast-success .toast-icon { color: #10b981; }

  .toast-error {
    border-left: 3px solid #ef4444;
  }
  .toast-error .toast-icon { color: #ef4444; }

  .toast-warning {
    border-left: 3px solid #f59e0b;
  }
  .toast-warning .toast-icon { color: #f59e0b; }

  .toast-info {
    border-left: 3px solid #3b82f6;
  }
  .toast-info .toast-icon { color: #3b82f6; }

  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateX(100%) scale(0.9);
    }
    to {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
  }

  @keyframes toast-out {
    from {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
    to {
      opacity: 0;
      transform: translateX(100%) scale(0.9);
    }
  }

  @media (max-width: 480px) {
    #toast-container {
      top: auto;
      bottom: 80px;
      right: 10px;
      left: 10px;
    }
    
    .toast {
      min-width: auto;
      max-width: none;
    }
  }
`;
document.head.appendChild(toastStyles);

const ICONS = {
    success: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    error: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    warning: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    info: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`,
};

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {Object} options - Configuration options
 * @param {string} options.type - Toast type: 'success', 'error', 'warning', 'info'
 * @param {number} options.duration - Duration in ms (0 = no auto-dismiss)
 * @param {boolean} options.dismissible - Whether to show close button
 */
function showToast(message, options = {}) {
    const {
        type = 'info',
        duration = 5000,
        dismissible = true,
    } = options;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'alert');

    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.innerHTML = ICONS[type] || ICONS.info;

    const content = document.createElement('div');
    content.className = 'toast-content';
    content.textContent = message;

    toast.appendChild(icon);
    toast.appendChild(content);

    if (dismissible) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'toast-close';
        closeBtn.setAttribute('aria-label', '閉じる');
        closeBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
        closeBtn.onclick = () => removeToast(toast);
        toast.appendChild(closeBtn);
    }

    toastContainer.appendChild(toast);

    // Auto-dismiss
    let dismissTimeout;
    if (duration > 0) {
        dismissTimeout = setTimeout(() => removeToast(toast), duration);
    }

    // Pause on hover
    toast.addEventListener('mouseenter', () => {
        if (dismissTimeout) clearTimeout(dismissTimeout);
    });

    toast.addEventListener('mouseleave', () => {
        if (duration > 0) {
            dismissTimeout = setTimeout(() => removeToast(toast), duration);
        }
    });

    return toast;
}

function removeToast(toast) {
    if (!toast || toast.classList.contains('removing')) return;

    toast.classList.add('removing');
    toast.addEventListener('animationend', () => {
        toast.remove();
    });
}

/**
 * Show success toast
 */
function toastSuccess(message, options = {}) {
    return showToast(message, { ...options, type: 'success' });
}

/**
 * Show error toast
 */
function toastError(message, options = {}) {
    return showToast(message, { ...options, type: 'error', duration: 8000 });
}

/**
 * Show warning toast
 */
function toastWarning(message, options = {}) {
    return showToast(message, { ...options, type: 'warning' });
}

/**
 * Show info toast
 */
function toastInfo(message, options = {}) {
    return showToast(message, { ...options, type: 'info' });
}

/**
 * Confirm dialog replacement (returns Promise)
 */
function toastConfirm(message, options = {}) {
    return new Promise((resolve) => {
        const {
            confirmText = '確認',
            cancelText = 'キャンセル',
            type = 'warning',
        } = options;

        const toast = document.createElement('div');
        toast.className = `toast toast-${type} toast--confirm`;

        const content = document.createElement('div');
        content.className = 'toast-content';
        content.textContent = message;

        const actions = document.createElement('div');
        actions.className = 'toast-actions';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'toast-btn toast-btn--cancel';
        cancelBtn.textContent = cancelText;
        cancelBtn.onclick = () => {
            removeToast(toast);
            resolve(false);
        };

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'toast-btn toast-btn--confirm';
        confirmBtn.textContent = confirmText;
        confirmBtn.onclick = () => {
            removeToast(toast);
            resolve(true);
        };

        actions.appendChild(cancelBtn);
        actions.appendChild(confirmBtn);

        toast.appendChild(content);
        toast.appendChild(actions);

        toastContainer.appendChild(toast);

        // Escape key to cancel
        const onKey = (e) => {
          if (e.key === 'Escape') {
            document.removeEventListener('keydown', onKey);
            removeToast(toast);
            resolve(false);
          }
        };
        document.addEventListener('keydown', onKey);
    });
}

// Export for use in other modules
window.toast = {
    show: showToast,
    success: toastSuccess,
    error: toastError,
    warning: toastWarning,
    info: toastInfo,
    confirm: toastConfirm,
};
