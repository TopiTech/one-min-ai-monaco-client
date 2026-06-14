# P0 修正実装計画

## 概要
コードレビューで発見したP0（緊急）の問題に対する修正計画。

---

## P0-1: routes/ai.js の Chat API ペイロード修正

### 問題
現在のコードでは `webSearch` と `history` が `promptObject` のトップレベルに設定されているが、1min.ai API v2 では `settings` ネスト形式が必要。

### 修正内容
ファイル: `routes/ai.js` (17-27行目)

**Before:**
```javascript
const payload = {
  type: 'UNIFY_CHAT_WITH_AI',
  model: model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini',
  promptObject: {
    prompt: String(prompt),
    webSearch: Boolean(webSearch),
    history: Boolean(history),
    ...(conversationId ? { conversationId } : {}),
    ...(attachments ? { attachments } : {}),
  },
};
```

**After:**
```javascript
const payload = {
  type: 'UNIFY_CHAT_WITH_AI',
  model: model || process.env.DEFAULT_CHAT_MODEL || 'gpt-4o-mini',
  promptObject: {
    prompt: String(prompt),
    settings: {
      webSearchSettings: {
        webSearch: Boolean(webSearch),
      },
      historySettings: {
        history: Boolean(history),
      },
      withMemories: false,
    },
    ...(conversationId ? { conversationId } : {}),
    ...(attachments ? { attachments } : {}),
  },
};
```

---

## P0-2: server.js の Asset アップロードフィールド名修正

### 問題
`formData.append("file", ...)` を使用しているが、1min.ai Asset API ではフィールド名が `"asset"` である。

### 修正内容
ファイル: `server.js` (53行目)

**Before:**
```javascript
formData.append("file", blob, req.file.originalname || "upload.bin");
```

**After:**
```javascript
formData.append("asset", blob, req.file.originalname || "upload.bin");
```

---

## P0-3: utils/fs-guard.js のセキュリティ強化

### 問題
1. デフォルトで PROJECT_ROOT + 親ディレクトリ + ホームディレクトリを許可（広すぎる）
2. `realpath` 解決がない（シンボリックリンクによるパストラバーサル可能）

### 修正内容
ファイル: `utils/fs-guard.js`

**Before (9-16行目):**
```javascript
function getDefaultAllowedRoots() {
  const homeDir = process.env.USERPROFILE || process.env.HOME;
  return uniquePaths([
    PROJECT_ROOT,
    path.dirname(PROJECT_ROOT),
    homeDir,
  ]);
}
```

**After:**
```javascript
function getDefaultAllowedRoots() {
  return uniquePaths([
    PROJECT_ROOT,
  ]);
}
```

**Before (46-65行目):**
```javascript
export function validatePath(targetPath) {
  if (!targetPath) {
    throw new Error('Path is required');
  }

  const resolvedPath = path.resolve(targetPath);
  const allowedRoots = getAllowedRoots();

  const isAllowed = allowedRoots.some(
    (root) => resolvedPath === root || resolvedPath.startsWith(root + path.sep)
  );

  if (!isAllowed) {
    const err = new Error('Access denied: Path is outside the allowed directories');
    err.status = 403;
    throw err;
  }

  return resolvedPath;
}
```

**After:**
```javascript
import fs from 'fs';

export function validatePath(targetPath) {
  if (!targetPath) {
    throw new Error('Path is required');
  }

  const resolvedPath = path.resolve(targetPath);
  const allowedRoots = getAllowedRoots();

  // Resolve symlinks for both target and allowed roots
  let realPath;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    // File doesn't exist yet, use resolved path
    realPath = resolvedPath;
  }

  const realRoots = allowedRoots.map(root => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  });

  const isAllowed = realRoots.some(
    (root) => realPath === root || realPath.startsWith(root + path.sep)
  );

  if (!isAllowed) {
    const err = new Error('Access denied: Path is outside the allowed directories');
    err.status = 403;
    throw err;
  }

  return realPath;
}
```

---

## P0-4: コマンド実行のセキュリティ強化

### 問題
1. `approve` エンドポイントがクライアントから任意のコマンドを受け入れる
2. ペンディング状態の追跡がない
3. シェルインジェクションのリスク

### 修正内容

#### 4a. routes/agent.js の修正

ファイル: `routes/agent.js`

**変更1: ペンディングコマンドストアの追加 (11行目付近)**

```javascript
// In-memory session store (replace with persistent store in production)
const sessions = new Map();
const pendingCommands = new Map(); // 追加: ペンディングコマンドの追跡
```

**変更2: コマンド実行エンドポイントの修正 (60-131行目)**

`requireApproval` の場合、コマンドをペンディングストアに保存し、トークンを発行:

```javascript
// If approval required, return command for review
if (requireApproval && !serverConfig.agentAutoApprove) {
  const approvalToken = `approval-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  pendingCommands.set(approvalToken, {
    command,
    cwd: workingDir,
    sessionId,
    createdAt: Date.now(),
  });
  
  // 古いペンディングコマンドをクリーンアップ (5分以上古いもの)
  const now = Date.now();
  for (const [token, pending] of pendingCommands) {
    if (now - pending.createdAt > 5 * 60 * 1000) {
      pendingCommands.delete(token);
    }
  }
  
  return res.json({
    requiresApproval: true,
    approvalToken,
    command,
    cwd: workingDir,
    message: 'このコマンドを実行しますか？',
  });
}
```

**変更3: approve エンドポイントの修正 (136-176行目)**

```javascript
router.post('/sessions/:id/approve', async (req, res, next) => {
  try {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const { approvalToken, timeoutMs } = req.body;
    
    // ペンディングコマンドの検証
    if (!approvalToken || !pendingCommands.has(approvalToken)) {
      return res.status(400).json({ error: 'Invalid or expired approval token' });
    }
    
    const pending = pendingCommands.get(approvalToken);
    pendingCommands.delete(approvalToken);
    
    // セッションIDの一致確認
    if (pending.sessionId !== req.params.id) {
      return res.status(403).error({ error: 'Session ID mismatch' });
    }
    
    // 再度安全性チェック
    const safety = checkCommandSafety(pending.command);
    if (!safety.safe) {
      return res.status(400).json({
        error: `Command blocked: ${safety.reason}`,
        safety,
      });
    }

    session.status = 'running';
    const result = await executeCommand(pending.command, {
      cwd: pending.cwd,
      timeoutMs: timeoutMs || serverConfig.commandTimeoutMs,
    });

    session.status = 'idle';
    session.history.push({
      type: 'command',
      command: pending.command,
      cwd: pending.cwd,
      result,
      approved: true,
      timestamp: new Date().toISOString(),
    });

    res.json({
      executed: true,
      command: pending.command,
      cwd: pending.cwd,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});
```

#### 4b. services/command-runner.js の修正

ファイル: `services/command-runner.js`

**変更: より厳しい危険パターンの追加 (12-25行目)**

```javascript
const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+\*/,
  /rm\s+-rf\s+~/,
  /del\s+\/s\s+\/q/,
  /format\s+[a-z]:/i,
  /sudo\s+/,
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
  />\s*\/dev\/(sda|hd[a-z])/,
  /dd\s+if=.*of=\/dev/,
  /mkfs\./,
  /:\(\)\s*\{.*\}\s*;/,  // Fork bomb
  // 追加パターン
  /;\s*rm\s+/,           // チェーン攻撃
  /\|\s*rm\s+/,          // パイプ攻撃
  /`\s*rm\s+/,           // コマンド置換
  /\$\(.*rm\s+/,         // コマンド置換 $()
  /eval\s*\(/,           // eval
  /exec\s*\(/,           // exec
  /child_process/,       // Node.js child_process
  /require\s*\(\s*['"]child_process['"]\s*\)/, // require('child_process')
  /process\.env/,        // 環境変数アクセス
  /Buffer\.from\s*\(/,   // Buffer操作
];
```

---

## P0-5: public/app.js の XSS サニタイズ追加

### 問題
AI の応答を `innerHTML` に直接設定しており、悪意あるスクリプトが実行される可能性。

### 修正内容
ファイル: `public/app.js`

**追加: HTML エスケープ関数の追加 (関数の前に)**

```javascript
// HTML エスケープ関数
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
```

**変更: addMsg 関数の修正 (35-61行目)**

**Before:**
```javascript
function addMsg(role, content, images = []) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "ai"}`;

  let html = `<span class="role">${role}</span>`;

  // Add images if present
  if (images && images.length > 0) {
    html += '<div class="msg-images">';
    for (const img of images) {
      const url = img.url || img.assetUrl || img;
      html += `<img src="${url}" alt="attached" class="msg-image" onerror="this.style.display='none'" />`;
    }
    html += '</div>';
  }

  // Add text content
  if (role === "ai" && window.marked) {
    html += marked.parse(content);
  } else {
    html += content.replace(/[&<>]/g, (s) => ({ "&": "&", "<": "<", ">": ">" })[s]);
  }

  div.innerHTML = html;
  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}
```

**After:**
```javascript
function addMsg(role, content, images = []) {
  const div = document.createElement("div");
  div.className = `msg ${role === "user" ? "user" : "ai"}`;

  // ロール表示
  const roleSpan = document.createElement("span");
  roleSpan.className = "role";
  roleSpan.textContent = role;
  div.appendChild(roleSpan);

  // Add images if present
  if (images && images.length > 0) {
    const imagesDiv = document.createElement("div");
    imagesDiv.className = "msg-images";
    for (const img of images) {
      const url = escapeHtml(img.url || img.assetUrl || img);
      const imgEl = document.createElement("img");
      imgEl.className = "msg-image";
      imgEl.alt = "attached";
      imgEl.src = url;
      imgEl.onerror = function() { this.style.display = 'none'; };
      imagesDiv.appendChild(imgEl);
    }
    div.appendChild(imagesDiv);
  }

  // Add text content
  if (role === "ai" && window.marked) {
    // marked を使用する場合、DOMPurify でサニタイズするか、
    // または textContent で安全に表示する
    const contentDiv = document.createElement("div");
    contentDiv.className = "msg-content";
    // marked のオプションでサニタイズ
    contentDiv.innerHTML = marked.parse(content, {
      sanitize: false, // marked の組み込みサニタイズは非推奨
    });
    // スクリプトタグを削除
    contentDiv.querySelectorAll("script").forEach(el => el.remove());
    // イベントハンドラ属性を削除
    contentDiv.querySelectorAll("*").forEach(el => {
      const attrs = el.attributes;
      for (let i = attrs.length - 1; i >= 0; i--) {
        if (attrs[i].name.startsWith("on")) {
          el.removeAttribute(attrs[i].name);
        }
      }
    });
    div.appendChild(contentDiv);
  } else {
    const contentDiv = document.createElement("div");
    contentDiv.className = "msg-content";
    contentDiv.textContent = content;
    div.appendChild(contentDiv);
  }

  $("chatLog").appendChild(div);
  $("chatLog").scrollTop = $("chatLog").scrollHeight;
}
```

---

## P0-6: server.js のセキュリティミドルウェア追加

### 問題
1. Helmet がない（セキュリティヘッダ未設定）
2. レート制限がない
3. localhost 以外のバインド可能性

### 修正内容

#### 6a. 依存関係の追加

`package.json` に追加:

```json
{
  "dependencies": {
    "dotenv": "^16.4.7",
    "express": "^4.18.3",
    "helmet": "^8.0.0",
    "express-rate-limit": "^7.5.0",
    "multer": "^1.4.5-lts.1"
  }
}
```

#### 6b. server.js の修正

ファイル: `server.js`

**Before:**
```javascript
import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { callOneMin } from "./utils/api-client.js";
import { serverConfig } from "./config/server.js";
import logger from "./utils/logger.js";

import aiRoutes from "./routes/ai.js";
import fsRoutes from "./routes/fs.js";
import agentRoutes from "./routes/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: serverConfig.maxFileSize }
});

// Request logging middleware
app.use(logger.requestLogger());

app.use(express.json({ limit: serverConfig.maxJsonBodySize }));
app.use(express.static(path.join(__dirname, "public")));
```

**After:**
```javascript
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import { callOneMin } from "./utils/api-client.js";
import { serverConfig } from "./config/server.js";
import logger from "./utils/logger.js";

import aiRoutes from "./routes/ai.js";
import fsRoutes from "./routes/fs.js";
import agentRoutes from "./routes/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: serverConfig.maxFileSize }
});

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"], // Monaco CDN 用
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "https://cdn.jsdelivr.net"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Monaco ワーカー用に無効化
}));

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分
  max: 180, // 1分あたり180リクエスト
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1分
  max: 100, // 1分あたり100リクエスト
  message: { error: 'Too many upload requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(generalLimiter);

// Request logging middleware
app.use(logger.requestLogger());

app.use(express.json({ limit: serverConfig.maxJsonBodySize }));
app.use(express.static(path.join(__dirname, "public")));
```

**変更: アップロードエンドポイントにレート制限適用 (38行目付近)**

```javascript
app.post("/api/assets/upload", uploadLimiter, upload.single("asset"), async (req, res, next) => {
```

**変更: サーバー起動を localhost に限定 (82行目付近)**

**Before:**
```javascript
app.listen(serverConfig.port, () => {
```

**After:**
```javascript
app.listen(serverConfig.port, '127.0.0.1', () => {
```

---

## 実装順序

1. **P0-1**: routes/ai.js - Chat API ペイロード修正
2. **P0-2**: server.js - Asset アップロードフィールド名修正
3. **P0-3**: utils/fs-guard.js - セキュリティ強化
4. **P0-4**: routes/agent.js + services/command-runner.js - コマンド実行セキュリティ強化
5. **P0-5**: public/app.js - XSS サニタイズ
6. **P0-6**: server.js + package.json - セキュリティミドルウェア追加

---

## テスト要件

各修正後、以下のテストを実施:

1. **P0-1**: Chat API が正しいペイロードで 1min.ai にリクエストされること
2. **P0-2**: 画像アップロードが正しく動作すること
3. **P0-3**: 許可されたパスのみアクセス可能であること、シンボリックリンクが解決されること
4. **P0-4**: ペンディングコマンドが正しく管理されること、危険なコマンドがブロックされること
5. **P0-5**: AI 応答にスクリプトが含まれても実行されないこと
6. **P0-6**: セキュリティヘッダが設定されること、レート制限が機能すること
