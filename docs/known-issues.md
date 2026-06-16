# 残存問題点と改善推奨

このドキュメントは、コードレビュー（2026-06-16）で発見された項目の中で、修正を見送った、または新規発見された課題を記録します。各項目には優先度・影響範囲・推奨対応を記載しています。

## 凡例

- **優先度**: Blocker / High / Medium / Low / Nit
- **状態**: Open / In Progress / Resolved / Deferred
- **影響範囲**: 影響を受ける機能・コンポーネント

## サマリ

| # | 優先度 | 状態 | カテゴリ | 概要 |
|---|--------|------|----------|------|
| 9 | Medium | Open | UX/承認フロー | `state.agent.resolver` のキュー化が未実装 |
| 10 | Medium | Open | 競合状態 | ネストした承認要求で前の Promise がハング |
| 11 | Low | Open | 入力検証 | `output_compression` の非数値で `NaN` 送信 |
| 12 | Low | Open | TOCTOU | `searchInDirectory` で `stat`/`readFile` 間の race |
| 13 | Low | Open | 入力処理 | `parseCommand` が空引用符 `""` を奇妙に扱う |
| 14 | Nit | Open | エラーメッセージ | `extractFailureMessage` のフォールバック順序 |
| 15 | Nit | Resolved | 入力正規化 | `webSearch` の `Boolean()` 正規化（確認済み） |
| 16 | Low | Open | 状態リーク | ストリーム中断時の `currentEvent` リセット漏れ |
| 17 | Medium | Deferred | セキュリティ | `data-bff-token` 属性の XSS 時の漏洩リスク |
| 18 | Nit | Resolved | テスト | テスト名更新（確認済み） |

## 詳細

### #9 [Medium] 承認フローでクライアントの `requireApproval` フラグを無視

**影響範囲**: `routes/agent.js`, `public/app.js` の `AGENT_TOOL_HANDLERS.run_command`

**問題**:
`routes/agent.js` の承認フローでは、`effectiveRequireApproval = !serverConfig.agentAutoApprove` により、**サーバー設定のみ**を信頼します。これは仕様として正しい設計ですが、以下のような場合に UX との不整合が生じます。

- サーバーで `agentAutoApprove=true` だが、フロントエンドが承認 UI を表示するロジックを書き換えた場合、ユーザーは「承認したのに自動で実行されない」と感じる
- 逆に `agentAutoApprove=false` でも、UI 上は承認待ちであることが明示されない場合がある

**推奨対応**:
- フロントエンドの承認 UI ロジックをサーバー応答の `requiresApproval` フラグに完全一致させる（現状はそうなっているはずだが、コメントで明示）
- ユーザーが却下した理由を `feedbackInput` から取得し、agent の history に永続化しているが、**UI 上で取り消し可能**にする（現状はエージェントの次のターンで上書きされるまで残る）

**修正例** (`public/app.js`):
```javascript
rejectBtn.onclick = () => {
  // ... 既存の無効化処理 ...
  onReject(reason);
  // 追加: 拒否後に UI から該当ステップをフェードアウトする
  setTimeout(() => step.remove(), 500);
};
```

---

### #10 [Medium] ネストした承認要求で前の Promise がハング

**影響範囲**: `public/app.js` の `AGENT_TOOL_HANDLERS.run_command`, `state.agent.resolver`

**問題**:
`state.agent.resolver` は単一の Promise resolver のみを保持します。理論的には承認待ち中に別の `run_command` 呼び出しが走ることはないはずですが、競合状態（ネットワーク再接続、ユーザー操作、AI の暴走など）で発生しうる場合、**前の Promise が永久に resolve されません**。

**再現シナリオ**:
1. ユーザーが承認待ちで A コマンドを保留
2. 別経路（並行 fetch、UI 連打など）で B コマンドが `/api/agent/sessions/:id/commands` を呼び出す
3. B の `approvalToken` で `state.agent.resolver` が上書きされる
4. A の Promise は永久にハング、UI もブロック

**推奨対応**:
- 承認待ち中は新しい `run_command` 呼び出しを拒否する（フロント側でガード）
- または、`state.agent.resolver` をキュー化して順次処理

**修正例** (`public/app.js`):
```javascript
run_command: async ({ sessionId, workspaceRoot, params }) => {
  if (state.agent.resolver) {
    return {
      text: "別のコマンドが承認待ちです。先に承認/却下してください。",
      success: false,
    };
  }
  // ... 既存の処理 ...
},
```

---

### #11 [Low] `output_compression` の非数値で `NaN` を送信

**影響範囲**: `routes/ai.js` の `/api/images/generate`, `/api/images/text-editor`

**問題**:
```javascript
if (output_compression !== undefined && output_compression !== "") {
  promptObject.output_compression = Number(output_compression);
}
```

`output_compression` が `"abc"` のような非数値文字列の場合、`Number("abc")` は `NaN` を返し、そのまま 1min.ai に送信されます。`isNaN()` チェックで 400 を返すべきです。

**推奨対応**:
```javascript
if (output_compression !== undefined && output_compression !== "") {
  const n = Number(output_compression);
  if (isNaN(n)) {
    return res.status(400).json({ error: "output_compression must be a number" });
  }
  promptObject.output_compression = n;
}
```

**影響**: 1min.ai が 422 エラーを返すか、無音でデフォルト値にフォールバックする可能性。機能停止には至らないが、エラーメッセージが不親切。

---

### #12 [Low] `searchInDirectory` の `stat`/`readFile` 間の race

**影響範囲**: `routes/agent.js` の `searchInDirectory`

**問題**:
```javascript
const revalidated = revalidateRealPath(fullPath);
const stat = await fs.stat(revalidated);
if (stat.size > 1024 * 1024) return;
const content = await fs.readFile(revalidated, "utf-8");
```

`stat` の後に攻撃者がシンボリックリンクを別ファイルに差し替えると、`readFile` が異なる内容を読みます。realpath チェックが `readFile` の直前でもう一度行われていない点が気になります。

**推奨対応**:
- ファイルサイズ制限を 1MB → 256KB に下げる（攻撃の有効時間を短縮）
- または、`fs.readFile` のオプションで `flag: 'r'` を明示し、`O_NOFOLLOW` 相当の保護を OS レベルで活用

**影響**: 実際の攻撃難易度は高い（書き込み権限を持つ必要がある）が、defense-in-depth として。

---

### #13 [Low] `parseCommand` が空引用符 `""` を奇妙に処理

**影響範囲**: `services/command-runner.js` の `parseCommand`

**問題**:
```javascript
if (char === '"' || char === "'") {
  quote = char;
  continue;
}
```

空の引用符 `cmd ""` は `["cmd", ""]` にパースされます。`echo ""` は正当なケースですが、`""` だけの引数や `cmd "" ""` のような意図しないケースで挙動が不明瞭です。

**推奨対応**:
- 空トークンをエラーにする、または無視する
- もしくは、現状のまま `documented behavior` としてコメントを残す

**影響**: 機能的な問題なし、UX 改善のみ。

---

### #14 [Nit] `extractFailureMessage` のフォールバック順序

**影響範囲**: `utils/api-client.js` の `extractFailureMessage`

**問題**:
```javascript
return (
  data?.aiRecord?.aiRecordDetail?.errorMessage ||
  data?.aiRecord?.errorMessage ||
  data?.error?.message ||
  data?.error ||
  data?.message ||  // ← 汎用メッセージの汚染リスク
  "Upstream returned a failure status"
);
```

1min.ai の `data.message` は成功時にも `"Stream completed"` などのメッセージを含むため、FAILED 判定時に「Stream completed」が失敗理由として表示される可能性があります。

**推奨対応**:
```javascript
return (
  data?.aiRecord?.aiRecordDetail?.errorMessage ||
  data?.aiRecord?.errorMessage ||
  data?.error?.message ||
  data?.error ||
  // data?.message は汎用メッセージなので信頼しない
  "Upstream returned a failure status"
);
```

**影響**: まれに失敗理由が分かりにくくなる程度。

---

### #16 [Low] ストリーム中断時の `currentEvent` 状態リーク

**影響範囲**: `public/app.js` のチャットストリーミングループ

**問題**:
ストリーミング受信中に接続が切れた場合、`currentEvent` 変数が次のチャット開始時にリセットされません。現状は新規チャットごとに新しい関数コンテキストが生成されるため実害なしですが、リファクタリング時に状態リークの温床になります。

**推奨対応**:
- `currentEvent` をループ内で `let` 宣言（現状は関数スコープの `var` 相当）
- または、各チャット開始時に明示的に `currentEvent = "content"` で初期化

**影響**: 現状は問題なし。将来のリファクタリング時の安全性のため。

---

### #17 [Medium] `data-bff-token` 属性の XSS 時の漏洩リスク（Deferred）

**影響範囲**: `server.js` の HTML 注入, `public/js/api.js` の `getBffToken`

**問題**:
`<body data-bff-token="...">` として埋め込まれたトークンは、XSS が成立した場合に `document.body.dataset.bffToken` で取得可能です。`__bff_session` HttpOnly クッキーは XSS でも取得できませんが、`data-bff-token` は JavaScript からアクセス可能です。

**現状の防御**:
- CSP `scriptSrc: 'self'` により外部スクリプト読み込み制限
- DOMPurify による safe markdown レンダリング
- `sameSite: Strict` クッキー

これらは強固ですが、`data-bff-token` は XSS 耐性を一段下げています。

**推奨対応（優先度低、Monaco Editor との互換性考慮）**:
- Service Worker 経由でトークンを注入（XSS でもアクセス不可）
- または、各 `/api/*` リクエストにワンタイム nonce を使用
- Monaco Editor の AMD loader との互換性を保ちつつ実装する必要があるため、慎重な検討が必要

**影響**: 現状の防御が破られた場合の最終防壁。実装コストが高いため、Deferred。

---

### #18 [Nit] テスト名更新（Resolved）

`tests/web-search.test.js` の最初のテスト名を `should build CODE_GENERATOR payload matching 1min.ai API schema (flat webSearch on promptObject)` に更新済み。コメントで legacy 形式との対比があるとより親切だが、現状で十分。

---

## 推奨アクションプラン

### 即時対応（次回マージ前）
- **#11**: `output_compression` の `isNaN()` チェック追加（5分で対応可能）

### 短期対応（1週間以内）
- **#9**: 承認 UI の却下後フェードアウト追加
- **#14**: `extractFailureMessage` のフォールバック順序修正
- **#10**: `state.agent.resolver` のキュー化または排他制御

### 中期対応（1ヶ月以内）
- **#12**: `searchInDirectory` の TOCTOU 対策強化
- **#16**: `currentEvent` のスコープをループ内に移動

### 長期対応（検討事項）
- **#17**: `data-bff-token` の代替手段（Service Worker / nonce）
- **#13**: `parseCommand` の空引用符処理

---

## テスト戦略

### 既存テスト
- `tests/security-fixes.test.js`: 17 tests
- `tests/review-fixes.test.js`: 8 tests
- `tests/command-runner.test.js`, `tests/fs-guard.test.js`, etc.

### 追加推奨テスト

#### #9, #10: 承認フローのネスト
```javascript
test("rejects new run_command while another is awaiting approval", async () => {
  // state.agent.resolver を事前設定して、2つ目の run_command が拒否されることを確認
});
```

#### #11: output_compression 検証
```javascript
test("rejects non-numeric output_compression", async () => {
  const res = await request(app)
    .post("/api/images/generate")
    .send({ prompt: "cat", model: "gpt-image-2", output_compression: "abc" });
  expect(res.status).toBe(400);
});
```

#### #14: extractFailureMessage
```javascript
test("does not return generic 'Stream completed' as failure message", () => {
  const data = { aiRecord: { status: "FAILED" }, message: "Stream completed" };
  expect(extractFailureMessage(data)).not.toBe("Stream completed");
});
```

---

## 参考情報

### 1min.ai API ドキュメント
- [Chat with AI API](https://docs.1min.ai/docs/api/chat-with-ai-api)
- [AI Feature API](https://docs.1min.ai/docs/api/ai-feature-api)
- [Code Generator](https://docs.1min.ai/docs/api/ai-for-code/code-generator/code-generator-tag)

### 内部ドキュメント
- `docs/api-specifications.md`: 1min.ai API の詳細仕様
- `README.md`: プロジェクト概要と使い方

### レビュー履歴
- 2026-06-16: 初版レビュー（11 項目発見、7 項目修正済み）
- 2026-06-16: 再レビュー（10 項目残存、全て Medium 以下）
- 2026-06-16: 本ドキュメント作成

---

## 連絡先

質問や追加の議論が必要な場合は、プロジェクトの issue tracker または `#security` チャンネルで言及してください。
