# 1min.ai Monaco Client

> 🌐 [日本語](README.md) | [English](README.en.md) | [中文](README.zh.md) | [한국어](README.ko.md) | [Español](README.es.md)

> [!WARNING]
> **This application is designed for local environment (localhost/127.0.0.1) personal development and single-user use only.**
> `/api/fs/*` (file system operations) and agent command execution features do not include enterprise-grade protections such as role-based access control (RBAC), detailed audit logging, or sandbox execution for multi-user scenarios. **Never deploy to public internet servers or shared development/staging environments.**
>
> **[IMPORTANT] Security Warning for AI Agent OS Command Execution**
>
> - When enabling OS command execution via the agent feature (`ENABLE_COMMAND_EXECUTION=true`), there is a risk that AI may trigger arbitrary code (e.g., installing or executing malicious packages).
> - By default, run with **`AGENT_AUTO_APPROVE=false`** and always have a human visually verify command safety before execution. If setting `AGENT_AUTO_APPROVE=true`, use in a fully isolated sandbox or Docker container environment.

A browser-based, multi-provider AI client built with Monaco Editor + Custom UI + **1min.ai API** & **1forall.ai API**.  
Uses an Express server as a BFF relay so API keys never leak to the frontend, and allows switching providers and registering/verifying API keys from either `.env` or the Settings UI.

## Features

- Multi-provider support (instant switcher for `1min.ai` / `1forall.ai` in the top bar)
- Settings UI API key management (verification + persistent server storage in `.onemin-ai/data/api_keys.json`; starts cleanly even without keys in `.env`)
- Chat (1min.ai server conversations, Web Search & hybrid OpenAI-compatible routing; 1forall.ai multi-turn history with SSE streaming)
- Categorized model picker with per-provider dynamic catalog refresh
- Image generation, image text editing & asset upload (`1min.ai` / `1forall.ai`)
- Video generation (`Text-to-Video` & `Image-to-Video` with async job polling & `<video>` playback via `Range`-capable proxy)
- Monaco Editor integration (code generation, inline autocomplete, inline chat)
- Advanced AI Coding Agent (XML tool calling, thought process display, approval flow, persistent `.onemin-ai/` sessions)
- Robust filesystem and environment security guards (`fs-guard`, `env-guard`)

## Requirements

- Node.js 18+
- 1min.ai API Key and/or 1forall.ai API Key (configured in `.env` or the in-app Settings view)
- Monaco Editor / marked / DOMPurify are automatically copied to `public/` on `npm start`, so no internet connection is required after `npm install` (except for Google Fonts loading and upstream API calls)

## Quick Start

```bash
cp .env.example .env
# Optional: set ONE_MIN_AI_API_KEY / ONE_FOR_ALL_API_KEY in .env (or configure via Settings UI)
npm install
npm start
```

Or for development with watch mode:

```bash
npm run dev
```

After starting, open:

```text
http://localhost:3000
```

## Environment Variables

| Variable                      | Required | Default               | Description                                                             |
| ----------------------------- | -------- | --------------------- | ----------------------------------------------------------------------- |
| `ONE_MIN_AI_API_KEY`                | No       | None                             | 1min.ai API key. Can also be configured via the Settings UI.                                     |
| `ONE_FOR_ALL_API_KEY`               | No       | None                             | 1forall.ai API key. Can also be configured via the Settings UI.                                  |
| `DEFAULT_PROVIDER`                  | No       | `1min`                           | Initial active provider (`1min` / `1forall`).                                                    |
| `ONE_MIN_AI_OPENAI_COMPAT`          | No       | `auto`                           | Hybrid OpenAI-compat routing mode for 1min Code/Agent (`auto` / `force` / `off`).               |
| `ONE_FOR_ALL_API_BASE_URL`          | No       | `https://api.1forall.ai`         | 1forall.ai API base URL.                                                                         |
| `ONE_FOR_ALL_S3_BUCKETS`            | No       | `voicegen-storage,tts-clariteia` | Allowed 1forall S3 buckets for `/api/assets/proxy` (comma-separated).                            |
| `ONE_FOR_ALL_UPLOAD_FIELD`          | No       | `file`                           | Override multipart file field name sent to 1forall `/v1/external/image/upload/`.                 |
| `ONE_FOR_ALL_MAX_TOKENS_AUTOCOMPLETE` | No     | `256`                            | Default `max_tokens` for 1forall autocomplete (clamped to `min_max_tokens`).                     |
| `ONE_FOR_ALL_MAX_TOKENS_INLINE`     | No       | `1024`                           | Default `max_tokens` for 1forall inline chat.                                                    |
| `ONE_FOR_ALL_MAX_TOKENS_CHAT`       | No       | `4096`                           | Default `max_tokens` for 1forall chat & coding agent.                                            |
| `PORT`                              | No       | `3000`                           | Local Express server listening port.                                                             |
| `NODE_ENV`                          | No       | `development`                    | Set to `production` to hide stack traces and enable secure cookies.                              |
| `MAX_FILE_SIZE`                     | No       | `26214400`                       | Asset upload size limit in bytes (default 25MB).                                                 |
| `MAX_JSON_BODY_SIZE`                | No       | `2mb`                            | JSON request body size limit.                                                                    |
| `DEFAULT_CHAT_MODEL`                | No       | `gpt-4o-mini`                    | Default model for 1min chat and code generation.                                                 |
| `DEFAULT_CODE_MODEL`                | No       | `qwen3-coder-plus`               | Default model for 1min code generation.                                                          |
| `DEFAULT_IMAGE_MODEL`               | No       | `gpt-image-2`                    | Default model for 1min image generation.                                                         |
| `DEFAULT_IMAGE_EDITOR_MODEL`        | No       | `gpt-image-2`                    | Default model for 1min image text editor.                                                        |
| `DEFAULT_VIDEO_MODEL`               | No       | `kling`                          | Default model for 1min video generation.                                                         |
| `DEFAULT_CHAT_MODEL_1FORALL`        | No       | `gpt-4o-mini`                    | Default model for 1forall chat.                                                                  |
| `DEFAULT_CODE_MODEL_1FORALL`        | No       | `gpt-4o`                         | Default model for 1forall code/agent.                                                            |
| `DEFAULT_IMAGE_MODEL_1FORALL`       | No       | `black-forest-labs/flux-schnell` | Default model for 1forall image generation.                                                      |
| `DEFAULT_IMAGE_EDITOR_MODEL_1FORALL` | No      | `stable-diffusion-image`         | Default model for 1forall image-to-image editing.                                                |
| `DEFAULT_VIDEO_MODEL_1FORALL`       | No       | `google-veo3`                    | Default model for 1forall video generation.                                                      |
| `ONE_MIN_AI_API_BASE_URL`     | No       | `https://api.1min.ai` | 1min.ai API base URL. For mock servers or staging.                      |
| `ASSET_PROXY_TIMEOUT_MS`      | No       | `30000`               | Asset proxy timeout in milliseconds.                                    |
| `ASSET_PROXY_MAX_SIZE`        | No       | `50mb`                | Max proxied asset response size (supports `b`/`kb`/`mb`/`gb` suffixes). |
| `API_TIMEOUT`                 | No       | `60000`               | 1min.ai API request timeout in milliseconds.                            |
| `API_RETRY_ATTEMPTS`          | No       | `3`                   | Max retry attempts on 1min.ai API errors.                               |
| `API_RETRY_DELAY`             | No       | `2000`                | Base retry delay in milliseconds.                                       |
| `RATE_LIMIT_WINDOW_MS`        | No       | `60000`               | Rate limit window in milliseconds.                                      |
| `RATE_LIMIT_MAX`              | No       | `180`                 | Max requests per window for standard endpoints.                         |
| `RATE_LIMIT_AUTOCOMPLETE_MAX` | No       | `600`                 | Max requests for autocomplete API.                                      |
| `RATE_LIMIT_CHAT_MAX`         | No       | `300`                 | Max requests for chat API.                                              |
| `SESSION_TTL_MS`              | No       | `1800000`             | Agent session TTL in milliseconds (default 30 min).                     |
| `ALLOWED_ROOTS`               | No       | Current project root  | Comma-separated list of browsable/editable root paths.                  |
| `ENABLE_COMMAND_EXECUTION`    | No       | `false`               | Enable agent command execution.                                         |
| `COMMAND_TIMEOUT_MS`          | No       | `30000`               | Command execution timeout.                                              |
| `AGENT_AUTO_APPROVE`          | No       | `false`               | Allow execution without approval. Keep false by default.                |
| `AGENT_MAX_LOOPS`             | No       | `20`                  | Max agent loop iterations (1-100).                                      |
| `AGENT_MAX_SESSIONS`          | No       | `50`                  | Max agent sessions held in memory.                                      |
| `ENABLE_DRIVES_SHELL_LOOKUP`  | No       | `true`                | Whether to use PowerShell etc. for drive listing on Windows.            |
| `LOCAL_BFF_AUTH_TOKEN`        | No       | Auto-generated        | Local BFF auth token. Auto-generated if not set.                        |
| `LOG_LEVEL`                   | No       | `info`                | Log level (`error`, `warn`, `info`, `debug`).                           |
| `LOG_TO_FILE`                 | No       | `false`               | Enable log file output.                                                 |
| `LOG_FILE`                    | No       | `logs/app.log`        | Log file path.                                                          |

## Architecture

```text
server.js                        # Express BFF / asset upload & proxy / static UI
providers/                       # Multi-provider adapters (1min.ai, 1forall.ai)
services/key-store.js            # UI + env API key persistence & resolution
routes/settings.js               # Provider status & API key management endpoints
routes/ai/                       # Multi-provider chat, code, image, video, job, model APIs
routes/agent.js                  # AI coding agent session routes
routes/agent-chat.js             # Multi-provider coding agent turn runner
routes/fs.js                     # Project file browsing / saving API
utils/api-client.js              # 1min.ai API calls and response extraction
utils/http-client.js             # Shared retry/timeout HTTP client factory
utils/sse.js                     # OpenAI & synthetic SSE normalization
utils/fs-guard.js                # File path project-limited check and protected path validation
config/models.js                 # Available models & dynamic catalog fetcher
public/index.html                # UI
public/app.js                    # Frontend logic
public/js/api.js                 # Frontend common API functions
public/js/settings.js            # Settings panel, API key manager & provider switcher
public/js/model-picker.js        # Model picker logic
public/js/image.js               # Image & video generation/editing UI + polling
docs/api-specifications.md       # 1min.ai API specifications
docs/api-specifications-1forall.md # 1forall.ai API specifications
package.json
```

See `docs/api-specifications.md` and `docs/api-specifications-1forall.md` for detailed upstream API specs and mappings.

## Local API

| Method   | Path                                 | Description                                                                   |
| -------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `GET`    | `/api/health`                        | Check server status and per-provider API key configuration.                   |
| `GET`    | `/api/settings/providers`            | Return provider statuses, masked key previews, and capabilities.              |
| `POST`   | `/api/settings/keys`                 | Verify and persist a provider API key on the server.                          |
| `DELETE` | `/api/settings/keys/:provider`       | Delete a UI-stored API key for a provider.                                    |
| `GET`    | `/api/models?provider=...`           | Return chat, code, image, and video models for the selected provider.         |
| `POST`   | `/api/models/refresh`                | Refresh upstream model catalogs for the selected or all providers.            |
| `POST`   | `/api/chat`                          | Relay chat requests (SSE / JSON) to the active provider.                      |
| `POST`   | `/api/conversations`                 | Create a conversation thread (1min.ai).                                       |
| `POST`   | `/api/images/generate`               | Relay image generation requests to the active provider.                       |
| `POST`   | `/api/images/text-editor`            | Relay image editing (`IMAGE_EDITOR` / `image-to-image`) requests.             |
| `POST`   | `/api/videos/generate`               | Start a Text-to-Video or Image-to-Video job and return its `jobId`.           |
| `GET`    | `/api/jobs/:provider/:kind/:jobId`   | Poll async generation status (`image` / `video` / `llm`) and retrieve URLs.   |
| `POST`   | `/api/assets/upload`                 | Upload local images to the active provider asset endpoint.                    |
| `POST`   | `/api/code/generate`                 | Generate/modify code for the entire selected code.                            |
| `POST`   | `/api/code/autocomplete`             | Generate inline completion candidates for Monaco Editor.                      |
| `POST`   | `/api/code/inline-chat`              | Generate inline edits at cursor position.                                     |
| `GET`  | `/api/fs/config`          | Return project root.                                     |
| `GET`  | `/api/fs/list?dir=...`    | Return file listing for specified directory.             |
| `GET`  | `/api/fs/read?path=...`   | Read specified file.                                     |
| `POST` | `/api/fs/write`           | Write to specified file.                                 |
| `POST` | `/api/fs/create`          | Create file or directory at specified path.              |
| `POST` | `/api/fs/delete`          | Delete specified file or directory.                      |
| `POST` | `/api/fs/rename`          | Move/rename specified file or directory.                 |

## Usage

### Chat

1. Open "Chat" from the left menu.
2. Select a model.
3. Enter a message and send.
4. To use conversation history, click "Create New Conversation" and enter the returned ID in `conversationId`.

### Image Generation / Editing / Video Generation

1. Open "Image Gen / Text Edit" from the left menu (switch between Image Gen, Image Edit, and Video Gen tabs).
2. For image generation, enter prompt, model, aspect ratio, and number of outputs.
3. For image editing or Image-to-Video, upload a source image and enter the returned key/URL.
4. For video generation (`Text-to-Video` / `Image-to-Video`), specify model, duration, resolution, and audio options; once async polling completes, preview the clip in the `<video>` player.

### Settings & API Keys

1. Switch between `1min.ai` and `1forall.ai` anytime using the top-bar provider selector or the Settings view.
2. Enter an API key in Settings to verify it against the provider and persist it server-side in `.onemin-ai/data/api_keys.json` (raw keys are never sent back to the browser).

### Coding Assistance

1. Open "Coding" from the left menu.
2. Open a file from the file tree.
3. Enter instructions in the AI Coding panel on the right and press "Execute".
4. Use "Apply first code block to editor" to apply results to the editor as needed.
5. `Ctrl+S` to save, `Ctrl+I` to open inline chat.

## Monaco Editor / Third-Party Library Local Copy

Monaco Editor, marked, and DOMPurify are automatically copied from `node_modules` to `public/` by `scripts/copy-monaco.js` / `scripts/copy-vendor.js` when running `npm start` (or `npm run dev`). No manual CDN setup is needed.

- `public/vs/` — Monaco Editor files (`.gitignore` tracked)
- `public/vendor/marked.min.js` — marked parser (`.gitignore` tracked)
- `public/vendor/purify.min.js` — DOMPurify sanitizer (`.gitignore` tracked)

## External Provider API Integration

### 1min.ai

- Base URL: `https://api.1min.ai`
- Authentication: `API-KEY` header for native `/api/*` endpoints; `Authorization: Bearer` for `/openai/v1/*` compatible endpoints.
- Chat with AI API: `POST /api/chat-with-ai`
- OpenAI-Compatible API: `GET /openai/v1/models`, `POST /openai/v1/chat/completions`
- AI Feature / Async Result API: `POST /api/features` (`async: true`), `GET /api/results/:resultId`
- Asset / Conversation API: `POST /api/assets`, `POST /api/conversations`

### 1forall.ai

- Base URL: `https://api.1forall.ai`
- Authentication: `Authorization: Bearer` (across OpenAI-compatible and native external routes).
- OpenAI-Compatible API: `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/images/generations`
- Native External Image / Video / LLM API: `/v1/external/image/*`, `/v1/external/video/*`, `/v1/external/llm/*`

References:

- [1min.AI API Reference](https://docs.1min.ai/docs/api/intro)
- [1min.AI OpenAI-compatible API](https://docs.1min.ai/docs/api/openai-compatible)
- [1min.AI Get Result API](https://docs.1min.ai/docs/api/get-result)
- [1forall.ai Swagger UI (OpenAPI)](https://api.1forall.ai/v1/external/swagger-ui/)
- [Specifications: docs/api-specifications.md](docs/api-specifications.md) / [docs/api-specifications-1forall.md](docs/api-specifications-1forall.md)

## Notes

- Do not commit `.env` to Git. This repository's `.gitignore` excludes `.env`, but **if you accidentally commit `.env`, always regenerate (rotate) your API key on the 1min.ai side**. Keys in Git history are dangerous even after removal with `git filter-repo`.
- `/api/fs/*` can read/write files under the project. Protected paths like `.env`, `.git`, `node_modules`, and server implementation files are guarded against deletion, overwrite, and renaming. Do not run on public servers.
- Asset upload defaults to `25MB` max (configurable via `MAX_FILE_SIZE`). The official 1min.ai Asset API documentation lists `50MB` as an example limit.
- Official documentation states rate limit defaults of `180 requests per minute`. The Asset API page also mentions `100 requests per minute` / `5 simultaneous uploads`, so check your actual plan limits with 1min.ai.
- Generated image URL display depends on 1min.ai's return format and permission settings. Even if images don't display directly, check `resultObject` and Asset info in Raw JSON.
- This is an MVP. For production use, add authentication, rate limiting, audit logging, sandbox execution, CSRF protection, etc.

## Known Improvement Candidates

- 1min.ai API response formats vary by feature and model, so the frontend extracts text and image URLs from multiple fields.
- Asset upload uses the field name `asset` per the official 1min.ai documentation.
- `/api/fs/*` is for local development. For public environments, strengthen authentication, CSRF protection, audit logging, execution sandbox, and protected path policies.
- Coding agent command execution is only enabled when `ENABLE_COMMAND_EXECUTION=true`. In production, require approval flows and log auditing.
- (Q-2) Agent file search automatically uses `ripgrep` (`rg`) if installed on the system. Falls back to `grep` / `findstr` (depending on environment) if `rg` is unavailable.
- The Apply_diff preview may not display correctly in some cases.
- Dynamic model catalog fetching supports both OpenAI-compatible and 1forall native model endpoints, falling back to `config/models.json` when unconfigured or offline.

## License

MIT License
