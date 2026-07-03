# 1min.AI API 開発詳細仕様書 (Full API Specifications)

このドキュメントでは、本アプリケーションを開発・拡張・保守していく上で重要となる **1min.AI API** の仕様について、公式ドキュメント（[1min.AI API Reference](https://docs.1min.ai/docs/api/intro)）に基づき網羅的に解説します。

---

## 1. 共通仕様 ＆ 制限事項 (Common Specifications & Limitations)

### 接続先基本情報

- **Base URL**: `https://api.1min.ai`
- **データ形式**: リクエスト、レスポンスともに `application/json` 形式を基本とします（Asset API のアップロードのみ `multipart/form-data`）。

### 認証ヘッダー (Authentication)

全てのAPIリクエストには、認証用として以下のヘッダーを付与する必要があります。

- **必須**: `API-KEY: <YOUR_API_KEY>`

> [!NOTE]
> 本アプリケーションのバックエンド（[api-client.js](../utils/api-client.js)）では、環境変数 `ONE_MIN_AI_API_KEY` を用いて、自動的にリクエストヘッダーを設定するよう実装されています。

### 制限事項 (Limits)

- **レートリミット (Rate Limits)**: デフォルトで **1分間あたり 180 リクエスト** に制限されています。上限緩和が必要な場合は `support@1min.ai` へ連絡します。
- **クレジット制限 (Credits Limits)**: APIキーを所有するチーム内でユーザーが利用できる総クレジット量。詳細な制限はチーム管理者ロールを持つアカウントで [Members 管理画面](https://app.1min.ai/members) から確認できます。

---

## 2. アセットAPI (Asset API)

画像処理、PDF文書解析、その他のファイルをAIに受け渡す前に、本エンドポイントを使用してファイルをアップロードし、一時アセット化する必要があります。

- **エンドポイント**: `POST /api/assets`
- **Content-Type**: `multipart/form-data`

### リクエストパラメータ

| パラメータ名 | タイプ          | 必須 | 説明                                                      |
| :----------- | :-------------- | :--: | :-------------------------------------------------------- |
| `asset`      | File (バイナリ) |  ✔   | アップロードするファイル（画像、PDF、ドキュメントなど）。 |

### レスポンスペイロード (200 OK)

成功すると、アップロードされたアセットの識別キーや永続URL（Amazon S3）を含む詳細なメタデータが返却されます。

```json
{
  "asset": {
    "fieldname": "asset",
    "originalname": "example.png",
    "encoding": "7bit",
    "mimetype": "image/png",
    "size": 12368,
    "bucket": "asset.1min.ai",
    "key": "images/2024_09_30_13_38_59_100_example.png",
    "acl": "private",
    "contentType": "application/octet-stream",
    "contentDisposition": null,
    "contentEncoding": null,
    "storageClass": "STANDARD",
    "serverSideEncryption": null,
    "metadata": {
      "team-id": "307b3666-0869-4910-9d01-75fc14a08c4d",
      "user-id": "52555103-410b-4ea0-881c-d6f3453f2469",
      "fieldname": "asset",
      "originalname": "example.png",
      "encoding": "7bit",
      "mimetype": "image/png"
    },
    "location": "https://asset.1min.ai.s3.us-east-1.amazonaws.com/images/2024_09_30_13_38_59_100_example.png",
    "etag": "\"2cb9318ab87188247c8ed71e1d4078d9\""
  },
  "fileContent": {
    "uuid": "26f30dfd-1d61-4b5b-889c-d7ab2d60d1ee",
    "path": "images/2024_09_30_13_38_59_100_example.png",
    "type": "png",
    "name": "2024_09_30_13_38_59_100_example.png",
    "content": "",
    "status": "ACTIVE",
    "metadata": {
      "token": 0,
      "character": 0
    },
    "createdAt": "2024-09-30T06:39:00.540Z"
  }
}
```

### 開発での活用

アップロード成功後に得られる `asset.key`（または `fileContent.path`）を、通常チャットの `promptObject.attachments` や画像編集の `promptObject.imageUrl` に渡すことで、AI機能のインプットとして利用します。

---

## 3. 通常チャット (Unify Chat with AI)

全てのチャットインタラクションを一つのエンドポイントに統合したAPIです。ストリーミング、Webグラウンディング、画像・ファイル添付、会話履歴、AIメモリ機能をサポートします。

> [!WARNING]
> レガシーなチャットタイプ (`CHAT_WITH_AI`, `CHAT_WITH_IMAGE`, `CHAT_WITH_PDF` 等) は非推奨となりました。全てのチャット機能の実装には、本APIを使用し、`type` に `"UNIFY_CHAT_WITH_AI"` を指定してください。

### エンドポイント

- **Non-Streaming**: `POST /api/chat-with-ai`
- **Streaming**: `POST /api/chat-with-ai?isStreaming=true`

### リクエストパラメータ (JSON)

| パラメータ名   | タイプ | 必須 | 説明                                                                |
| :------------- | :----- | :--: | :------------------------------------------------------------------ |
| `type`         | string |  ✔   | フィーチャー名。必ず `"UNIFY_CHAT_WITH_AI"` を指定。                |
| `model`        | string |  ✔   | 使用するAIモデル名（例: `gpt-4o-mini`, `claude-sonnet-4-6` など）。 |
| `promptObject` | object |  ✔   | チャット構成設定オブジェクト（以下詳細）。                          |
| `brandVoiceId` | string |      | ブランドボイス機能のUUID（カスタムトーンの適用時）。                |
| `metadata`     | object |      | リクエストに関連付ける任意の追加のメタデータ。                      |

#### `promptObject` 内部パラメータ

- **`prompt`** (string/必須): ユーザーの入力テキストメッセージ。
- **`conversationId`** (string/任意): 会話スレッドのUUID。複数ターンの会話で文脈を維持する際に必要。
- **`settings`** (object/任意):
  - **`webSearchSettings`** (object/任意):
    - `webSearch` (boolean): `true` でWeb検索（RAG/グラウンディング）を有効化（デフォルト: `false`）。
    - `numOfSite` (number): 参照・検索する外部サイトの数（デフォルト: `3`）。
    - `maxWord` (number): 検索結果から読み込む最大単語数（デフォルト: `1000`）。
  - **`historySettings`** (object/任意):
    - `isMixed` (boolean): `true` の場合、過去の対話で異なるAIモデルが混在していてもコンテキストとして含めます（デフォルト: `false`）。
    - `historyMessageLimit` (number): コンテキストに含める過去ログの最大メッセージ件数（デフォルト: `10`）。
  - **`withMemories`** (boolean): `true` の場合、会話間でAIの長期記憶（Memory）機能を有効化します（デフォルト: `false`）。
- **`attachments`** (object/任意):
  - `images` (stringの配列): 画像のURL、またはAsset APIから取得したアセットキー。
  - `files` (stringの配列): Asset APIから取得したファイルUUID。

### ストリーミングイベント形式 (SSE)

`?isStreaming=true` を指定した場合、レスポンスは以下の Server-Sent Events として返却されます。

| イベント名 (`event`) | データ構造 (`data`) の説明                                                  |
| :------------------- | :-------------------------------------------------------------------------- |
| `content`            | 生成中のテキストの一部。`{"content": "..."}`                                |
| `result`             | 生成完了時の全データを含む AI レコードオブジェクト。`{"aiRecord": { ... }}` |
| `done`               | ストリームの正常終了を知らせるシグナル。`{"message": "Stream completed"}`   |
| `error`              | ストリーム中に発生したエラー。`{"error": "..."}`                            |

### 会話履歴スレッドの作成

マルチターンのチャットセッションを開始する際は、まず会話コンテキストを新規に作成する必要があります。

- **エンドポイント**: `POST /api/conversations`
- **リクエストペイロード**:
  ```json
  {
    "type": "UNIFY_CHAT_WITH_AI",
    "title": "セッションのタイトル",
    "model": "gpt-4o-mini"
  }
  ```
- **レスポンス**: 生成されたオブジェクトから `uuid` を取得し、それを `promptObject.conversationId` に渡します。

---

## 4. 画像生成 ＆ 画像テキスト編集 (Image AI API)

画像の生成と編集は、汎用の AI Feature エンドポイント (`POST /api/features`) を使用します。

### A. 新規画像生成 (IMAGE_GENERATOR)

- **エンドポイント**: `POST /api/features`
- **リクエストパラメータ `type`**: `"IMAGE_GENERATOR"`

#### 1. OpenAI (gpt-image) モデル用のパラメータ

```json
{
  "type": "IMAGE_GENERATOR",
  "model": "gpt-image-2",
  "promptObject": {
    "prompt": "サイバーパンクな都市の夜景、ネオンライト",
    "size": "1024x1024",
    "n": 1,
    "quality": "medium",
    "background": "auto",
    "output_format": "png",
    "output_compression": 80
  }
}
```

#### 2. Flux / Google系モデル用のパラメータ

```json
{
  "type": "IMAGE_GENERATOR",
  "model": "flux-2-pro",
  "promptObject": {
    "prompt": "サイバーパンクな都市の夜景、ネオンライト",
    "num_outputs": 1,
    "aspect_ratio": "16:9",
    "output_format": "png"
  }
}
```

---

### B. 画像テキスト編集 (IMAGE_EDITOR)

インプット画像に対し、テキストプロンプト（指示）により一部領域の追加・変更・スタイル変換を行う機能です。

- **エンドポイント**: `POST /api/features`
- **リクエストパラメータ `type`**: `"IMAGE_EDITOR"`

#### リクエストパラメータ構造

```json
{
  "type": "IMAGE_EDITOR",
  "model": "gpt-image-2",
  "promptObject": {
    "imageUrl": "images/2024_09_30_13_38_59_100_example.png",
    "prompt": "中央の車を真っ赤なオープンカーに変更してください",
    "size": "1024x1024",
    "quality": "medium",
    "n": 1,
    "background": "auto",
    "output_format": "webp",
    "output_compression": 90
  }
}
```

#### OpenAI製モデル（gpt-image）の仕様制限（重要）

画像編集モデルに `gpt-image-` シリーズを指定する場合、`promptObject.size` パラメータには非常に厳格なルールが存在し、満たさない場合はAPI側でエラーになります。

1. **解像度のフォーマット**: `"Width x Height"` の形式（例: `"1024x1024"`, `"1280x1024"`）で指定します。
2. **16の倍数ルール**: 横幅（W）と縦幅（H）は共に **16の倍数** である必要があります。
3. **総ピクセル数**: 総ピクセル数（W × H）は **655,360 〜 8,294,400ピクセル** の間である必要があります。
4. **最長辺制限**: W, H の大きい方の長さが **3840px以下** である必要があります。
5. **アスペクト比制限**: アスペクト比（長辺 / 短辺）が **3:1以下** である必要があります。

---

## 5. コード生成 (Code Generator)

コードの自動生成、インラインチャット、オートコンプリートなど、開発者の実装支援のためのAPIです。

- **エンドポイント**: `POST /api/features`
- **リクエストパラメータ `type`**: `"CODE_GENERATOR"`

### リクエストパラメータ構造

```json
{
  "type": "CODE_GENERATOR",
  "model": "qwen3-coder-plus",
  "conversationId": "CODE_GENERATOR",
  "promptObject": {
    "prompt": "...システムコンテキストと指示テキスト...",
    "webSearch": false,
    "numOfSite": 3,
    "maxWord": 1000
  }
}
```

### Monaco Editor 実装時におけるプロンプトテンプレート構成

コードエディタ（Monaco Editor）でのインタラクションでは、説明の混入を防ぐために、以下のようにシステムコンテキストを動的に付与した `prompt` を `promptObject` に格納して送信します。

#### A. オートコンプリート (Autocomplete)

ユーザーの入力カーソル位置にシームレスに続くソースコードを数行〜最大20行程度提案させる場合。

````plaintext
あなたはAIコーディングアシスタントです。ユーザーがエディタでコードを入力中であり、カーソルの直後に続くべきコード（数行〜最大20行程度）を提案してください。
必ず提案するコード「のみ」を出力してください。説明、マークダウンのコードブロック記号(```)、解説、挨拶などは絶対に含めないでください。
また、提案コードは「カーソルより前のコード」の直後からシームレスに繋がるようにしてください。

コンテキスト:
ファイル名: [ファイル名]
言語: [言語]

カーソルより前のコード:
[カーソル前のソースコード]

カーソルより後のコード:
[カーソル後のソースコード]

提案コード:
````

#### B. インラインチャット (Inline Chat)

カーソル位置や指定した選択範囲に対し、チャットUIを介して直接コード変更を指示する場合。

````plaintext
あなたは熟練のソフトウェアエンジニアです。エディタのカーソル位置でユーザー指示を実行し、挿入または変更すべきコードを出力してください。
必ず提案するコード「のみ」を出力し、説明やマークダウンのコードブロック記号(```)は一切含めないでください。

コンテキスト:
ファイル名: [ファイル名]
言語: [言語]
ユーザー指示: [ユーザーからの編集リクエスト]

カーソルより前のコード:
[カーソル前のソースコード]

カーソルより後のコード:
[カーソル後のソースコード]

挿入/変更コード:
````

---

## 6. APIレスポンス構造（共通）

AI Feature API (`/api/features`) や Chat API の Non-Streaming 時には、以下の構造を持つ JSON レスポンスオブジェクトが返却されます。**1min.ai はバージョンによってフィールド名が変わる**ため、本アプリケーションは複数の候補パスを順番に探索します。

### 成功レスポンス (200 OK) - 現行仕様

```json
{
  "aiRecord": {
    "uuid": "120qae97-d77d-468d-9d78-2e7c0b2bbb98",
    "userId": "75cz1a57-c969-47ac-9dc5-82941cdcfe57",
    "teamId": "595w4b41-dcc7-466f-8697-d4a919810b11",
    "model": "black-forest-labs/flux-schnell",
    "type": "IMAGE_GENERATOR",
    "metadata": null,
    "rating": null,
    "feedback": null,
    "conversationId": null,
    "status": "SUCCESS",
    "createdAt": "2024-09-30T03:47:29.738Z",
    "aiRecordDetail": {
      "promptObject": {
        "prompt": "a cat",
        "num_outputs": 1,
        "aspect_ratio": "1:1",
        "output_format": "webp"
      },
      "resultObject": ["images/2024_09_30_03_47_31_072_210865.webp"]
    },
    "additionalData": null
  }
}
```

#### レスポンスフィールド詳細

- **`uuid`**: この処理リクエストに対して割り当てられたユニークなID。
- **`model`**: 処理を実際に実行したAIモデル。
- **`type`**: 実行された機能タイプ（例: `UNIFY_CHAT_WITH_AI`, `IMAGE_GENERATOR`, `IMAGE_EDITOR`, `CODE_GENERATOR`）。
- **`status`**: リクエストの処理状態。
  - Chat API: `"SUCCESS"` または `"FAILED"`。
  - AI Feature API: `"SUCCESS"`, `"COMPLETED"`, `"FAILED"` のいずれか。
- **`conversationId`**: 紐づく会話スレッドの UUID（Chat の場合のみ。作成済みの会話 `uuid` を渡すとここに戻る）。
- **`aiRecordDetail.resultObject`**: AI によって生成された出力。配列形式が基本。
  - テキスト系 (`UNIFY_CHAT_WITH_AI`, `CODE_GENERATOR`): 1要素の配列に生成テキストが入る。
  - 画像系 (`IMAGE_GENERATOR`, `IMAGE_EDITOR`): 生成画像の永続URL または asset key の配列。
- **`aiRecordDetail.errorMessage`**: `status: FAILED` のときに理由が格納される。
- **`credit`**: 本リクエストの処理によって消費されたクレジット数（API バージョンによっては未提供）。
- **`additionalData`**: 機能固有の追加データ（nullable）。

### フィールドの探索順序（実装準拠）

1min.ai は仕様変更を繰り返しているため、本アプリは下記優先順位で値を取り出します。

| 用途                | 探索パス（左から優先）                                                                                                                                              |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 生成テキスト        | `aiRecord.aiRecordDetail.resultObject` → `aiRecord.aiRecordDetail.result` → `aiRecord.output` → `aiRecord.resultObject` → `result` → `message` → `text` → `content` |
| 失敗判定の `status` | `aiRecord.status` → `status` → `aiRecordDetail.status`                                                                                                              |
| 失敗メッセージ      | `aiRecord.aiRecordDetail.errorMessage` → `aiRecord.errorMessage` → `error.message` → `error`                                                                        |
| 生成画像 URL        | `aiRecord.aiRecordDetail.resultObject` → `aiRecord.output` → `aiRecord.resultObject` → `resultObject` → `result`                                                    |
| 会話 ID             | `aiRecord.conversationId` → `aiRecord.aiRecordDetail.conversationId` → `conversationId`                                                                             |
