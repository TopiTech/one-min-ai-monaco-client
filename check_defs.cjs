const fs = require('fs');
const path = process.argv[2] || 'public/app.js';
const t = fs.readFileSync(path, 'utf8');
const lines = t.split(/\r?\n/);

const defs = new Set();
const classDefs = new Set();
lines.forEach((l) => {
  let m = l.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/);
  if (m) defs.add(m[1]);
  m = l.match(/^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/);
  if (m) defs.add(m[1]);
  m = l.match(/^class\s+([A-Za-z_$][\w$]*)\b/);
  if (m) classDefs.add(m[1]);
});
// also: const X = function / const X = (...) =>
lines.forEach((l) => {
  let m = l.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function|\()/);
  if (m) defs.add(m[1]);
  m = l.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/);
  if (m) defs.add(m[1]);
});
// window.X = ... / globalThis.X = ...
lines.forEach((l) => {
  let m = l.match(/^(?:window|globalThis|self)\.([A-Za-z_$][\w$]*)\s*=/);
  if (m) defs.add(m[1]);
});

const reserved = new Set(['if','for','while','switch','catch','return','throw','new','typeof','in','of','do','else','try','class','function','var','let','const','await','async','yield','delete','void','default','case','break','continue','debugger','finally','super','this','null','true','false','undefined','static','get','set','export','import','from','as','extends','with','enum','implements','interface','package','private','protected','public']);
const builtins = new Set(['console','document','window','globalThis','self','Math','Object','Array','String','Number','Boolean','Date','JSON','Promise','Set','Map','WeakMap','WeakSet','Symbol','Error','TypeError','RangeError','SyntaxError','ReferenceError','URL','URLSearchParams','RegExp','Function','NaN','Infinity','parseInt','parseFloat','isNaN','isFinite','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','setTimeout','setInterval','clearTimeout','clearInterval','requestAnimationFrame','cancelAnimationFrame','fetch','alert','confirm','prompt','navigator','location','history','localStorage','sessionStorage','atob','btoa','require','define','process','Buffer','module','exports','__dirname','__filename','global']);

const refs = new Map();
lines.forEach((l, i) => {
  const re = /\b([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(l))) {
    const n = m[1];
    if (defs.has(n) || reserved.has(n) || builtins.has(n)) continue;
    if (!refs.has(n)) refs.set(n, []);
    refs.get(n).push(i + 1);
  }
});

const sorted = [...refs.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [k, locs] of sorted) {
  console.log(k, '(' + locs.length + 'x)', locs.slice(0, 8).join(',') + (locs.length > 8 ? '...' : ''));
}
