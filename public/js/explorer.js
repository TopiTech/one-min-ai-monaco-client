import { api } from './api.js';
import { toast } from './toast.js';
import { t } from './i18n.js';

export function createExplorerManager(dom, openFileCallback) {
  let _currentDir = null;
  let _allNodes = []; // flat list for search
  let _visibleNodesCache = null;

  function invalidateVisibleNodesCache() {
    _visibleNodesCache = null;
  }

  function debounce(fn, delay) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ─── Context menu ─────────────────────────────────────────
  let _ctxMenu = null;

  function _ensureContextMenu() {
    if (_ctxMenu) return _ctxMenu;
    _ctxMenu = document.createElement('div');
    _ctxMenu.className = 'tree-context-menu u-hidden';
    _ctxMenu.setAttribute('role', 'menu');
    document.body.appendChild(_ctxMenu);
    document.addEventListener('click', () => _hideContextMenu(), { capture: true });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') _hideContextMenu();
    });
    return _ctxMenu;
  }

  function _hideContextMenu() {
    if (_ctxMenu) _ctxMenu.classList.add('u-hidden');
  }

  function _showContextMenu(x, y, items) {
    const menu = _ensureContextMenu();
    menu.textContent = '';
    for (const item of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ctx-menu-item' + (item.danger ? ' danger' : '');
      btn.textContent = item.label;
      btn.onclick = () => {
        _hideContextMenu();
        item.action();
      };
      menu.appendChild(btn);
    }
    menu.classList.remove('u-hidden');
    const mw = 160,
      mh = items.length * 34 + 8;
    menu.style.left = Math.min(x, window.innerWidth - mw - 8) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  // ─── File search filter ────────────────────────────────────
  function _bindFileSearch() {
    const searchInput = document.getElementById('fileSearchInput');
    const clearBtn = document.getElementById('fileSearchClear');
    if (!searchInput) return;

    const debouncedFilter = debounce((q) => _applyFilter(q), 200);

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      clearBtn?.classList.toggle('u-hidden', !q);
      debouncedFilter(q);
    });

    clearBtn?.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.classList.add('u-hidden');
      _applyFilter('');
      searchInput.focus();
    });
  }

  function _applyFilter(query) {
    const tree = dom.fileTree;
    if (!tree) return;

    if (!query) {
      tree.querySelectorAll('.tree-node, .tree-children').forEach((el) => {
        el.style.display = '';
      });
      return;
    }

    tree.querySelectorAll('.tree-node').forEach((el) => {
      el.style.display = 'none';
    });
    tree.querySelectorAll('.tree-children').forEach((el) => {
      el.style.display = 'none';
    });

    tree.querySelectorAll('.tree-node.file').forEach((node) => {
      const name = (node.dataset.path || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
      if (name.includes(query)) {
        node.style.display = '';
        let parent = node.parentElement;
        while (parent && parent !== tree) {
          parent.style.display = '';
          parent = parent.parentElement;
        }
      }
    });

    invalidateVisibleNodesCache();
  }

  // ─── New file / folder ────────────────────────────────────
  async function createNewItem(type, baseDirOverride) {
    const basePath = baseDirOverride || _currentDir || dom.explorerPath?.value?.trim();
    if (!basePath) {
      toast.warning(t('explorer_no_folder'));
      return;
    }

    const label = type === 'directory' ? t('new_folder_prompt') : t('new_file_prompt');
    const defaultName = type === 'directory' ? 'new-folder' : 'new-file.js';
    const name = await toast.prompt(label, defaultName);
    if (!name || !name.trim()) return;

    const sep = basePath.includes('\\') ? '\\' : '/';
    const newPath = basePath.replace(/[\\/]+$/, '') + sep + name.trim().replace(/^[\\/]+/, '');

    try {
      await api('/api/fs/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath, type }),
      });
      toast.success(type === 'directory' ? t('folder_created') : t('file_created'));
      await loadWorkspace(_currentDir);
    } catch (e) {
      toast.error(t('create_failed', { error: e.message }));
    }
  }

  function _bindNewButtons() {
    document.getElementById('newFileBtn')?.addEventListener('click', () => createNewItem('file'));
    document.getElementById('newFolderBtn')?.addEventListener('click', () => createNewItem('directory'));
  }

  // ─── Rename ───────────────────────────────────────────────
  async function renameItem(filePath) {
    const currentName = filePath.replace(/\\/g, '/').split('/').pop();
    const newName = await toast.prompt(t('rename_prompt'), currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;

    const parts = filePath.replace(/\\/g, '/').split('/');
    parts[parts.length - 1] = newName.trim();
    const newPath = parts.join(filePath.includes('\\') ? '\\' : '/');

    try {
      await api('/api/fs/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPath: filePath, newPath }),
      });
      toast.success(t('rename_complete'));
      await loadWorkspace(_currentDir);
    } catch (e) {
      toast.error(t('rename_failed', { error: e.message }));
    }
  }

  // ─── Delete ───────────────────────────────────────────────
  async function deleteItem(filePath) {
    const name = filePath.replace(/\\/g, '/').split('/').pop();
    const confirmed = await toast.confirm(t('delete_confirm', { name }), {
      confirmText: t('btn_delete'),
      cancelText: t('btn_cancel'),
      type: 'warning',
    });
    if (!confirmed) return;

    try {
      await api('/api/fs/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }),
      });
      toast.success(t('delete_complete'));
      await loadWorkspace(_currentDir);
    } catch (e) {
      toast.error(t('delete_failed', { error: e.message }));
    }
  }

  // ─── Load workspace ───────────────────────────────────────
  async function loadWorkspace(dirPath = null) {
    try {
      _currentDir = dirPath;
      const tree = dom.fileTree;
      tree.textContent = '';
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
      _currentDir = data.dir;
      dom.explorerPath.value = data.dir;
      tree.textContent = '';
      _allNodes = [];
      await renderTreeNodes(data.items, tree, 0);
      invalidateVisibleNodesCache();
    } catch (e) {
      if (dom.fileTree) dom.fileTree.textContent = '';
      toast.error(t('workspace_load_failed', { error: e.message }));
    }
  }

  function _getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
      js: '🟨',
      ts: '🔷',
      jsx: '⚛️',
      tsx: '⚛️',
      py: '🐍',
      rb: '💎',
      go: '🐹',
      rs: '🦀',
      html: '🌐',
      css: '🎨',
      scss: '🎨',
      less: '🎨',
      json: '📋',
      yml: '📋',
      yaml: '📋',
      toml: '📋',
      md: '📝',
      txt: '📄',
      sh: '⚙️',
      bat: '⚙️',
      png: '🖼️',
      jpg: '🖼️',
      jpeg: '🖼️',
      gif: '🖼️',
      svg: '🖼️',
      webp: '🖼️',
      mp4: '🎬',
      mp3: '🎵',
      pdf: '📑',
      zip: '📦',
    };
    return map[ext] || '📄';
  }

  async function renderTreeNodes(items, container, depth = 0) {
    for (const item of items) {
      const node = document.createElement('div');
      node.className = `tree-node ${item.isDirectory ? 'folder' : 'file'}`;
      node.dataset.path = item.path;
      node.dataset.depth = depth;
      node.setAttribute('role', 'treeitem');
      node.setAttribute('tabindex', '0');
      if (item.isDirectory) node.setAttribute('aria-expanded', 'false');

      const toggle = document.createElement('span');
      toggle.className = 'node-toggle';
      if (item.isDirectory) {
        toggle.innerHTML = `<svg role="img" aria-label="toggle" xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
      }
      node.appendChild(toggle);

      const icon = document.createElement('span');
      icon.className = 'node-icon';
      icon.textContent = item.isDirectory ? '📁' : _getFileIcon(item.name);
      node.appendChild(icon);

      const name = document.createElement('span');
      name.className = 'node-name';
      name.textContent = item.name;
      node.appendChild(name);

      container.appendChild(node);
      _allNodes.push(node);

      // Right-click context menu
      node.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const menuItems = [];
        if (!item.isDirectory) {
          menuItems.push({ label: t('ctx_open'), action: () => openFileCallback(item.path) });
        } else {
          menuItems.push({ label: t('ctx_new_file_here'), action: () => createNewItem('file', item.path) });
          menuItems.push({
            label: t('ctx_new_folder_here'),
            action: () => createNewItem('directory', item.path),
          });
        }
        menuItems.push({ label: t('ctx_rename'), action: () => renameItem(item.path) });
        menuItems.push({ label: t('ctx_delete'), danger: true, action: () => deleteItem(item.path) });
        _showContextMenu(e.clientX, e.clientY, menuItems);
      });

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
          invalidateVisibleNodesCache();
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
        } else if (e.key === 'F2') {
          e.preventDefault();
          renameItem(item.path);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          deleteItem(item.path);
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
          if (item.isDirectory && !node.classList.contains('expanded')) {
            node.click();
          } else if (item.isDirectory) {
            const group = node.nextElementSibling;
            if (group?.classList.contains('tree-children')) {
              const firstChild = group.querySelector('.tree-node');
              if (firstChild) firstChild.focus();
            }
          }
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          if (item.isDirectory && node.classList.contains('expanded')) {
            node.click();
          } else {
            const group = node.parentElement;
            if (group?.classList.contains('tree-children')) {
              const parentNode = group.previousElementSibling;
              if (parentNode?.classList.contains('tree-node')) parentNode.focus();
            }
          }
        }
      };
    }
  }

  function getVisibleNodes() {
    if (_visibleNodesCache) return _visibleNodesCache;
    const tree = dom.fileTree;
    if (!tree) return [];
    _visibleNodesCache = Array.from(tree.querySelectorAll('.tree-node')).filter((n) => {
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
    return _visibleNodesCache;
  }

  function getNextVisibleNode(node) {
    const visible = getVisibleNodes();
    const idx = visible.indexOf(node);
    return idx !== -1 && idx < visible.length - 1 ? visible[idx + 1] : null;
  }

  function getPrevVisibleNode(node) {
    const visible = getVisibleNodes();
    const idx = visible.indexOf(node);
    return idx > 0 ? visible[idx - 1] : null;
  }

  // Initialize
  _bindNewButtons();
  _bindFileSearch();

  return { loadWorkspace };
}
