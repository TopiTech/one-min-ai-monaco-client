# Android アプリビルドガイド (Capacitor + Node.js for Mobile Apps)

本アプリは Capacitor（WebView シェル）と ICU 有効な Node.js for Mobile Apps（v24.22.1-0 組み込みランタイム）を組み合わせ、既存の Express BFF（`server.js`）とフロントエンド UI を **Android 端末単体で完結動作** させることができます。

## アーキテクチャ概要

- **ランタイム**: 端末内バックグラウンドスレッドで `libnode.so`（Node.js v24.22.1 / ICU 78.3）を起動し、`127.0.0.1:38517` で Express BFF を待ち受けます。
- **WebView**: 起動ローダー（`mobile/loader/index.html`）から `/api/health` の応答を確認後、`http://127.0.0.1:38517/` に遷移します。
- **ネットワーク保護**: `network_security_config.xml` により平文 HTTP は `127.0.0.1` / `localhost` のみに限定され、外部通信は HTTPS のみ許可されます。
- **データ永続化**: API キーやローカル BFF セッション トークンは端末内のアプリ専用ディレクトリ（`filesDir/nodejs-project/.onemin-ai/data/`）に保存され、`android:allowBackup="false"` によりクラウド自動バックアップの対象外となります。

## 利用できる機能・制約事項

- **利用可能**: チャット（SSE ストリーミング・Web 検索・画像添付）、画像生成／編集、動画生成＆ジョブポーリング、設定画面（1min.ai / 1forall.ai API キー登録・検証）
- **非表示・無効化 (`APP_PLATFORM=android`)**:
  - Monaco Editor（`public/vs`）およびコーディング／AI Agent タブ
  - OS コマンド実行 (`ENABLE_COMMAND_EXECUTION=false`) およびコード実行 (`ENABLE_CODE_RUN=false`)
- **Node.js 24 ランタイム**:
  - 公式 `nodejs-mobile` は `--with-intl=none` でビルドされているため、Unicode プロパティエスケープ（`\p{...}`）や `Intl` が使えません。本アプリは ICU 78 を静的リンクした [fogtape/nodejs-mobile v24.22.1-0](https://github.com/fogtape/nodejs-mobile/releases/tag/v24.22.1-0) を使用しています。
  - Node 24 では `fs.openAsBlob` が利用できるため、大容量アセットもストリーミングでアップロードされます（古いランタイム向けの 8MB メモリフォールバックは残しています）。
  - 個人利用向けにローカル loopback での単体利用を想定しています。公開サーバー用途には使用しないでください。

## 必要なビルド環境

PC 側で以下をインストールしてください。

1. **Android Studio**（同梱の **JDK 21** を `JAVA_HOME` に設定推奨。AGP 8.x / Capacitor 8.x では JDK 21 が必要です）
2. **Android SDK**（Android Studio の SDK Manager からインストール）
   - Android SDK Platform 36（または `android/variables.gradle` の `compileSdkVersion` 相当）
   - Android SDK Build-Tools
   - **NDK (Side by side)** r27 系（r24 以上）
   - **CMake** 3.22.1 以上
3. **環境変数**:
   - `ANDROID_HOME`（例: `C:\Users\<user>\AppData\Local\Android\Sdk`）
   - `JAVA_HOME`（Android Studio 同梱 JDK 21 のパス）

## ビルド・インストール手順

### 1. Node プロジェクトとネイティブバイナリの準備

```bash
npm install
npm run android:sync
```

`android:prepare`（`android:sync` 内で実行）は以下を自動実行します。

1. `public/vendor/` への DOMPurify / marked コピー
2. ICU 有効な Node.js for Mobile Apps v24.22.1-0 Android バイナリ（`arm64-v8a` / `x86_64`）のダウンロード、SHA-256 検証、ICU シンボル確認、展開（`android/app/libnode/`）
3. `android/app/src/main/assets/nodejs-project/` への最小ファイル群コピー（`public/vs`、`.env`、`.onemin-ai`、`logs`、`tests` は除外）
4. 本番依存パッケージのインストール（`monaco-editor` は容量削減のため削除）と秘密情報非混入チェック

### 2. Debug APK のビルド

```bash
npm run android:build
```

または Android Studio で開いてビルドする場合:

```bash
npm run android:open
```

生成先: `android/app/build/outputs/apk/debug/app-debug.apk`

> **容量について**: Node.js 24 + ICU を 2 ABI 分同梱するため、debug APK は約 300MB になります。配布時は ABI 分割（`arm64-v8a` / `x86_64`）を推奨します。

### 3. 実機・エミュレータへのインストールとログ確認

USB デバッグを有効にした実機またはエミュレータを接続し、以下を実行します。

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Node.js BFF やネイティブ側のログは `adb logcat` で確認できます（API キーはマスクされます）。

```bash
adb logcat -s OneMinAiMainActivity NODEJS-MOBILE
```
