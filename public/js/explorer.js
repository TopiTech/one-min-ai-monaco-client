import { api } from './api.js';
import { toast } from './toast.js';
import { t } from './i18n.js';

export function createExplorerManager(dom, openFileCallback) {
  async function loadWorkspace(dirPath = null) {
    try {
      const tree = dom.fileTree;
      tree.textContent = '';
      // skeleton nodes with createElement
      for (let i = 0; i < 6; i++) {
        const skeleton = document.createElement('div');
        skeleton.className = 'skeleton-node';
        const icon = document.createElement('div');
        icon.className = 'skeleton skeleton-icon';
        const line = document.createElement('div');
        line.className = 'skeleton skeleton-line w-75';
        skeleton.appendChild(icon);
        skeleton.appendChild(line);
        tree.appendChild(skeleton);
      }

      const data = await api(`/api/fs/list${dirPath ? `?dir=${encodeURIComponent(dirPath)}` : ''}`);
      dom.explorerPath.value = data.dir;
      tree.textContent = '';
      await renderTreeNodes(data.items, tree, 0);
    } catch (e) {
      toast.error(t('workspace_load_failed', { error: e.message }));
    }
  }

  async function renderTreeNodes(items, container, depth = 0) {
    for (const item of items) {
      const node = document.createElement('div');
      node.className = `tree-node ${item.isDirectory ? 'folder' : 'file'}`;
      node.dataset.path = item.path;
      node.dataset.depth = depth;
      node.setAttribute('role', 'treeitem');
      node.setAttribute('tabindex', '0');
      if (item.isDirectory) {
        node.setAttribute('aria-expanded', 'false');
      }

      const toggle = document.createElement('span');
      toggle.className = 'node-toggle';
      if (item.isDirectory) {
        toggle.innerHTML = `<svg role="img" aria-label="toggle" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      }
      node.appendChild(toggle);

      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.textContent = item.isDirectory ? '📁' : '📄';
      node.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'node-name';
      name.textContent = item.name;
      node.appendChild(name);

      container.appendChild(node);

      if (item.isDirectory) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'tree-children';
        childrenContainer.setAttribute('role', 'group');
        container.appendChild(childrenContainer);

        node.onclick = async (e) => {
          e.stopPropagation();
          const isExpanded = node.classList.toggle('expanded');
          node.setAttribute('aria-expanded', String(isExpanded));
          if (isExpanded) {
            childrenContainer.classList.add('is-expanded');
            toggle.classList.add('expanded');
            if (childrenContainer.childElementCount === 0) {
              try {
                const res = await api(`/api/fs/list?dir=${encodeURIComponent(item.path)}`);
                await renderTreeNodes(res.items, childrenContainer, depth + 1);
              } catch (err) {
                console.error(err);
              }
            }
          } else {
            childrenContainer.classList.remove('is-expanded');
            toggle.classList.remove('expanded');
          }
        };
      } else {
        node.onclick = (e) => {
          e.stopPropagation();
          openFileCallback(item.path);
        };
      }

      node.onkeydown = async (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          node.click();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const next = getNextVisibleNode(node);
          if (next) next.focus();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          const prev = getPrevVisibleNode(node);
          if (prev) prev.focus();
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          if (item.isDirectory) {
            if (!node.classList.contains('expanded')) {
              node.click();
            } else {
              const group = node.nextElementSibling;
              if (group && group.classList.contains('tree-children')) {
                const firstChild = group.querySelector('.tree-node');
                if (firstChild) firstChild.focus();
              }
            }
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (item.isDirectory && node.classList.contains('expanded')) {
            node.click();
          } else {
            const group = node.parentElement;
            if (group && group.classList.contains('tree-children')) {
              const parentNode = group.previousElementSibling;
              if (parentNode && parentNode.classList.contains('tree-node')) {
                parentNode.focus();
              }
            }
          }
        }
      };
    }
  }

  function getVisibleNodes() {
    const tree = dom.fileTree;
    if (!tree) return [];
    return Array.from(tree.querySelectorAll('.tree-node')).filter((n) => {
      let parentGroup = n.parentElement;
      while (parentGroup && parentGroup !== tree) {
        if (
          parentGroup.classList.contains('tree-children') &&
          !parentGroup.classList.contains('is-expanded')
        ) {
          return false;
        }
        parentGroup = parentGroup.parentElement;
      }
      return true;
    });
  }

  function getNextVisibleNode(node) {
    const visible = getVisibleNodes();
    const idx = visible.indexOf(node);
    if (idx !== -1 && idx < visible.length - 1) {
      return visible[idx + 1];
    }
    return null;
  }

  function getPrevVisibleNode(node) {
    const visible = getVisibleNodes();
    const idx = visible.indexOf(node);
    if (idx > 0) {
      return visible[idx - 1];
    }
    return null;
  }

  return {
    loadWorkspace,
  };
}
