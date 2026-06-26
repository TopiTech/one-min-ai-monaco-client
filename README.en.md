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

A browser-based AI client MVP built with Monaco Editor + Custom UI + 1min.ai API.
Uses an Express server as a BFF relay to avoid exposing the 1min.ai API key to the frontend.

## Features

- Chat
- Model picker with categories (Flagship, Reasoning, Fast & Light)
- Conversation creation / resumption with `conversationId`
- Chat extension via Web Search toggle
- Image generation
- Image text editor
- Image upload via Asset API
- Monaco Editor integration
- Code explanation / generation / refactoring assistance
- Inline chat with apply/discard preview
- Advanced AI Coding Agent (detailed thought process display, approval flow)
- Project file browsing and saving
- Server relay architecture that keeps API keys off the frontend
- Robust file path and security guard (`fs-guard`)

## Requirements

- Node.js 18+
- 1min.ai API Key
- Monaco Editor / marked / DOMPurify are automatically copied to `public/` on `npm start`, so no internet connection is required after `npm install` (except for Google Fonts loading)

## Quick Start

```bash
cp .env.example .env
# Edit ONE_MIN_AI_API_KEY in .env
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
| `ONE_MIN_AI_API_KEY`          | Yes      | None                  | 1min.ai API key. Store only in `.env`.                                  |
| `PORT`                        | No       | `3000`                | Local Express server listening port.                                    |
| `NODE_ENV`                    | No       | `development`         | Set to `production` to hide stack traces and enable secure cookies.     |
| `MAX_FILE_SIZE`               | No       | `26214400`            | Asset upload size limit in bytes (default 25MB).                        |
| `MAX_JSON_BODY_SIZE`          | No       | `2mb`                 | JSON request body size limit.                                           |
| `DEFAULT_CHAT_MODEL`          | No       | `gpt-4o-mini`         | Default model for chat and code generation.                             |
| `DEFAULT_CODE_MODEL`          | No       | `qwen3-coder-plus`    | Default model for code generation.                                      |
| `DEFAULT_IMAGE_MODEL`         | No       | `gpt-image-2`         | Default model for image generation.                                     |
| `DEFAULT_IMAGE_EDITOR_MODEL`  | No       | `gpt-image-2`         | Default model for image text editor.                                    |
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
server.js                  # Express BFF / 1min.ai API proxy / asset upload
routes/ai.js               # Chat / image generation / code generation API
routes/fs.js               # Project file browsing / saving API
utils/api-client.js        # 1min.ai API calls and response extraction
utils/fs-guard.js          # File path project-limited check and protected path validation
config/models.js           # Available models for UI selection
public/index.html          # UI
public/app.js              # Frontend logic
public/js/api.js           # Frontend common API functions
public/js/models.js        # Model picker logic
public/styles.css          # Styles
docs/api-specifications.md # 1min.ai API specifications
package.json
```

For development procedures and API mapping details, add to the `docs/` directory as needed.

## Local API

| Method | Path                      | Description                                              |
| ------ | ------------------------- | -------------------------------------------------------- |
| `GET`  | `/api/health`             | Check server status and API key configuration.           |
| `GET`  | `/api/models`             | Return list of chat, code, and image models.             |
| `POST` | `/api/chat`               | Relay to 1min.ai Chat with AI API.                       |
| `POST` | `/api/conversations`      | Create a conversation for chat history.                  |
| `POST` | `/api/images/generate`    | Relay to 1min.ai AI Feature API `IMAGE_GENERATOR`.       |
| `POST` | `/api/images/text-editor` | Relay to 1min.ai AI Feature API `IMAGE_EDITOR`.          |
| `POST` | `/api/assets/upload`      | Upload locally received images to 1min.ai Asset API.     |
| `POST` | `/api/code/generate`      | Generate/modify code for the entire selected code.       |
| `POST` | `/api/code/autocomplete`  | Generate inline completion candidates for Monaco Editor. |
| `POST` | `/api/code/inline-chat`   | Generate inline edits at cursor position.                |
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

### Image Generation / Text Edit

1. Open "Image Gen / Text Edit" from the left menu.
2. For image generation, enter prompt, model, aspect ratio, and number of outputs.
3. For image text editor, upload a source image and enter the returned asset key or an existing image URL.
4. Specify edit prompt, model, output size, quality, number of outputs, etc. and click "Edit Image".

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

## 1min.ai API Integration

This app uses the following 1min.ai APIs:

- Base URL: `https://api.1min.ai`
- Authentication: Uses `API-KEY` header (per official documentation). Client also sends `Authorization: Bearer` header for compatibility.
- Chat with AI API: `POST /api/chat-with-ai`
- AI Feature API: `POST /api/features`
- Asset API: `POST /api/assets`
- Conversation API: `POST /api/conversations`

References:

- [1min.AI API Reference](https://docs.1min.ai/docs/api/intro)
- [Chat with AI API](https://docs.1min.ai/docs/api/chat-with-ai-api)
- [AI Feature API](https://docs.1min.ai/docs/api/ai-feature-api)
- [CODE_GENERATOR](https://docs.1min.ai/docs/api/ai-for-code/code-generator/code-generator-tag)
- [Asset API](https://docs.1min.ai/docs/api/asset-api)
- [Image Text Editor API](https://docs.1min.ai/docs/api/ai-for-image/image-text-editor/image-text-editor-tag)
- [Rate Limits](https://docs.1min.ai/docs/api/specifications/rate-limits)
  (Note: Some official documentation has errors. The CODE_GENERATOR endpoint documentation mentions conversationID, but the actual API does not include it.)

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
- The 1min AI API does not currently support model fetching. A generic model fetching logic is already implemented for when support is added in the future.

## License

MIT License
