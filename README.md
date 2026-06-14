# 1min.ai Monaco Client

Monaco Editor + 自前UI + 1min.ai API で構成した、ブラウザで動くAIクライアントMVPです。

## 機能

- 通常チャット
- 会話作成 / conversationId指定
- 画像生成
- Asset APIによる画像アップロード
- i2i / 画像バリエーション
- Monaco Editor統合
- コード説明・生成・リファクタリング補助
- APIキーをフロントエンドに出さないサーバー中継構成

## 必要環境

- Node.js 18以上
- 1min.ai API Key
- Monaco Editor CDNを読み込むため、初回表示時はインターネット接続が必要です

## 起動方法

```bash
cp .env.example .env
# .env の ONE_MIN_AI_API_KEY を編集
npm install
npm start
```

ブラウザで以下を開きます。

```text
http://localhost:3000
```

## .env

```env
ONE_MIN_AI_API_KEY=your_1min_ai_api_key_here
PORT=3000
DEFAULT_CHAT_MODEL=gpt-4o-mini
DEFAULT_IMAGE_MODEL=black-forest-labs/flux-schnell
DEFAULT_VARIATION_MODEL=magic-art
```

## 構成

```text
server.js                  # Express BFF / 1min.ai API proxy
public/index.html          # UI
public/app.js              # フロントエンドロジック
public/styles.css          # スタイル
package.json
.env.example
```

## 実装メモ

- チャットは `/api/chat-with-ai` に `type: "UNIFY_CHAT_WITH_AI"` で中継します。
- 画像生成と画像バリエーションは `/api/features` に中継します。
- 画像アップロードは `/api/assets` に中継します。
- 1min.ai APIのレスポンス形式がモデル/機能により異なる可能性があるため、フロント側では柔軟にテキスト・画像URLを抽出しています。

## 注意

- `.env` をGitにコミットしないでください。
- 生成画像のURL表示は、1min.ai側の返却形式・権限設定に依存します。画像が直接表示されない場合でも、Raw JSON内の `resultObject` やAsset情報を確認してください。
- これはMVPです。実運用では認証、レート制限、監査ログ、サンドボックス実行、CSRF対策などを追加してください。
