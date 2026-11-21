# 1min.ai Monaco Client

> 🌐 [日本語](README.md) | [English](README.en.md) | [中文](README.zh.md) | [한국어](README.ko.md) | [Español](README.es.md)

> [!WARNING]
> **本アプリケーションはローカル環境（localhost/127.0.0.1）での個人開発およびシングルユーザー利用を前提に設計されています。**  
> `/api/fs/*` (ファイルシステム操作) やエージェントのコマンド実行機能には、マルチユーザー向けのロールベースアクセス制御 (RBAC) や詳細なログ監査、サンドボックス実行といったエンタープライズ向けの堅牢な保護機構は含まれていません。パブリックなインターネット上のサーバーや、共有の開発・ステージング環境などへ**絶対にデプロイしないでください**。
>
> **【重要】AI Agent の OS コマンド実行に関するセキュリティ警告**
>
> - エージェント機能で OS コマンド実行（`ENABLE_COMMAND_EXECUTION=true`）を有効にする場合、AIが任意のコード（例: 悪意のあるパッケージのインストールや実行など）をトリガーするリスクがあります。
> - 原則として **`AGENT_AUTO_APPROVE=false`（デフォルト）** で稼働させ、実行前に人間がコマンドの安全性を必ず目視で確認してください。自動承認（`AGENT_AUTO_APPROVE=true`）を設定する場合は、完全に隔離されたサンドボックスや Docker コンテナ環境で使用してください。

Monaco Editor + カスタム UI + **1min.ai API** & **1forall.ai API** に対応した、ローカル起動型マルチプロバイダ AI クライアントです。  
API キーをフロントエンドに露出せず Express サーバーを BFF として中継する構成になっており、`.env` または画面上の設定パネルからプロバイダ切り替え・API キーの登録・検証を行えます。

## 主な機能

- マルチプロバイダ対応（トップバーから `1min.ai` / `1forall.ai` を即座に切り替え可能）
- Settings 画面からの API キー登録・疎通検証・削除（`.onemin-ai/data/api_keys.json` へ安全に永続化、`.env` キー未設定でも起動可能）
- 通常チャット（1min.ai 会話履歴 / Web Search / ハイブリッド OpenAI 互換ルーティング、1forall.ai 履歴付き SSE ストリーミング）
- モデルピッカーのカテゴリ分け＆プロバイダ別動的カタログ更新
- 画像生成・画像テキストエディタ・Asset アップロード（1min.ai / 1forall.ai 両対応）
- 動画生成（Text-to-Video & Image-to-Video、非同期ジョブ自動ポーリング、`Range` 対応プロキシによる `<video>` 再生）
- Monaco Editor 統合・コード生成・インライン補完・インラインチャット
- 高機能 AI Coding エージェント（XML ツール呼び出し、承認フロー、`.onemin-ai/` 永続化）
- 堅牢なファイルパス・環境変数セキュリティガード (`fs-guard`, `env-guard`)

## 必要環境

- Node.js 18以上
- 1min.ai API Key または 1forall.ai API Key（`.env` またはアプリ内の「設定」パネルで入力）
- `npm start` 時に Monaco Editor / marked / DOMPurify が `public/` に自動コピーされるため、`npm install` 後はインターネット接続は不要です（Google Fonts の読み込みと API 通信を除く）

## クイックスタート

```bash
cp .env.example .env
# 任意: .env に ONE_MIN_AI_API_KEY / ONE_FOR_ALL_API_KEY を設定（設定画面からも登録可）
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

| 変数                              | 必須   | デフォルト               | 説明                                                                                                  |
| --------------------------------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ONE_MIN_AI_API_KEY`              | いいえ | なし                     | 1min.ai API キー。`.env` または Settings UI から設定可能。                                             |
| `ONE_FOR_ALL_API_KEY`             | いいえ | なし                     | 1forall.ai API キー。`.env` または Settings UI から設定可能。                                          |
| `DEFAULT_PROVIDER`                | いいえ | `1min`                   | 初期選択プロバイダ（`1min` / `1forall`）。                                                             |
| `ONE_MIN_AI_OPENAI_COMPAT`        | いいえ | `auto`                   | 1min.ai Code / Agent での `/openai/v1` ハイブリッド利用設定（`auto` / `force` / `off`）。                |
| `ONE_FOR_ALL_API_BASE_URL`        | いいえ | `https://api.1forall.ai` | 1forall.ai API のベース URL。                                                                          |
| `ONE_FOR_ALL_S3_BUCKETS`          | いいえ | `voicegen-storage,tts-clariteia` | アセットプロキシで許可する 1forall S3 バケット（カンマ区切り）。                                       |
| `ONE_FOR_ALL_UPLOAD_FIELD`        | いいえ | `file`                   | `POST /v1/external/image/upload/` のバイナリフィールド名の上書き用。                                   |
| `ONE_FOR_ALL_MAX_TOKENS_AUTOCOMPLETE` | いいえ | `256`                | 1forall 補完用のデフォルト `max_tokens`（モデルの `min_max_tokens` 未満にはしない）。                   |
| `ONE_FOR_ALL_MAX_TOKENS_INLINE`   | いいえ | `1024`                   | 1forall インラインチャット用のデフォルト `max_tokens`。                                                |
| `ONE_FOR_ALL_MAX_TOKENS_CHAT`     | いいえ | `4096`                   | 1forall チャット・コード用のデフォルト `max_tokens`。                                                  |
| `PORT`                            | いいえ | `3000`                   | ローカルExpressサーバーの待ち受けポート。                                                             |
| `NODE_ENV`                        | いいえ | `development`            | `production` にするとスタックトレースを隠し、セキュアCookieを有効化。                                 |
| `MAX_FILE_SIZE`                   | いいえ | `26214400`               | アセットのアップロード制限サイズ（バイト、デフォルト25MB）。                                          |
| `MAX_JSON_BODY_SIZE`              | いいえ | `2mb`                    | JSONリクエストボディのサイズ上限。                                                                    |
| `DEFAULT_CHAT_MODEL`              | いいえ | `gpt-4o-mini`            | チャットとコード生成のデフォルトモデル。                                                              |
| `DEFAULT_CODE_MODEL`              | いいえ | `qwen3-coder-plus`       | コード生成のデフォルトモデル。                                                                        |
| `DEFAULT_IMAGE_MODEL`             | いいえ | `gpt-image-2`            | 画像生成のデフォルトモデル。                                                                          |
| `DEFAULT_IMAGE_EDITOR_MODEL`      | いいえ | `gpt-image-2`            | 画像テキストエディタのデフォルトモデル。                                                              |
| `DEFAULT_VIDEO_MODEL`             | いいえ | `kling`                  | 1min.ai 動画生成のデフォルトモデル。                                                                   |
| `DEFAULT_CHAT_MODEL_1FORALL`      | いいえ | `gpt-4o-mini`            | 1forall チャット既定モデル。                                                                           |
| `DEFAULT_CODE_MODEL_1FORALL`      | いいえ | `gpt-4o`                 | 1forall コード既定モデル。                                                                             |
| `DEFAULT_IMAGE_MODEL_1FORALL`     | いいえ | `black-forest-labs/flux-schnell` | 1forall 画像生成既定モデル。                                                                   |
| `DEFAULT_IMAGE_EDITOR_MODEL_1FORALL` | いいえ | `stable-diffusion-image` | 1forall 画像編集既定モデル。                                                                       |
| `DEFAULT_VIDEO_MODEL_1FORALL`     | いいえ | `google-veo3`            | 1forall 動画生成既定モデル。                                                                           |
| `ONE_MIN_AI_API_BASE_URL`         | いいえ | `https://api.1min.ai`    | 1min.ai APIのベースURL。モックサーバーやステージング向け。                                            |
| `ASSET_PROXY_TIMEOUT_MS`          | いいえ | `30000`                  | アセットプロキシのタイムアウト（ミリ秒）。                                                            |
| `ASSET_PROXY_MAX_SIZE`            | いいえ | `50mb`                   | プロキシ済みアセットの最大レスポンスサイズ（`b`/`kb`/`mb`/`gb`接尾辞可）。                            |
| `API_TIMEOUT`                     | いいえ | `60000`                  | 1min.ai API リクエストのタイムアウト（ミリ秒）。                                                      |
| `API_RETRY_ATTEMPTS`              | いいえ | `3`                      | 1min.ai API エラー発生時の最大リトライ回数。                                                          |
| `API_RETRY_DELAY`                 | いいえ | `2000`                   | リトライ時のベース遅延時間（ミリ秒）。                                                                |
| `RATE_LIMIT_WINDOW_MS`            | いいえ | `60000`                  | レート制限の対象時間（ミリ秒）。                                                                      |
| `RATE_LIMIT_MAX`                  | いいえ | `180`                    | 時間枠あたりの標準エンドポイントの最大リクエスト数。                                                  |
| `RATE_LIMIT_AUTOCOMPLETE_MAX`     | いいえ | `600`                    | 補完APIの最大リクエスト数。                                                                           |
| `RATE_LIMIT_CHAT_MAX`             | いいえ | `300`                    | チャットAPIの最大リクエスト数。                                                                       |
| `SESSION_TTL_MS`                  | いいえ | `1800000`                | エージェントセッションの有効期間（ミリ秒、デフォルト30分）。                                          |
| `ALLOWED_ROOTS`                   | いいえ | 現在のプロジェクトルート | 参照・編集可能なルート一覧。カンマ区切り。                                                            |
| `ENABLE_COMMAND_EXECUTION`        | いいえ | `false`                  | エージェントのコマンド実行を有効化します。                                                            |
| `COMMAND_TIMEOUT_MS`              | いいえ | `30000`                  | コマンド実行のタイムアウト時間。                                                                      |
| `AGENT_AUTO_APPROVE`              | いいえ | `false`                  | 承認なし実行の可否。原則 false。                                                                      |
| `ALLOW_UNSAFE_AGENT_AUTO_APPROVE` | いいえ | `false`                  | `ENABLE_COMMAND_EXECUTION=true` かつ `AGENT_AUTO_APPROVE=true` を隔離環境で明示許可する起動用フラグ。 |
| `AGENT_MAX_LOOPS`                 | いいえ | `20`                     | エージェントの最大ループ反復回数 (1-100)。                                                            |
| `AGENT_MAX_SESSIONS`              | いいえ | `50`                     | メモリ上に保持する最大エージェントセッション数。                                                      |
| `ENABLE_DRIVES_SHELL_LOOKUP`      | いいえ | `true`                   | Windows環境でドライブ一覧取得にPowerShell等を使用するかどうか。                                       |
| `LOCAL_BFF_AUTH_TOKEN`            | いいえ | 自動生成                 | ローカルBFF認証トークン。未設定なら毎回自動生成。                                                     |
| `LOG_LEVEL`                       | いいえ | `info`                   | ログレベル（`error`, `warn`, `info`, `debug`）。                                                      |
| `LOG_TO_FILE`                     | いいえ | `false`                  | `true` でログファイル出力を有効化。                                                                   |
| `LOG_FILE`                        | いいえ | `logs/app.log`           | ログ出力先のファイルパス。                                                                            |

## 構成

```text
server.js                        # Express BFF / asset upload & proxy / static UI
providers/                       # Multi-provider adapters (1min.ai, 1forall.ai)
services/key-store.js            # UI + env API key persistence & resolution
routes/settings.js               # Provider status & API key management endpoints
routes/ai/                       # Multi-provider chat, code, image, video, job, model APIs
routes/agent.js                  # AI coding agent session routes
routes/agent-chat.js             # Multi-provider coding agent turn runner
routes/fs.js                     # プロジェクト内ファイルの閲覧・保存API
utils/api-client.js              # 1min.ai API呼び出し・レスポンス抽出
utils/http-client.js             # Shared retry/timeout HTTP client factory
utils/sse.js                     # OpenAI & synthetic SSE normalization
utils/fs-guard.js                # ファイルパスのプロジェクト内限定チェックと保護パス検証
config/models.js                 # UIで選択できるモデル一覧・動的取得
public/index.html                # UI
public/app.js                    # フロントエンドロジック
public/js/api.js                 # フロントエンド共通API関数
public/js/settings.js            # 設定画面・APIキー管理・プロバイダ切替UI
public/js/model-picker.js        # モデルピッカーロジック
public/js/image.js               # 画像＆動画生成・編集・ジョブポーリングUI
docs/api-specifications.md       # 1min.ai API仕様
docs/api-specifications-1forall.md # 1forall.ai API仕様
package.json
```

開発手順やAPIマッピングの詳細は、`docs/api-specifications.md` および `docs/api-specifications-1forall.md` を参照してください。

## ローカルAPI

| メソッド | パス                                   | 説明                                                                                 |
| -------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET`    | `/api/health`                          | サーバー起動状態とプロバイダ別 API キー設定有無を確認。                              |
| `GET`    | `/api/settings/providers`              | 各プロバイダの設定状況・マスク済みキー・機能フラグ（capabilities）を取得。           |
| `POST`   | `/api/settings/keys`                   | API キーの疎通検証およびサーバー側保存（`.onemin-ai/data/api_keys.json`）。          |
| `DELETE` | `/api/settings/keys/:provider`         | UI から登録した API キーを削除し `.env` 設定または未設定へ戻す。                     |
| `GET`    | `/api/models?provider=...`             | 指定プロバイダのチャット・コード・画像・動画モデル一覧を返す。                       |
| `POST`   | `/api/models/refresh`                  | 選択プロバイダのモデルカタログを手動再取得する。                                     |
| `POST`   | `/api/chat`                            | 選択プロバイダ（1min.ai / 1forall.ai）のチャット API へ中継（SSE 対応）。            |
| `POST`   | `/api/conversations`                   | 会話履歴用の conversation を作成（1min.ai）。                                        |
| `POST`   | `/api/images/generate`                 | 選択プロバイダの画像生成 API へ中継。                                                |
| `POST`   | `/api/images/text-editor`              | 選択プロバイダの画像編集 API へ中継（1min.ai / 1forall image-to-image）。            |
| `POST`   | `/api/videos/generate`                 | Text-to-Video / Image-to-Video ジョブを開始し `jobId` を返す。                       |
| `GET`    | `/api/jobs/:provider/:kind/:jobId`     | 非同期生成ジョブ（`image` / `video` / `llm`）の完了状態と成果物 URL を取得。         |
| `POST`   | `/api/assets/upload`                   | ローカルから受け取った画像をプロバイダのアセットストレージへアップロード。           |
| `POST`   | `/api/code/generate`                   | 選択中のコード全体に対する生成・修正依頼。                                           |
| `POST`   | `/api/code/autocomplete`               | Monaco Editorのインライン補完候補を生成。                                            |
| `POST`   | `/api/code/inline-chat`                | カーソル位置でのインライン編集を生成。                                               |
| `GET`    | `/api/fs/config`          | プロジェクトルートを返す。                                     |
| `GET`    | `/api/fs/list?dir=...`    | 指定ディレクトリのファイル一覧を返す。                         |
| `GET`    | `/api/fs/read?path=...`   | 指定ファイルを読む。                                           |
| `POST`   | `/api/fs/write`           | 指定ファイルを書き込む。                                       |
| `POST`   | `/api/fs/create`          | 指定パスにファイルまたはディレクトリを作成する。               |
| `POST`   | `/api/fs/delete`          | 指定ファイルまたはディレクトリを削除する。                     |
| `POST`   | `/api/fs/rename`          | 指定ファイルまたはディレクトリを移動・改名する。               |

## 使い方

### チャット

1. 左メニューの「通常チャット」を開く。
2. モデルを選択する。
3. メッセージを入力して送信する。
4. 会話履歴を使いたい場合は「会話を新規作成」を実行し、返されたIDを `conversationId` に入力する。

### 画像生成 / 画像編集 / 動画生成

1. 左メニューの「画像生成 / テキスト編集」を開く（モードタブで画像生成・画像編集・動画生成を切り替え）。
2. 画像生成ではプロンプト・モデル・アスペクト比・枚数を入力する。
3. 画像テキストエディタや Image-to-Video では、元画像をアップロードして返されたキー / URL を入力します。
4. 動画生成（Text-to-Video / Image-to-Video）ではモデル・尺・解像度・音声設定を指定して実行し、非同期完了後に `<video>` プレーヤーで確認できます。

### 設定 / API キー管理

1. 左メニューの「設定」または上部ヘッダーのプロバイダ切替バーから `1min.ai` / `1forall.ai` を選択できます。
2. API キーを UI から入力すると疎通検証後にサーバー側 `.onemin-ai/data/api_keys.json` に安全に保存されます（フロントエンドへ生キーは返却されません）。

### コーディング補助

1. 左メニューの「コーディング」を開く。
2. ファイルツリーからファイルを開く。
3. 右側のAI Codingで指示を入力し、「実行」を押す。
4. 必要に応じて「最初のコードブロックをエディタに適用」で結果をエディタに反映する。
5. `Ctrl+S` で保存、`Ctrl+I` でインラインチャットを開けます。

## Monaco Editor / 第三パーティライブラリのローカルコピー

Monaco Editor、marked、DOMPurify は `npm start`（または `npm run dev`）の起動時に `scripts/copy-monaco.js` / `scripts/copy-vendor.js` によって `node_modules` から `public/` に自動コピーされます。手動での CDN 設定は不要です。

- `public/vs/` — Monaco Editor ファイル（`.gitignore` 対象）
- `public/vendor/marked.min.js` — marked パーサー（`.gitignore` 対象）
- `public/vendor/purify.min.js` — DOMPurify サニタイザ（`.gitignore` 対象）

## 外部プロバイダ API との連携

### 1min.ai

- Base URL: `https://api.1min.ai`
- 認証: ネイティブ API (`/api/*`) は `API-KEY` ヘッダー、OpenAI 互換 API (`/openai/v1/*`) は `Authorization: Bearer` ヘッダーを使用。
- Chat with AI API: `POST /api/chat-with-ai`
- OpenAI-Compatible API: `GET /openai/v1/models`, `POST /openai/v1/chat/completions`
- AI Feature / Async Result API: `POST /api/features` (`async: true`), `GET /api/results/:resultId`
- Asset / Conversation API: `POST /api/assets`, `POST /api/conversations`

### 1forall.ai

- Base URL: `https://api.1forall.ai`
- 認証: `Authorization: Bearer`（ネイティブ / OpenAI 互換共通）。
- OpenAI-Compatible API: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/images/generations`
- Native External Image / Video / LLM API: `/v1/external/image/*`, `/v1/external/video/*`, `/v1/external/llm/*`

参考:

- [1min.AI API Reference](https://docs.1min.ai/docs/api/intro)
- [1min.AI OpenAI-compatible API](https://docs.1min.ai/docs/api/openai-compatible)
- [1min.AI Get Result API](https://docs.1min.ai/docs/api/get-result)
- [1forall.ai Swagger UI (OpenAPI)](https://api.1forall.ai/v1/external/swagger-ui/)
- [詳細仕様: docs/api-specifications.md](docs/api-specifications.md) / [docs/api-specifications-1forall.md](docs/api-specifications-1forall.md)
- [Android アプリビルドガイド (Capacitor + nodejs-mobile)](docs/android.md)

## 注意

- `.env` をGitにコミットしないでください。本リポジトリの `.gitignore` は `.env` を除外していますが、**もし `.env` を誤ってコミットしてしまった場合は必ず 1min.ai 側で API キーを再生成（ローテーション）してください**。Git の履歴に残ったキーは `git filter-repo` 等での除去後も危険です。
- `/api/fs/*` はプロジェクト配下のファイルを読み書きできます。`.env`、`.git`、`node_modules`、サーバー実装ファイル、本アプリの永続化データ（`.onemin-ai/`）や他エージェントの設定（`.mimocode/`、`.commandcode/`）などの保護パスは削除・上書き・改名からガードしています。公開サーバーで動かさないでください。
- Asset uploadはデフォルトで `25MB` までです（`MAX_FILE_SIZE` 環境変数で変更可能）。1min.ai公式のAsset APIドキュメントでは上限例として `50MB` が記載されています。
- 公式ドキュメントではレート制限のデフォルトは `180 requests per minute` とされています。Asset APIページには `100 requests per minute` / `5 simultaneous uploads` の記載もあるため、実際のプラン制限は1min.ai側で確認してください。
- 生成画像のURL表示は、1min.ai側の返却形式・権限設定に依存します。画像が直接表示されない場合でも、Raw JSON内の `resultObject` やAsset情報を確認してください。
- これはMVPです。実運用では認証、レート制限、監査ログ、サンドボックス実行、CSRF対策などを追加してください。

## 既知の改善候補

- 1min.ai APIのレスポンス形式は機能・モデルによって異なるため、フロント側で複数のフィールドからテキストや画像URLを抽出しています。
- Asset uploadのフィールド名は、1min.ai公式ドキュメントに従い `asset` を使用しています。
- `/api/fs/*` はローカル開発向けです。公開環境で利用する場合は、認証、CSRF対策、監査ログ、実行サンドボックス、保護パスの運用ポリシーを強化してください。
- コーディングエージェントのコマンド実行は `ENABLE_COMMAND_EXECUTION=true` にした場合のみ有効です。実運用では承認フローとログ監査を必須にしてください。
- エージェントのファイル全体書き換えは、既存ファイル・新規ファイルのいずれも差分プレビューによるユーザー確認を経てから適用されます。
- `ENABLE_COMMAND_EXECUTION=true` と `AGENT_AUTO_APPROVE=true` を同時に使う場合、サーバーは `ALLOW_UNSAFE_AGENT_AUTO_APPROVE=true` が明示されていない限り起動を拒否します。この上書きは隔離済みの Docker / VM / 使い捨て環境でのみ使用してください。
- （Q-2）エージェントのファイル検索は `ripgrep`（`rg`）がシステムにインストールされている場合に自動的に使用されます。`rg` がない場合は `grep` / `findstr`（環境に応じて）によるフォールバック検索に切り替わります。
- Apply_diffのプレビュー画面がうまく表示されないことがあります。
- 両プロバイダのモデルカタログは各 OpenAI 互換モデルエンドポイントおよび 1forall ネイティブモデルエンドポイントから動的取得でき、未設定時やオフライン時は `config/models.json` にフォールバックします。

## ライセンス

MIT License
