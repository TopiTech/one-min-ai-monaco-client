# 1forall.ai API 開発詳細仕様書 (1forall API Specifications)

このドキュメントでは、本アプリケーションのマルチプロバイダ対応において組み込まれている **1forall.ai API**（OpenAPI `https://api.1forall.ai/v1/external/swagger-ui/`）の仕様を整理します。

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

- **パラメータ**:
  - `model`: `dall-e-3`, `gpt-image-1`, または `GET /v1/models` の ID
  - `prompt`: テキストプロンプト（ネイティブ API 同様プロンプト長の上限・審査ポリシーが適用）
  - `n`: **`1`〜`4`**（本アプリは範囲外を `1..4` に丸めて送信）
  - `size`: `WxH` 形式（例: `1024x1024`, `1792x1024`, `1024x1792`）または `auto`（1min 由来の比率パラメータも自動変換）
  - `response_format`: `url` または `b64_json`
- **非対応エンドポイント**: `/v1/images/edits` および `/v1/images/variations` は未提供（HTTP `404`）。画像編集には下記ネイティブ `image-to-image` を使用します。

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
| `POST` | `/v1/external/image/text-to-image/` | `title` (<=100文字), `text` (<=5000文字), `model`, `size`, `additional_fields` (任意) | `code_ref`, `status: "pending"` |
| `POST` | `/v1/external/image/upload/` | `multipart/form-data`: `title`, `format` (`png`/`jpeg` 等・必須指定だが実際はデコード画像から自動判定), `file` (PNG / JPEG・MPO バイナリ) | `uploaded_image_url`（所有アカウント専用の S3 URL） |
| `POST` | `/v1/external/image/image-to-image/` | `title`, `text`, `model`, `file_reference`（`uploaded_image_url` を指定）, `additional_fields` (任意) | `code_ref`, `status: "pending"` |
| `GET` | `/v1/external/image/check-status/{code_ref}/` | パス `code_ref` | `status` (`pending` / `completed` / `failed`), `url_file`, `error` |

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
