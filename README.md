# 1min.ai Monaco Client

> [!WARNING]
> **本アプリケーションはローカル環境（localhost/127.0.0.1）での個人開発およびシングルユーザー利用を前提に設計されています。**  
> `/api/fs/*` (ファイルシステム操作) やエージェントのコマンド実行機能には、マルチユーザー向けのロールベースアクセス制御 (RBAC) や詳細なログ監査、サンドボックス実行といったエンタープライズ向けの堅牢な保護機構は含まれていません。パブリックなインターネット上のサーバーや、共有の開発・ステージング環境などへ**絶対にデプロイしないでください**。

Monaco Editor + カスタムUI + 1min.ai API で構成した、ブラウザで動くAIクライアントMVPです。  
1min.ai APIキーをフロントエンドに露出せず、ExpressサーバーをBFFとして中継する構成になっています。

## 主な機能

- 通常チャット
- モデルピッカーのカテゴリ分け（フラグシップ、思考・論理、高速・軽量）
- 会話作成 / `conversationId` 指定による会話再開
- Web Search チェックによるチャット拡張
- 画像生成
- 画像テキストエディタ
- Asset APIによる画像アップロード
- Monaco Editor統合
- コード説明・生成・リファクタリング補助
- インラインチャット（適用/破棄のプレビュー機能付き）
- 高機能AI Codingエージェント（詳細な思考プロセス表示、承認フロー付き）
- プロジェクト内ファイルの閲覧・保存
- APIキーをフロントエンドに出さないサーバー中継構成
- 堅牢なファイルパス・セキュリティガード (`fs-guard`)

## 必要環境

- Node.js 18以上
- 1min.ai API Key
- Monaco Editor / marked のCDN読み込みのため、初回表示時はインターネット接続が必要です

## クイックスタート

```bash
cp .env.example .env
# .env の ONE_MIN_AI_API_KEY を編集
npm install
npm start
```

または開発用ウォッチ起動:

```bash
npm run dev
```

起動後、以下を開きます。

```text
http://localhost:3000
```

## 環境変数

| 変数 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `ONE_MIN_AI_API_KEY` | はい | なし | 1min.ai APIキー。`.env` にのみ保存してください。 |
| `PORT` | いいえ | `3000` | ローカルExpressサーバーの待ち受けポート。 |
| `NODE_ENV` | いいえ | `development` | `production` にするとスタックトレースを隠し、セキュアCookieを有効化。 |
| `DEFAULT_CHAT_MODEL` | いいえ | `gpt-4o-mini` | チャットとコード生成のデフォルトモデル。 |
| `DEFAULT_CODE_MODEL` | いいえ | `qwen3-coder-plus` | コード生成のデフォルトモデル。 |
| `DEFAULT_IMAGE_MODEL` | いいえ | `gpt-image-2` | 画像生成のデフォルトモデル。 |
| `DEFAULT_IMAGE_EDITOR_MODEL` | いいえ | `gpt-image-2` | 画像テキストエディタのデフォルトモデル。 |
| `ONE_MIN_AI_API_BASE_URL` | いいえ | `https://api.1min.ai` | 1min.ai APIのベースURL。モックサーバーやステージング向け。 |
| `ALLOWED_ROOTS` | いいえ | 現在のプロジェクトルート | 参照・編集可能なルート一覧。カンマ区切り。 |
| `ENABLE_COMMAND_EXECUTION` | いいえ | `false` | エージェントのコマンド実行を有効化します。 |
| `COMMAND_TIMEOUT_MS` | いいえ | `30000` | コマンド実行のタイムアウト時間。 |
| `AGENT_AUTO_APPROVE` | いいえ | `false` | 承認なし実行の可否。原則 false。 |
| `LOCAL_BFF_AUTH_TOKEN` | いいえ | 自動生成 | ローカルBFF認証トークン。未設定なら毎回自動生成。 |
| `LOG_LEVEL` | いいえ | `info` | ログレベル（`error`, `warn`, `info`, `debug`）。 |
| `LOG_TO_FILE` | いいえ | `false` | `true` でログファイル出力を有効化。 |

## 構成

```text
server.js                  # Express BFF / 1min.ai API proxy / asset upload
routes/ai.js               # チャット・画像生成・コード生成API
routes/fs.js               # プロジェクト内ファイルの閲覧・保存API
utils/api-client.js        # 1min.ai API呼び出し・レスポンス抽出
utils/fs-guard.js          # ファイルパスのプロジェクト内限定チェックと保護パス検証
config/models.js           # UIで選択できるモデル一覧
public/index.html          # UI
public/app.js              # フロントエンドロジック
public/js/api.js           # フロントエンド共通API関数
public/js/models.js        # モデルピッカーロジック
public/styles.css          # スタイル
docs/api-specifications.md  # 1min.ai API仕様
package.json
```

開発手順やAPIマッピングの詳細は、必要に応じて `docs/` ディレクトリに追加してください。

## ローカルAPI

| メソッド | パス | 説明 |
| --- | --- | --- |
| `GET` | `/api/health` | サーバー起動状態とAPIキー設定有無を確認。 |
| `GET` | `/api/models` | チャット・コード・画像モデル一覧を返す。 |
| `POST` | `/api/chat` | 1min.ai Chat with AI APIへ中継。 |
| `POST` | `/api/conversations` | 会話履歴用の conversation を作成。 |
| `POST` | `/api/images/generate` | 1min.ai AI Feature APIの `IMAGE_GENERATOR` へ中継。 |
| `POST` | `/api/images/text-editor` | 1min.ai AI Feature APIの `IMAGE_EDITOR` へ中継。 |
| `POST` | `/api/assets/upload` | ローカルから受け取った画像を 1min.ai Asset APIへアップロード。 |
| `POST` | `/api/code/generate` | 選択中のコード全体に対する生成・修正依頼。 |
| `POST` | `/api/code/autocomplete` | Monaco Editorのインライン補完候補を生成。 |
| `POST` | `/api/code/inline-chat` | カーソル位置でのインライン編集を生成。 |
| `GET` | `/api/fs/config` | プロジェクトルートを返す。 |
| `GET` | `/api/fs/list?dir=...` | 指定ディレクトリのファイル一覧を返す。 |
| `GET` | `/api/fs/read?path=...` | 指定ファイルを読む。 |
| `POST` | `/api/fs/write` | 指定ファイルを書き込む。 |
| `POST` | `/api/fs/create` | 指定パスにファイルまたはディレクトリを作成する。 |
| `POST` | `/api/fs/delete` | 指定ファイルまたはディレクトリを削除する。 |
| `POST` | `/api/fs/rename` | 指定ファイルまたはディレクトリを移動・改名する。 |

## 使い方

### チャット

1. 左メニューの「通常チャット」を開く。
2. モデルを選択する。
3. メッセージを入力して送信する。
4. 会話履歴を使いたい場合は「会話を新規作成」を実行し、返されたIDを `conversationId` に入力する。

### 画像生成 / テキスト編集

1. 左メニューの「画像生成 / テキスト編集」を開く。
2. 画像生成ではプロンプト・モデル・アスペクト比・枚数を入力する。
3. 画像テキストエディタでは、元画像をアップロードして返された asset key、または既存の画像 URL を入力します。
4. 編集プロンプト・モデル・出力サイズ・品質・枚数などを指定して「画像を編集」を実行します。

### コーディング補助

1. 左メニューの「コーディング」を開く。
2. ファイルツリーからファイルを開く。
3. 右側のAI Codingで指示を入力し、「実行」を押す。
4. 必要に応じて「最初のコードブロックをエディタに適用」で結果をエディタに反映する。
5. `Ctrl+S` で保存、`Ctrl+I` でインラインチャットを開けます。

## Monaco Editorのローカルコピー設定（オフライン開発向け）

デフォルトでは Monaco Editor は CDN (`https://cdn.jsdelivr.net`) から読み込まれます。
完全オフライン環境や特定バージョンを固定したい場合は、以下の手順で `public/vs/` に配置します。

```bash
# 1. プロジェクトルートで Monaco Editor をインストール
npm install monaco-editor

# 2. public/vs/ にコピー（もしくはシンボリックリンク）
cp -r node_modules/monaco-editor/min/vs public/vs
# Windows: xcopy /E /I node_modules\monaco-editor\min\vs public\vs
```

配置後は `public/index.html` に変更は不要です（`require.config({ paths: { vs: "/vs" } })` により自動的に `public/vs/` を参照します）。

> **注意**: プロジェクトの `.gitignore` に `public/vs/` が含まれていることを確認してください。Monaco Editorはライセンス上、再頒布可能ですが巨大なバイナリであるため、Git管理する必要はありません。

## 1min.ai APIとの連携

このアプリは以下の1min.ai APIを利用します。

- Base URL: `https://api.1min.ai`
- 認証: `API-KEY` ヘッダーを使用します（公式ドキュメント準拠）。クライアントは互換性のために `Authorization: Bearer` ヘッダーも同時に送信します。
- Chat with AI API: `POST /api/chat-with-ai`
- AI Feature API: `POST /api/features`
- Asset API: `POST /api/assets`
- Conversation API: `POST /api/conversations`

参考:

- [1min.AI API Reference](https://docs.1min.ai/docs/api/intro)
- [Chat with AI API](https://docs.1min.ai/docs/api/chat-with-ai-api)
- [AI Feature API](https://docs.1min.ai/docs/api/ai-feature-api)
- [Asset API](https://docs.1min.ai/docs/api/asset-api)
- [Image Text Editor API](https://docs.1min.ai/docs/api/ai-for-image/image-text-editor/image-text-editor-tag)
- [Rate Limits](https://docs.1min.ai/docs/api/specifications/rate-limits)

## 注意

- `.env` をGitにコミットしないでください。本リポジトリの `.gitignore` は `.env` を除外していますが、**もし `.env` を誤ってコミットしてしまった場合は必ず 1min.ai 側で API キーを再生成（ローテーション）してください**。Git の履歴に残ったキーは `git filter-repo` 等での除去後も危険です。
- `/api/fs/*` はプロジェクト配下のファイルを読み書きできます。`.env`、`.git`、`node_modules`、サーバー実装ファイルなどの保護パスは削除・上書き・改名からガードしています。公開サーバーで動かさないでください。
- Asset uploadはデフォルトで `25MB` までです（`MAX_FILE_SIZE` 環境変数で変更可能）。1min.ai公式のAsset APIドキュメントでは上限例として `50MB` が記載されています。
- 公式ドキュメントではレート制限のデフォルトは `180 requests per minute` とされています。Asset APIページには `100 requests per minute` / `5 simultaneous uploads` の記載もあるため、実際のプラン制限は1min.ai側で確認してください。
- 生成画像のURL表示は、1min.ai側の返却形式・権限設定に依存します。画像が直接表示されない場合でも、Raw JSON内の `resultObject` やAsset情報を確認してください。
- これはMVPです。実運用では認証、レート制限、監査ログ、サンドボックス実行、CSRF対策などを追加してください。

## 既知の改善候補

- 1min.ai APIのレスポンス形式は機能・モデルによって異なるため、フロント側で複数のフィールドからテキストや画像URLを抽出しています。
- Asset uploadのフィールド名は、1min.ai公式ドキュメントに従い `asset` を使用しています。
- `/api/fs/*` はローカル開発向けです。公開環境で利用する場合は、認証、CSRF対策、監査ログ、実行サンドボックス、保護パスの運用ポリシーを強化してください。
- コーディングエージェントのコマンド実行は `ENABLE_COMMAND_EXECUTION=true` にした場合のみ有効です。実運用では承認フローとログ監査を必須にしてください。
- （Q-2）エージェントのファイル検索は現在 `grep` / `findstr` に依存しています。`ripgrep` をオプションの依存関係として追加し、高速な検索を提供することを検討してください。

## ソーシャルプレビュー画像

GitHubリポジトリのソーシャルプレビュー画像は `docs/screenshots/og-image.png` に配置することで設定できます。
推奨サイズ: 1280×640px。画像がない場合はデフォルトのOGPが使用されます。

## ライセンス

このプロジェクトは明示的なライセンスが設定されていません。
詳しくはリポジトリオーナーにお問い合わせください。