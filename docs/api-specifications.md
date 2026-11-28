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
## 4. 画像 AI API (Image AI API)

画像機能はすべて汎用の AI Feature エンドポイント (`POST /api/features`) に `type` を指定して呼び出します。
`promptObject` の形は**モデルごとに異なる**ため、本アプリは公式ドキュメントのパラメータ表を
転記したスキーマ (`config/image-specs/1min.json`) に従ってリクエストを組み立てます
（同期手順は 4.8 を参照）。

### 4.1 入力制限 (BFF)

BFF の画像エンドポイント (`/api/images/generate`、`/api/images/text-editor`、`/api/images/feature`) は
上流への過大なリクエストや不正な値を防ぐため、次の制限を適用します。

| 項目 | 制限 |
| :--- | :--- |
| `prompt` | 最大 50,000 文字 |
| `imageUrl` / `maskUrl` | 最大 4,096 文字 |
| `num_outputs` / `n` | 1〜10 の整数 |
| `size` | 最大 32 文字。gpt-image 系は 4.3 の解像度制約も適用 |
| モデル別パラメータ | そのモデルのドキュメントに記載されたキーのみ受理（未知キーは 400 `INVALID_IMAGE_PARAMS`） |
| 未対応モデル | 機能とモデルの組み合わせが未記載なら 400 `UNSUPPORTED_IMAGE_MODEL` |

### 4.2 新規画像生成 (IMAGE_GENERATOR / 46 モデル)

- **エンドポイント**: `POST /api/features`
- **`type`**: `"IMAGE_GENERATOR"`

系統ごとの `promptObject`（`scripts/sync-image-specs.js --report` の集計）:

| 系統 | モデル例 | 主なパラメータ |
| :--- | :--- | :--- |
| gpt-image | `gpt-image-2`, `gpt-image-2.5-flare/sunburst`, `gpt-image-1-mini` | `prompt`, `size`(必須), `quality`(必須), `n`, `background`, `style`, `output_format`, `output_compression` |
| flux-2 | `black-forest-labs/flux-2-pro/max/flex/dev/klein-*` | `prompt`, `aspect_ratio`, `output_format`, `output_quality`, `steps`, `guidance`, `safety_tolerance`, `prompt_upsampling`, `seed`, `num_inference_steps`, `megapixels`, `go_fast`, `disable_safety_checker` |
| flux-1.x | `flux-dev`, `flux-schnell`, `flux-1.1-pro(-ultra)`, `*-lora` | `prompt`, `aspect_ratio`, `image_prompt`, `image_prompt_strength`, `raw_mode`, `seed`, `prompt_strength`, `num_inference_steps`, `guidance`, `output_quality`, `megapixels`, `lora_weights`, `lora_scale`, `width`/`height` |
| ideogram | `ideogram-4`, `ideogram-3` | `prompt`, `rendering_speed`(必須), `transparent`, `resolution`, `aspect_ratio`, `output_resolution`, `num_images`, `magic_prompt`, `style_type`, `style_preset`, `style_reference_images`, `negative_prompt`, `seed` |
| leonardo | `leonardo-*`（API 上は UUID のモデルもあり） | `prompt`, `size`, `n`, `negativePrompt`, `leonardo_guidance_scale`, `leonardo_num_inference_steps`, `leonardo_seed`, `leonardo_preset_style`, `leonardo_alchemy`, `leonardo_photo_real`, `leonardo_prompt_magic`, `leonardo_tiling`, `leonardo_transparency` ほか |
| magic-art | `magic-art`, `magic-art_6_1`, `magic-art_7_0` | `prompt`, `mode`, `n`, `negativePrompt`, `isNiji6`, `maintainModeration`, `aspect_width`, `aspect_height`, `stylize`, `chaos`, `weird`, `character_reference`, `style_reference` |
| qwen-image | `qwen-image-2.1-pro/turbo`, `qwen-image-3.0(-pro)` | `prompt`, `width`, `height`, `n`, `prompt_extend`, `prompt_extend_mode`, `enable_thinking`, `seed`, `negative_prompt` |
| gemini | `gemini-2.5-flash-image`, `gemini-3-pro-image-preview`, `gemini-3.1-flash-image-preview` | `prompt`, `imageSize`, `aspectRatio`, `temperature`, `topP` |
| stable-diffusion | `stable-image`, `stable-image-ultra`, `sd3.5-*`, `stable-diffusion-xl-1024-v1-0` | `prompt`, `negativePrompt`, `aspect_ratio`, `output_format`, `seed`, `style_preset`, `cfg_scale`, `steps`, `sampler`, `samples`, `size`, `image`/`strength` |
| recraft | `recraft` | `prompt`, `task_type`, `style`, `substyle`, `size`, `n`, `negative_prompt` |
| その他 | `dzine`, `grok-2-image-1212`, `meta/muse-image` | `prompt` と `style_code`/`size`/`n` などモデル固有 |

リクエスト例:

```json
{
  "type": "IMAGE_GENERATOR",
  "model": "gpt-image-2",
  "promptObject": {
    "prompt": "サイバーパンクな都市の夜景、ネオンライト",
    "size": "1024x1024",
    "quality": "medium",
    "n": 1,
    "background": "auto",
    "output_format": "png",
    "output_compression": 80
  }
}
```

```json
{
  "type": "IMAGE_GENERATOR",
  "model": "black-forest-labs/flux-2-pro",
  "promptObject": {
    "prompt": "サイバーパンクな都市の夜景、ネオンライト",
    "aspect_ratio": "16:9",
    "output_format": "png",
    "output_quality": 80,
    "steps": 25,
    "guidance": 3,
    "prompt_upsampling": true
  }
}
```

BFF はモデルが宣言していないパラメータを送信しません。旧クライアントが常時送る
`num_outputs` / `aspect_ratio` は、そのモデルに `n`/`size` など相当するキーがあれば自動変換し、
無ければ無視します（例: gpt-image 系への `aspect_ratio` は `size` へ変換）。

### 4.3 gpt-image 系のサイズ制約（生成・編集の両方に適用）

`gpt-image-` シリーズに `size` を指定する場合、次のすべてを満たす必要があります
（BFF が送信前に検証し、違反時は 400 を返します）。

1. **形式**: `"Width x Height"`（例: `"1024x1024"`, `"1536x1024"`）。
2. **16の倍数**: 横幅・縦幅ともに 16 の倍数。
3. **総ピクセル数**: 655,360 〜 8,294,400。
4. **最長辺**: 3,840px 以下。
5. **アスペクト比**: 長辺 / 短辺 が 3:1 以下。

`output_compression` は `output_format` が `jpeg` / `webp` のときのみ送信されます。

### 4.4 画像テキスト編集 (IMAGE_EDITOR / 27 モデル)

- **`type`**: `"IMAGE_EDITOR"`
- 共通: `imageUrl`（Asset API のキーまたは絶対URL）と `prompt` が必須。

| 系統 | モデル例 | 主なパラメータ |
| :--- | :--- | :--- |
| gpt-image | `gpt-image-2`, `gpt-image-2.5-*`, `gpt-image-1-mini` | `size`, `quality`, `n`, `background`, `output_format`, `output_compression` |
| flux-2 | `flux-2-pro/max/flex/dev/klein-4b` | `aspect_ratio`（既定 `match_input_image`）, `output_format`, `output_quality`, `steps`, `guidance`, `prompt_upsampling`, `seed` |
| flux-kontext | `flux-kontext-pro/max/dev(-lora)` | `aspect_ratio`, `num_inference_steps`, `guidance`, `seed`, `output_quality`, `lora_weights`, `lora_strength`, `megapixels` |
| flux-1.x | `flux-canny-*`, `flux-depth-*` | `num_outputs`, `num_inference_steps`, `guidance`, `seed`, `format`, `megapixels` |
| qwen-image | `qwen-image-2.1-*`, `qwen-image-3.0(-pro)` | `additional_images`, `width`, `height`, `n`, `prompt_extend`, `enable_thinking`, `seed`, `negative_prompt` |
| gemini | `gemini-*` | `imageSize`, `referenceImage1`, `referenceImage2`, `temperature`, `topP` |
| stable-diffusion | `stable-diffusion-xl-1024-v1-0` | `samples`, `cfg_scale`, `steps`, `seed`, `image_strength`, `step_schedule_start/end`, `sampler`, `style_preset` |
| muse | `meta/muse-image` | `additional_images` |

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
    "output_format": "webp"
  }
}
```

### 4.5 マスク編集 (IMAGE_INPAINTER / 7 モデル)

- **`type`**: `"IMAGE_INPAINTER"`（ドキュメント上は Image Mask Editor）
- 必須: `imageUrl`, `maskUrl`（白=編集、黒=保持）, `prompt`

| 系統 | モデル | 主なパラメータ |
| :--- | :--- | :--- |
| gpt-image | `gpt-image-2`, `gpt-image-1`, `gpt-image-1-mini` | `size`, `n`, `quality`, `output_format`, `output_compression`, `background` |
| flux-fill | `flux-fill-pro`, `flux-fill-dev` | `num_inference_steps`, `guidance`, `seed`, `output_quality`, `megapixels`, `outpaint`, `prompt_upsampling`, `safety_tolerance` |
| ideogram | `ideogram-3` | `num_images`, `rendering_speed`, `magic_prompt`, `style_type`, `character_reference_images`, `seed` |
| stable-diffusion | `stable-image` | `output_format` |

### 4.6 その他の画像機能 (12 タイプ)

いずれも `POST /api/features` の `type` で指定します（BFF では `POST /api/images/feature`）。

| `type` | モデル数 | 主な `promptObject` |
| :--- | :---: | :--- |
| `IMAGE_VARIATOR` | 10 | `imageUrl`, `format`, `aspect_ratio`, `num_outputs`, `num_inference_steps`, `seed`, `output_quality`, `mode`, `isNiji6`, `maintainModeration` |
| `IMAGE_UPSCALER` | 4 | `imageUrl`, `upscale_type`(crisp/creative), `upscaling_resize`, `resemblance`, `detail` |
| `IMAGE_EXTENDER` | 3 | `imageUrl`, `left`/`right`/`up`/`down`, `resolution`, `rendering_speed` |
| `BACKGROUND_REMOVER` | 3 | `imageUrl`（+ `output_format`） |
| `BACKGROUND_REPLACER` | 6 | `imageUrl`, `prompt`, `size`, `quality`, `n`, `magic_prompt`, `style_preset` |
| `IMAGE_OBJECT_REMOVER` | 3 | `imageUrl`, `prompt`/マスク指定 |
| `TEXT_REMOVER` | 1 | `imageUrl` |
| `SEARCH_AND_REPLACE` | 1 | `imageUrl`, `search`, `replace` |
| `FACE_SWAPPER` | 2 | `swapImageUrl`, `targetImageUrl`, `n`, `output_format` |
| `SKETCH_TO_IMAGE` | 1 | `imageUrl`, `prompt`, `style_preset` |
| `IMAGE_3D_GENERATOR` | 2 | `imageUrl` |
| `IMAGE_TO_PROMPT` | 1 | `imageUrl` |
| `IMAGE_ANALYSIS` | 1 | `imageUrl`, `advancedScan`, `version` |

`TEXT_REMOVER` / `IMAGE_ANALYSIS` はドキュメントのみ存在し、現行カタログに有効モデルが無い場合があります。

### 4.7 非同期実行と結果取得

長い処理（`IMAGE_EDITOR` の `gpt-image-2` + `quality: high` など）は同期リクエストがゲートウェイの
524 に達するため、`"async": true` を付与して `uuid` を `GET /api/results/:resultId` でポーリングします
（詳細は 8 章）。BFF は `status: "PROCESSING"` の応答に `jobId` を付けて返します。

### 4.8 パラメータ・スキーマの同期と capabilities API

| 対象 | 内容 |
| :--- | :--- |
| `scripts/sync-image-specs.js` | `https://docs.1min.ai` の AI for Image 全ページから `promptObject` の表を抽出し `config/image-specs/1min.json` を再生成（`--dry-run` / `--verbose` / `--report`）。 |
| `config/image-specs/1min-overrides.json` | 列挙値・範囲・ラベルなど、ドキュメント本文の別表にある情報を人手で補完。 |
| `services/image-schema.js` | スキーマ解決・値の検証・未知キー拒否・gpt-image のサイズ検証。 |
| `GET /api/images/capabilities` | `provider` / `feature` / `model` に対し `params[]`（型・列挙・min/max・既定値）、`models[]`、`features[]` を返し、UI が入力欄を動的生成する。 |
| `POST /api/images/feature` | 4.6 の画像機能を 1 つの経路で実行（`feature` + `params`）。 |

`params[]` の `type` は `select` / `number` / `boolean` / `text` / `image` / `array` の 6 種類で、
1forall.ai の `additional_fields` も同じ形に正規化されます。

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
You are an AI coding assistant. The user is currently typing code in the editor. Suggest the code (a few lines up to approximately 20 lines) that should immediately follow the cursor position.
Output ONLY the suggested code. Do NOT include any explanations, markdown code block fences (```), commentary, or greetings under any circumstances.
Ensure the suggested code connects seamlessly directly after the code before the cursor (do not duplicate code that has already been written).

Context:
File name: [filename]
Language: [language]

Code before cursor:
[source code before cursor]

Code after cursor:
[source code after cursor]

Suggested code:
````

#### B. インラインチャット (Inline Chat)

カーソル位置や指定した選択範囲に対し、チャットUIを介して直接コード変更を指示する場合。

````plaintext
You are an expert software engineer. Execute the user instruction at the editor cursor position and output the code to be inserted or modified.
Output ONLY the proposed code. Do NOT include any explanations or markdown code block fences (```).

Context:
File name: [filename]
Language: [language]
User instruction: [user edit request]

Code before cursor:
[source code before cursor]

Code after cursor:
[source code after cursor]

Inserted/Modified code:
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
  - AI Feature API: `"PROCESSING"`（非同期実行中）、`"SUCCESS"` / `"COMPLETED"`（成功）、`"FAILED"` / `"FAILURE"`（失敗）のいずれか（`async: true` 使用時でも失敗は HTTP `200` で返却されることがあるため `status` フィールドの判定が必須）。
- **`conversationId`**: 紐づく会話スレッドの UUID（Chat の場合のみ。作成済みの会話 `uuid` を渡すとここに戻る）。
- **`aiRecordDetail.resultObject`**: AI によって生成された出力。
  - テキスト系 (`UNIFY_CHAT_WITH_AI`, `CODE_GENERATOR`): 1要素の配列に生成テキストが入る。
  - 画像・動画系 (`IMAGE_GENERATOR`, `IMAGE_EDITOR`, `TEXT_TO_VIDEO`, `IMAGE_TO_VIDEO`): 生成された永続 URL または相対ストレージキーの配列。`PROCESSING` 中は空配列 `[]`。
  - 非同期失敗 (`status: "FAILURE"`): `{ code, name, context, details, message, traceId, errorSeverity }` のエラーオブジェクトになる場合がある。
- **`temporaryUrl`**: `GET /api/results/:resultId` 等で `status: "SUCCESS"` となったアセットに付与される署名付き・期間限定の直接ダウンロード URL。
- **`aiRecordDetail.errorMessage`**: `status: FAILED` 時に理由が格納される場合がある。
- **`credit`**: 本リクエストの処理によって消費されたクレジット数（API バージョンによっては未提供）。
- **`additionalData`**: 機能固有の追加データ（nullable）。

### フィールドの探索順序（実装準拠）

1min.ai は仕様変更を繰り返しているため、本アプリは下記優先順位で値を取り出します。

| 用途 | 探索パス（左から優先） |
| :--- | :--- |
| 生成テキスト | `aiRecord.aiRecordDetail.resultObject` → `aiRecord.aiRecordDetail.result` → `aiRecord.output` → `aiRecord.resultObject` → `result` → `message` → `text` → `content` |
| 状態 / 失敗判定 `status` | `aiRecord.status` → `status` → `aiRecordDetail.status` |
| 失敗メッセージ | `aiRecord.aiRecordDetail.errorMessage` → `aiRecord.aiRecordDetail.resultObject.message` → `aiRecord.errorMessage` → `error.message` → `error` → `data.detail` |
| 生成画像 / 動画 URL | `aiRecord.temporaryUrl` → `temporaryUrl` → `aiRecord.aiRecordDetail.resultObject` → `aiRecord.output` → `aiRecord.resultObject` → `resultObject` → `result` |
| 会話 ID | `aiRecord.conversationId` → `aiRecord.aiRecordDetail.conversationId` → `conversationId` |

---

## 7. OpenAI 互換 API (OpenAI-Compatible Chat Completions)

OpenAI SDK や汎用 OpenAI クライアントと互換性のあるエンドポイント群です。本アプリでは `ONE_MIN_AI_OPENAI_COMPAT=auto`（デフォルト）時に対象モデルの Code / Agent リクエストをこの経路へハイブリッド・ルーティングします。

### エンドポイント一覧

| Method | Path | 用途 |
| :--- | :--- | :--- |
| `GET` | `/openai/v1/models` | 利用可能な互換モデル一覧の取得 |
| `GET` | `/openai/v1/models/{id}` | 指定モデルの取得（`/` を含むモデル ID は URL エンコード必須） |
| `POST` | `/openai/v1/chat/completions` | Chat Completions 生成（`stream: true` 対応、`max_completion_tokens` 推奨） |

### 認証と制約事項

- **認証ヘッダー**: OpenAI 互換エンドポイントのみ **`Authorization: Bearer <ONE_MIN_AI_API_KEY>`** を使用します（`/api/*` は従来通り `API-KEY` ヘッダー）。
- **対応モデル**: 約 58 モデルの互換カタログ（OpenAI / DeepSeek / Qwen / GLM / Mistral / OpenRouter Kimi・Muse Spark 等）。`GET /openai/v1/models` の応答がその環境における真のソースとなります。すべての互換モデルはテキスト入力専用です。
- **会話履歴とサイズ上限**: ステートレスであり、`1min` 側の会話履歴や Web Search / 思い出機能は自動挿入されません。1リクエストあたり **最大 200 messages / 合計 100,000 文字以内** に収める必要があります。
- **サンプリング制御・推論モデル**:
  - OpenAI reasoning モデル（`o3`, `o3-mini`, `gpt-5*`, `gpt-6*`）・DeepSeek・GLM では **`temperature` / `top_p` 等を送信しない** 必要があります（400 エラー回避）。
  - OpenAI `gpt-5` / `gpt-6` / `o3` 系では `reasoning_effort` を利用可能です（GLM / Mistral / DeepSeek テキストチャット等には送らない）。
- **ストリーミング (`stream: true`) 規約**:
  - `stream_options: { include_usage: true }` 指定時、末尾の usage チャンクは空 `choices: []` で返却されます。
  - 末尾の `data: [DONE]` を受信せずにストリームが閉じた場合は **不完全（失敗）として扱う** 必要があります。
- **リトライ・タイムアウト**: 上流で自動リトライは無効化されており、再送すると二重課金となるため **`POST` の自動リトライは無効（`maxRetries: 0` / `idempotent: false`）** にする必要があります。生成タイムアウト上限は 2 分、レート制限は 60 req/min（OpenAI 互換生成系共有）です。

---

## 8. 非同期実行 (`async: true`) ＆ 結果取得 API (`Get Result API`)

`IMAGE_EDITOR`（`gpt-image-2` の `high` 品質など）や動画生成のような長時間ジョブでは、同期リクエストがゲートウェイの 524 タイムアウトに達する場合があります。これを回避するため、非同期実行とポーリングを組み合わせます。

### 非同期開始 (`POST /api/features`)

リクエストボディに `"async": true` を付与します。即座に `aiRecord.status: "PROCESSING"` と `aiRecord.uuid` が返却されます（この `uuid` がそのまま `resultId` となります）。

### 結果ポーリング (`GET /api/results/:resultId`)

- **エンドポイント**: `GET https://api.1min.ai/api/results/:resultId`
- **認証ヘッダー**: `API-KEY: <YOUR_API_KEY>`
- **レスポンス例**:
  - **処理中 (200 OK)**: `aiRecord.status === "PROCESSING"`, `aiRecord.aiRecordDetail.resultObject === []`
  - **成功 (200 OK)**: `aiRecord.status === "SUCCESS"`, `aiRecordDetail.resultObject` に相対パスまたは URL、`aiRecord.temporaryUrl` にダウンロード可能な署名付き URL が含まれる
  - **失敗 (200 OK)**: `aiRecord.status === "FAILURE"`, `aiRecordDetail.resultObject` がエラー詳細オブジェクト `{ code, name, message, traceId, ... }` となる（HTTP ステータス自体は `200`）
  - **存在しない / 別チーム ID (200 OK)**: `{ "aiRecord": null }`

---

## 9. 動画生成 API (`TEXT_TO_VIDEO` / `IMAGE_TO_VIDEO`)

`POST /api/features` に `"async": true` を指定して呼び出し、`uuid` を使って `GET /api/results/:resultId` で完了までポーリングします。

### 共通構造

```json
{
  "type": "TEXT_TO_VIDEO",
  "model": "kling",
  "conversationId": "TEXT_TO_VIDEO",
  "async": true,
  "promptObject": { }
}
```

> 画像をアニメーションさせる場合（Image-to-Video）は先に `POST /api/assets` で画像をアップロードしてアセットキーを取得し、`type: "IMAGE_TO_VIDEO"` で送信します。

### モデルファミリー別 `promptObject` マッピング（本アプリ実装準拠）

| モデル系統 (`model` プレフィックス) | 主な `promptObject` フィールド | Image-to-Video 参照画像キー |
| :--- | :--- | :--- |
| `kling*` (`kling`) | `prompt`, `duration` (v3 は 3–15 秒、旧版は 5 / 10 秒), `aspect_ratio`, `version` (`1.0` / `2.0` / `3.0-omni` 等), `mode` (`std` / `pro`) または v3-omni の `resolution`, `enable_audio` (v3), `negative_prompt` | `imageUrl` (asset key) |
| `veo3*` (`veo3`, `veo3-fast`, `veo3.1`, `veo3.1-fast`) | `prompt`, `aspect_ratio`, `veo3_duration` (`"8s"`), `resolution` (`720p` / `1080p`), `generate_audio`, `negativePrompt` | `imageUrl` (asset key) |
| `sora*` (`sora-2`, `sora-2-pro`) | `prompt`, `seconds` (`4` / `8` / `12`), `size` (`1280x720`, `720x1280`, Pro の HD 時は `1792x1024` / `1024x1792`) | `reference_image_path` (asset key) |
| `wan*` (`alibaba/wan2.6-i2v-flash`) | `prompt`, `duration` (2–30 秒), `ratio`, `resolution` (`480P` / `720P` / `1080P`), `audio` | `imageUrl` (asset key) |
| その他汎用モデル | `prompt`, `duration`, `aspect_ratio`, `negative_prompt` | `imageUrl` (asset key) |
