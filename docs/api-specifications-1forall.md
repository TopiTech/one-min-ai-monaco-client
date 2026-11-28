# 1forall.ai API 開発詳細仕様書 (1forall API Specifications)

このドキュメントでは、本アプリケーションのマルチプロバイダ対応において組み込まれている **1forall.ai API**（OpenAPI `https://api.1forall.ai/v1/external/swagger-ui/`）の仕様を整理します。

> [!TIP]
> 一次情報は OpenAPI 3.0.3 スキーマです。`curl -H "Accept: application/vnd.oai.openapi+json" https://api.1forall.ai/v1/external/`
> で取得でき（`/v1/external/redoc/` の `spec-url` と同一）、本ドキュメントのパラメータ名はこれに準拠しています。

---

## 1. 共通仕様 ＆ 認証 (Common & Authentication)

- **Base URL**: `https://api.1forall.ai`
  - OpenAI 互換 API: `https://api.1forall.ai/v1`（`/v1/external/openai` と同一機能）
  - ネイティブ External API: `https://api.1forall.ai/v1/external`
- **認証ヘッダー**:
  - `Authorization: Bearer <ONE_FOR_ALL_API_KEY>`（本アプリで標準使用）
  - または `Authorization: Api-Key <ONE_FOR_ALL_API_KEY>`
- **注意**: 1min.ai の `API-KEY` ヘッダーとは異なるため、送信ヘッダーはプロバイダ単位で完全に分離しています。

### クレジット課金モデル

- **テキスト (OpenAI 互換チャット)**: `credits_per_output_token × max_tokens`（整数へ丸め）で課金されます。
  - リクエストで `max_tokens` を省略すると上流では **1,500** として計算され、モデルの `min_max_tokens` を下回りません。
  - 実際の出力長ではなく指定した `max_tokens` 上限に基づく価格が適用されるため、本アプリでは用途別の環境変数（`ONE_FOR_ALL_MAX_TOKENS_AUTOCOMPLETE=256`, `ONE_FOR_ALL_MAX_TOKENS_INLINE=1024`, `ONE_FOR_ALL_MAX_TOKENS_CHAT=4096`）で制御しつつ、`min_max_tokens` 未満にならないようクランプしています。
- **画像**: モデルカタログの `credits_at_defaults` / 枚。開始時に引き落とされ、生成が `failed` の場合は自動返金されます。

---

## 2. OpenAI 互換 API Surface

| Method | Path | エイリアス | 用途 |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/models` | `/v1/external/openai/models` | モデル一覧取得（無料、認証必須） |
| `POST` | `/v1/chat/completions` | `/v1/external/openai/chat/completions` | 同期・SSE ストリーミングチャット補完 |
| `POST` | `/v1/images/generations` | `/v1/external/openai/images/generations` | 同期画像生成 (`n` = 1..4) |
| `POST` | `/v1/audio/speech` | `/v1/external/openai/audio/speech` | 音声合成 |

### Chat Completions (`POST /v1/chat/completions`)

- リクエスト形式は標準 OpenAI Chat Completions 準拠（`model`, `messages`, `max_tokens`, `stream`, `stream_options: { include_usage: true }`）。
- 1forall 固有モデル名に加え、`gpt-4o-mini` / `gpt-4o` 等 OpenAI 名も同等モデルへ自動マッピングされます。サーバー側にスレッド状態は持たないため、マルチターン会話ではフロントエンド側で保持している `messages` 履歴を毎回送信します。
- **非ストリーミングモデルへのフォールバック**: 一部モデルは SSE ストリーミングに非対応であり、`stream: true` でリクエストすると HTTP `400`（`error.param === "model"` 等）を返します。本アプリ（`providers/one-for-all/index.js`）はこれを検知すると自動で `stream: false` で再試行し、クライアント向けの SSE 形式で返却します。

### Images Generations (`POST /v1/images/generations`)

同期エンドポイントで、レスポンスにそのまま画像 URL（または base64）が入ります。ポーリングは不要です。

- **パラメータ**:
  - `model`: `dall-e-3`, `gpt-image-1`, または `GET /v1/models` の ID
  - `prompt`: テキストプロンプト（ネイティブ API 同様プロンプト長の上限・審査ポリシーが適用）
  - `n`: **`1`〜`4`**（本アプリは `1..4` に丸めて送信）
  - `size`: `WxH`（例: `1024x1024`, `1792x1024`）または `auto`（カタログの比率コードは本アプリがピクセルへ変換）
  - `response_format`: `url`（既定）または `b64_json`
  - `quality` / `style` / `user` は受け付けられますが**無視**されます
- **エラー**: コンテンツフィルタ拒否は HTTP `400` + `code: content_policy_violation`（課金なし）
- **非対応エンドポイント**: `/v1/images/edits` および `/v1/images/variations` は未提供（HTTP `404`）。画像編集にはネイティブ `image-to-image` を使用します。

> [!NOTE]
> 本アプリの `POST /api/images/generate` は `async: false`（既定）でこの同期経路を使い、
> `async: true` でネイティブ `text-to-image` + `check-status` 経路に切り替えます。

### 画像モデルカタログ (`GET /v1/external/image/models/`)

API キー無しで取得でき、**モデルごとに受け付けるパラメータがすべて記載**されています（149 モデル / 2026 年時点）。

```json
{
  "code": "black-forest-labs/flux-2-pro",
  "name": "flux-2-pro",
  "mode": "TEXT_TO_IMAGE",
  "credits_at_defaults": 15,
  "recommended": true,
  "sizes": [{ "code": "1:1", "ratio": "1:1", "default": true, "enabled": true }],
  "additional_fields": [
    {
      "code": "steps",
      "type": "SLIDER",
      "min": "15.00",
      "max": "50.00",
      "step": "1.00",
      "default_value": "25",
      "required": false,
      "enabled": true
    }
  ]
}
```

| フィールド | 意味 |
| :--- | :--- |
| `mode` | `TEXT_TO_IMAGE` / `IMAGE_TO_IMAGE`。`IMAGE_TO_IMAGE` のみ `image-to-image` に使用可能 |
| `sizes[]` | `size` に指定できるコード（比率コードのほか `match_input_image` やピクセル値の場合もある）。`default: true` が既定値 |
| `additional_fields[].type` | `SELECT` / `SLIDER` / `INTEGER` / `NUMBER` / `BOOLEAN` / `TEXT` / `IMAGE` / `ARRAY` |
| `additional_fields[].options` | `SELECT` の列挙値（カンマ区切り） |
| `min` / `max` / `step` | 数値系の範囲（文字列で返る点に注意） |
| `required` | 必須の場合 `true` |

頻出する `additional_fields`（モデル数）: `output_format`(73), `image`(52), `output_quality`(33),
`disable_safety_checker`(30), `safety_tolerance`(26), `size`/`resolution`(21), `negative_prompt`(21),
`guidance`(18), `width`/`height`(14), `lora_weights`(14), `mask`(12), `num_outputs`(12), `megapixels`(12),
`prompt_upsampling`(10), `seed`。

本アプリはこのカタログを `config/models.js` で正規化して保持し、
`GET /api/images/capabilities?provider=1forall&model=...` で UI に同じ形（`params[]` / `sizes[]`）で返します。

---

## 3. ネイティブ External API (`/v1/external/*`)

非同期ジョブ方式を採用しており、リクエスト時に即座に **`code_ref`** と `status: "pending"` が返却されます。完了までは対応する `check-status/{code_ref}/` をポーリングし、`status === "completed"` になった際に返る `url_file`（期間限定の署名付きダウンロード URL）から結果を取得します。

### モデルカタログエンドポイント

| Method | Path | 認証 | 主なメタ情報 |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/external/llm/models/` | **必須** (401 on invalid/missing) | `code`, `name`, `credits_per_output_token`, `min_max_tokens`, `default_max_tokens` |
| `GET` | `/v1/external/image/models/` | 任意（キー無し可） | `code`, `name`, `mode` (`TEXT_TO_IMAGE` / `IMAGE_TO_IMAGE`), `sizes`, `credits_at_defaults` |
| `GET` | `/v1/external/video/models/` | 任意（キー無し可） | `code`, `name`, `mode` (`TEXT_TO_VIDEO` / `IMAGE_TO_VIDEO` / `ADD_AUDIO_TO_VIDEO` / `LIP_SYNC`), `ratios` |

### 画像 API（非同期・画像編集・アップロード）

| Method | Path | 主な必須・重要パラメータ | レスポンス概要 |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/external/image/text-to-image/` | `title` (<=100文字), `model`, `size`（カタログコード・**必須**）, `text` (<=5000文字), `speed` (既定 `1`), `additional_fields` (任意) | `code_ref`, `status: "pending"` |
| `POST` | `/v1/external/image/upload/` | `multipart/form-data`: `title`, `format` (`png`/`jpeg` 等・必須指定だが実際はデコード画像から自動判定), `file` (PNG / JPEG・MPO バイナリ) | `uploaded_image_url`（所有アカウント専用の S3 URL） |
| `POST` | `/v1/external/image/image-to-image/` | `title`, `model`, `file_reference`（`uploaded_image_url` を指定・**必須**）, `text` (<=5000文字), `speed`, `additional_fields` (任意) | `code_ref`, `status: "pending"` |
| `GET` | `/v1/external/image/check-status/{code_ref}/` | パス `code_ref` | `status` (`pending` / `completed` / `failed`), `url_file`, `urls`, `error` |
| `GET` | `/v1/external/image/conversions/{id}/` | パス `id`（数値） | 変換オブジェクト全体（`url_file`, `urls`, `child_conversions[]`） |

#### アップロード → 編集の流れ（本アプリの実装）

`file_reference` は「アカウント所有の URL」しか受け付けません。そのため BFF の
`POST /api/images/text-editor`（`provider: "1forall"`）は次の順序で処理します。

1. `imageUrl` が既に 1forall 所有（`voicegen-storage` / `tts-clariteia` / API ホスト）なら**そのまま** `file_reference` に使用。
2. それ以外（1min の asset キー、`/api/assets/proxy?key=...`、`data:` URI など）は
   SSRF 許可リスト（`services/asset-proxy.js` の `isTrustedAssetUrl`）を通過する場合のみダウンロードし、
   `/v1/external/image/upload/` へアップロードして `uploaded_image_url` を取得。
3. 得られた URL を `file_reference` として `image-to-image` を送信。

許可リスト外のホストは `400 INVALID_IMAGE_URL`、20MB 超は `413 IMAGE_TOO_LARGE` で拒否します。

#### 複数出力の扱い

`check-status` の完了応答は `url_file`（代表 URL）に加えて `urls`（文字列または JSON 配列）と
`child_conversions[]` を持つ場合があります。BFF はこれらを重複排除して 1 本の
`urls[]` にまとめ、`aiRecord.aiRecordDetail.resultObject` にも同じ配列を返します。

#### `additional_fields` の組み立て

BFF の `POST /api/images/generate`（`provider: "1forall"`）は、正規化したリクエスト
（`quality` / `negative_prompt` / `seed` / `steps` / `guidance` / `output_format` / `num_outputs`
＋ `params` の任意キー）を、カタログが宣言した `additional_fields` にのみマッピングします。
宣言に無いキーは `400 INVALID_IMAGE_PARAMS`（`supported` に許容キー一覧）を返します。
`size` はカタログの `sizes[]` から選択し（明示値 → アスペクト比 → 既定値の順）、
同期経路ではピクセル値へ変換されます。

### 動画 API（Text-to-Video / Image-to-Video）

| Method | Path | 主なパラメータ | レスポンス概要 |
| :--- | :--- | :--- | :--- |
| `POST` | `/v1/external/video/convert-to-video/` | `title` (必須, <=100文字), `model` (必須), `text` (<=5000文字), `ratio`, `source_image_path` (Image-to-Video 用 URL), `source_video_path` (Audio追加等用 URL), `speed` (double, default `1`), `additional_fields` (任意: `negative_prompt` 等) | `code_ref`, `status: "pending"` |
| `GET` | `/v1/external/video/check-status/{code_ref}/` | パス `code_ref` | `status` (`pending` / `completed` / `failed`), `url_file`, `error` |

### ネイティブ LLM API（参考）

本アプリではチャット・コードに同期 / SSE が使える `/v1/chat/completions` を使用していますが、ジョブポーリング用として `/api/jobs/1forall/llm/:jobId` は以下のチェックステータスエンドポイントにも接続可能です。

- `POST /v1/external/llm/send-request/` (`title`, `system_prompt`, `message`, `model`, `max_tokens`) -> `code_ref`
- `GET /v1/external/llm/check-status/{code_ref}/` -> `status`, `response`, `error`

---

## 4. 出力アセットの保存先とプロキシ制約

1forall が返すアップロード画像 URL や生成完了後の `url_file` は主に以下の AWS S3 バケット上でホストされます。

- `https://voicegen-storage.s3.amazonaws.com/...`
- `https://tts-clariteia.s3.eu-west-1.amazonaws.com/...`

本アプリでは SSRF 対策の許可リスト（`services/asset-proxy.js`）に `ONE_FOR_ALL_S3_BUCKETS`（デフォルト: `voicegen-storage,tts-clariteia`）および `ONE_FOR_ALL_API_BASE_URL` のホストを組み込んでおり、`<img src="/api/assets/proxy?url=...">` や `<video src="/api/assets/proxy?url=...">`（`Range` ヘッダー対応）経由で安全にローカル配信されます。

---

## 5. エラーレスポンス形式

### OpenAI 互換エンドポイント系

```json
{
  "error": {
    "message": "string",
    "type": "authentication_error | invalid_request_error | ...",
    "param": "model | null",
    "code": "insufficient_quota | content_policy_violation | unsupported_parameter | ..."
  }
}
```

### ネイティブ `/v1/external/*` 系

| HTTP Status | 典型メッセージ・意味 | 対処 |
| :--- | :--- | :--- |
| `401` | キー未指定、形式不正、無効または失効済み (`detail` / `error.message`) | Settings UI または `.env` で有効なキーを設定 |
| `403` | Generate 権限がない API キー | 1forall 管理画面で Generate 権限付きキーを発行 |
| `400` | 必須フィールド欠落、非対応モデル/サイズ、`Not enough credits on the wallet.` | パラメータ・モデルカタログ・クレジット残高を確認 |
| `404` | `Conversion process does not exist`（`code_ref` 不正・他アカウント）、または未実装の OpenAI 画像編集系 | `code_ref` と対象エンドポイントを確認 |
| `429` | レートリミット超過 / クレジット不足 (`insufficient_quota`) | 間隔を空けて再試行またはクレジットチャージ |
