
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
function setStatus(text, cls='') { statusEl.textContent = text; statusEl.className = `status ${cls}`; }
async function api(path, options={}) {
  setStatus('通信中...', 'warn');
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { setStatus('エラー', 'err'); throw new Error(data.error || `HTTP ${res.status}`); }
  setStatus('完了', 'ok');
  return data;
}
function extractText(data) {
  const candidates = [
    data?.aiRecord?.aiRecordDetail?.resultObject,
    data?.aiRecord?.aiRecordDetail?.result,
    data?.aiRecord?.resultObject,
    data?.result,
    data?.message,
    data?.text,
    data?.content,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(x => typeof x === 'string' ? x : JSON.stringify(x, null, 2)).join('\n');
    if (c && typeof c === 'object') return JSON.stringify(c, null, 2);
  }
  return JSON.stringify(data, null, 2);
}
function assetUrl(path) {
  if (!path) return '';
  if (/^https?:\/\//.test(path)) return path;
  return `https://asset.1min.ai/${path.replace(/^\//,'')}`;
}
function extractImages(data) {
  const r = data?.aiRecord?.aiRecordDetail?.resultObject || data?.resultObject || data?.images || [];
  const arr = Array.isArray(r) ? r : [r];
  return arr.filter(Boolean).map(x => typeof x === 'string' ? x : (x.url || x.path || x.key || JSON.stringify(x)));
}

// navigation
for (const btn of document.querySelectorAll('.nav')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav,.view').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.view).classList.add('active');
    $('viewTitle').textContent = btn.textContent;
    if (btn.dataset.view === 'coding') setTimeout(() => window.editor?.layout(), 50);
  });
}
$('healthBtn').onclick = async () => { alert(JSON.stringify(await api('/api/health'), null, 2)); };

// chat
function addMsg(role, content) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'user' : 'ai'}`;
  div.innerHTML = `<span class="role">${role}</span>${role === 'ai' && window.marked ? marked.parse(content) : content.replace(/[&<>]/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[s]))}`;
  $('chatLog').appendChild(div); $('chatLog').scrollTop = $('chatLog').scrollHeight;
}
$('sendChat').onclick = async () => {
  const prompt = $('chatPrompt').value.trim(); if (!prompt) return;
  addMsg('user', prompt); $('chatPrompt').value = '';
  try {
    const data = await api('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt, model:$('chatModel').value, conversationId:$('conversationId').value || undefined, webSearch:$('webSearch').checked }) });
    addMsg('ai', extractText(data));
  } catch(e) { addMsg('ai', `Error: ${e.message}`); }
};
$('createConversation').onclick = async () => {
  const data = await api('/api/conversations', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title:$('conversationTitle').value, model:$('chatModel').value }) });
  const id = data?.conversation?.uuid || data?.uuid || data?.aiRecord?.conversationId || data?.conversationId || '';
  $('conversationId').value = id;
  alert(JSON.stringify(data, null, 2));
};

// images
function renderImages(data) {
  const images = extractImages(data);
  if (!images.length) {
    const pre = document.createElement('pre'); pre.className='json'; pre.textContent = JSON.stringify(data, null, 2); $('imageGallery').prepend(pre); return;
  }
  for (const img of images) {
    const card = document.createElement('div'); card.className='imageCard';
    const url = assetUrl(img);
    card.innerHTML = `<img src="${url}" alt="generated" onerror="this.style.display='none'"/><a href="${url}" target="_blank">${img}</a>`;
    $('imageGallery').prepend(card);
  }
}
$('generateImage').onclick = async () => {
  const data = await api('/api/images/generate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ prompt:$('imagePrompt').value, model:$('imageModel').value, num_outputs:$('numOutputs').value, aspect_ratio:$('aspectRatio').value }) });
  renderImages(data);
};
$('uploadAsset').onclick = async () => {
  const file = $('assetInput').files[0]; if (!file) return alert('画像ファイルを選択してください');
  const fd = new FormData(); fd.append('asset', file);
  const data = await api('/api/assets/upload', { method:'POST', body: fd });
  $('assetResult').textContent = JSON.stringify(data, null, 2);
  const key = data?.asset?.key || data?.fileContent?.path || data?.asset?.location || '';
  if (key) $('variationImageUrl').value = key;
};
$('variationBtn').onclick = async () => {
  const data = await api('/api/images/variation', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ imageUrl:$('variationImageUrl').value, model:$('variationModel').value, n:$('variationN').value }) });
  $('assetResult').textContent = JSON.stringify(data, null, 2);
  renderImages(data);
};

// Monaco editor
const files = {
  'index.ts': { language:'typescript', code:`type User = { id: string; name: string }\n\nfunction greet(user: User) {\n  return 'Hello, ' + user.name\n}\n\nconsole.log(greet({ id: '1', name: 'Yutaro' }))\n` },
  'app.py': { language:'python', code:`def greet(name: str):\n    return f"Hello, {name}"\n\nprint(greet("1min.ai"))\n` },
  'README.md': { language:'markdown', code:`# Sample Project\n\nAI coding assistant demo.\n` },
};
let currentFile = 'index.ts';
require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.55.1/min/vs' }});
require(['vs/editor/editor.main'], function () {
  window.editor = monaco.editor.create($('editor'), {
    value: files[currentFile].code,
    language: files[currentFile].language,
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: true },
    fontSize: 14,
    wordWrap: 'on'
  });
});
for (const btn of document.querySelectorAll('.file')) {
  btn.onclick = () => {
    files[currentFile].code = window.editor?.getValue() || files[currentFile].code;
    currentFile = btn.dataset.file;
    document.querySelectorAll('.file').forEach(x => x.classList.remove('active'));
    btn.classList.add('active');
    if (window.editor) {
      const model = monaco.editor.createModel(files[currentFile].code, files[currentFile].language);
      window.editor.setModel(model);
    }
  };
}
$('assistCode').onclick = async () => {
  files[currentFile].code = window.editor?.getValue() || '';
  const data = await api('/api/code/assist', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ instruction:$('codeInstruction').value, fileName:currentFile, language:files[currentFile].language, code:files[currentFile].code, model:$('codeModel').value }) });
  $('codeResult').textContent = extractText(data);
};
$('applyFirstCode').onclick = () => {
  const text = $('codeResult').textContent;
  const match = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (!match) return alert('コードブロックが見つかりません');
  window.editor?.setValue(match[1].trim());
};
