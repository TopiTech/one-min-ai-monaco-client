# Architecture

## Overview

```text
┌──────────────────────────────────────────────────────────┐
│                     Browser (User)                       │
│  ┌─────────────┐ ┌──────────┐ ┌───────────┐ ┌─────────┐  │
│  │ Monaco      │ │ Chat UI  │ │ Image /   │ │ Settings│  │
│  │ Editor      │ │          │ │ Video UI  │ │ UI      │  │
│  └──────┬──────┘ └────┬─────┘ └─────┬─────┘ └────┬────┘  │
│         └─────────────┴─────────────┴────────────┘       │
│                             │                            │
│              fetch() /api/* │ (same-origin)              │
└─────────────────────────────┼────────────────────────────┘
                              │
┌─────────────────────────────▼────────────────────────────┐
│                 Express BFF (server.js)                  │
│                                                          │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌────────────┐  │
│  │ /api/ai  │ │/api/agent│ │/api/      │ │ /api/fs    │  │
│  │ (chat/   │ │          │ │ settings  │ │ (fs-guard) │  │
│  │ img/vid) │ │          │ │           │ │            │  │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └─────┬──────┘  │
│       │            │             │             │         │
│  ┌────▼────────────▼─────────────▼─────────────▼──────┐  │
│  │                 Security Layer                     │  │
│  │  localBffAuth · CORS (localhost) · CSP/Helmet      │  │
│  │  env-guard · sanitize · Range asset-proxy          │  │
│  └─────────────────────────┬──────────────────────────┘  │
│                            │                             │
│  ┌─────────────────────────▼──────────────────────────┐  │
│  │  providers/index.js (Registry & Capabilities)      │  │
│  │  services/key-store.js (.onemin-ai/data/api_keys)   │  │
│  │  utils/http-client.js · utils/sse.js               │  │
│  └───────────┬──────────────────────────┬─────────────┘  │
└──────────────┼──────────────────────────┼────────────────┘
               │                          │
   API-KEY / Bearer            Authorization: Bearer
               │                          │
┌──────────────▼───────────┐ ┌────────────▼───────────────┐
│ 1min.ai API              │ │ 1forall.ai API             │
│ - /api/chat-with-ai      │ │ - /v1/chat/completions     │
│ - /api/features          │ │ - /v1/images/generations   │
│ - /api/results/:uuid     │ │ - /v1/external/image/*     │
│ - /openai/v1/* (compat)  │ │ - /v1/external/video/*     │
│ - /api/assets            │ │ - /v1/external/llm/*       │
└──────────────────────────┘ └────────────────────────────┘
```

## Directory Layout

```text
├── server.js                  # Express BFF entry point & asset upload/proxy
├── config/
│   ├── models.json            # Fallback model definitions (1min & 1forall)
│   ├── models.js              # Provider-scoped model catalog & refresh
│   └── server.js              # Server & multi-provider configuration (env vars)
├── providers/
│   ├── index.js               # Provider registry, resolution & capability guards
│   ├── one-min/
│   │   ├── index.js           # 1min.ai provider (Chat/Feature/Result/Asset)
│   │   ├── openai-compat.js   # Hybrid OpenAI-compat routing & model constraints
│   │   └── video.js           # TEXT_TO_VIDEO / IMAGE_TO_VIDEO promptObject builder
│   └── one-for-all/
│       ├── client.js          # 1forall Bearer-only HTTP client
│       └── index.js           # 1forall provider (OpenAI-compat + native external)
├── routes/
│   ├── ai/
│   │   ├── index.js           # AI router mount point
│   │   ├── chat.js            # Provider-aware SSE / sync chat
│   │   ├── code.js            # Generate, autocomplete & inline chat
│   │   ├── conversations.js   # 1min conversation management
│   │   ├── images.js          # Image generate & text-editor (1min & 1forall)
│   │   ├── videos.js          # Video generate (TEXT_TO_VIDEO / IMAGE_TO_VIDEO)
│   │   ├── jobs.js            # Async job status polling (/api/jobs/:provider/:kind/:jobId)
│   │   ├── models.js          # Model list (?provider=) & manual refresh
│   │   └── utils.js           # Shared prompt/SSE utilities
│   ├── agent.js               # AI coding agent session management
│   ├── agent-chat.js          # Multi-provider agent turn execution (XML tools)
│   ├── settings.js            # UI API key & provider status/verify API
│   └── fs.js                  # File read/write/delete APIs
├── services/
│   ├── asset-proxy.js         # SSRF-safe asset/video Range proxy (1min + 1forall S3)
│   ├── code-analyzer.js       # Code context extraction
│   ├── command-runner.js      # Safe command execution for agent
│   ├── key-store.js           # Persistent UI API key store & secret resolution
│   └── tmp-cleanup.js         # Uploaded temporary file cleanup
├── utils/
│   ├── api-client.js          # 1min.ai legacy & shared response extractors
│   ├── env-guard.js           # Process env sanitization & secret scrubbing
│   ├── fs-guard.js            # File path security guard
│   ├── http-client.js         # Shared retry/timeout HTTP client factory
│   ├── logger.js              # Structured logging (secret redaction)
│   ├── mime-guard.js          # MIME type signature validation
│   ├── sanitize.js            # Secret scrubbing for API-KEY / Bearer / Api-Key
│   └── sse.js                 # OpenAI SSE parser & synthetic SSE wrapper
├── public/
│   ├── index.html             # Single-page app shell (provider bar, chat, image/video, coding, settings)
│   ├── styles.css             # Global styles
│   ├── app.js                 # Main frontend logic (ES module)
│   ├── i18n/                  # Japanese & English translations (ja.json, en.json)
│   └── js/
│       ├── api.js             # Frontend API helpers & active provider header/injection
│       ├── chat.js            # Chat UI, SSE streaming & client history for stateless providers
│       ├── image.js           # Image & Video generation UI + job polling
│       ├── editor.js          # Monaco Editor integration
│       ├── inline-chat.js     # Inline chat widget
│       ├── editor-tabs.js     # Editor tab management
│       ├── agent-core.js      # Coding agent UI & provider capabilities
│       ├── model-picker.js    # Provider-aware model picker
│       ├── settings.js        # Settings panel, active provider & API key management
│       └── ...
├── tests/                     # Jest unit & integration test suites
└── docs/
    ├── api-specifications.md           # 1min.ai API specifications (incl. OpenAI-compat & Video)
    ├── api-specifications-1forall.md   # 1forall.ai API specifications
    └── screenshots/                    # Screenshots for README
```

## Code Comment Prefixes

The codebase uses structured comment prefixes to track change types in commit history:

| Prefix | Meaning                         | Example                                                  |
| ------ | ------------------------------- | -------------------------------------------------------- |
| `B-`   | Blocker / critical security fix | `// B-3: Replace brittle prefix list with glob patterns` |
| `S-`   | Security improvement            | `// S-1: Switched to diskStorage to avoid OOM`           |
| `M-`   | Medium priority fix             | `// M-5: Handle output_compression NaN`                  |
| `L-`   | Low priority / cosmetic         | `// L-3: Cap meta serialization at 8KB`                  |
| `D-`   | Defense in depth                | `// D-1: Sanitize log metadata`                          |
| `E-`   | Enhancement / new feature       | `// E-1: Startup cleanup for orphaned files`             |
| `Q-`   | Quality / code cleanup          | `// Q-9: Register asset route before express.json()`     |
| `SEC-` | Security-specific new fix       | `// SEC-NEW: When sec-fetch-site is missing`             |
| `A-`   | Architecture / refactoring      | `// A-1: Stream file using openAsBlob`                   |
| `F-`   | Fix / bug fix                   | `// F-6: Suppress auto-scroll on history review`         |

## Key Design Decisions

### 1. BFF (Backend-for-Frontend) Pattern & Multi-Provider Abstraction

The Express server acts as a BFF, storing provider API keys in `.env` and/or `.onemin-ai/data/api_keys.json` (`0o600`, resolved in `services/key-store.js` with UI override priority). The browser never reads raw API keys back after submission (`GET /api/settings/providers` returns only masked previews). Incoming requests select a provider (`1min` or `1forall`) routed through `providers/index.js`, enforcing per-provider capabilities (`PROVIDER_CAPABILITIES`) and isolating authentication headers (`API-KEY` vs `Authorization: Bearer`).

### 2. Security-First Architecture

- **localBffAuth**: Cookie + header double-submit pattern for CSRF protection
- **fs-guard & env-guard**: Path traversal protection, protected `.onemin-ai/` store, and child-process environment scrubbing of active provider secrets
- **asset-proxy**: SSRF host allowlist (`storage.1min.ai`, `voicegen-storage.s3.amazonaws.com`, `tts-clariteia.s3.eu-west-1.amazonaws.com`) with HTTP `Range` passthrough for `<video>` streaming
- **CSP**: Strict policy with per-request nonces
- **CORS & Host validation**: Localhost-only access and DNS rebinding protection

### 3. Hybrid Routing, Streaming & Async Jobs

- **1min.ai Hybrid Code/Agent (`providers/one-min/openai-compat.js`)**: In `ONE_MIN_AI_OPENAI_COMPAT=auto`, text-only compatible models route via `/openai/v1/chat/completions` (omitting `temperature`/`top_p` on reasoning/DeepSeek/GLM models and checking `[DONE]`), automatically falling back to `/api/features?isStreaming=true` (`CODE_GENERATOR`) when unsupported or when web search / size caps trigger.
- **1forall.ai SSE & Token Cost Control (`providers/one-for-all/index.js`)**: Streams `/v1/chat/completions`, automatically retries non-streaming when HTTP 400 indicates a non-streamable model, and bounds `max_tokens` per task (`autocomplete`/`inline`/`chat`) while honoring `min_max_tokens`.
- **Async Jobs**: Long-running image edits and Text-to-Video / Image-to-Video calls start async tasks (`async: true` on 1min, native endpoints on 1forall) polled via `/api/jobs/:provider/:kind/:jobId`.

### 4. Agent System

The AI coding agent maintains server-side sessions with XML tool calling (`<call_tool>`, `<finish>`), context trimming/persistence, command execution with approval flow, pending command TTL (5 min), and SEARCH/REPLACE diff application across both providers.

### 5. Rate Limiting

All API endpoints are rate-limited with per-endpoint ceilings (default 180 req/min global, 300 chat, 600 autocomplete) to protect upstream provider quotas.

## Data Flow

### Chat & Code

```text
User Input → chat.js / editor.js → api("/api/chat" or "/api/code/*") → routes/ai/*.js → providers/index.js → 1min.ai OR 1forall.ai
                                                                                                                  │
User ← SSE / JSON ← routes/ai/*.js ← providers/*.js (OpenAI SSE / 1min SSE normalization) ←──────────────────────┘
```

### Video & Async Image Jobs

```text
UI (image.js) → POST /api/videos/generate (or /api/images/text-editor) → jobId (uuid / code_ref)
UI ← GET /api/jobs/:provider/:kind/:jobId polling ← 1min (/api/results/:uuid) OR 1forall (check-status)
```

### Image Parameters (model-specific)

Image payloads differ per model, so both providers are described by one normalized shape
(`services/image-schema.js`):

```text
config/image-specs/1min.json (docs transcription, regenerated by scripts/sync-image-specs.js)
config/image-specs/1min-overrides.json (enums/ranges/labels)     ─┐
1forall catalog: GET /v1/external/image/models/ (sizes,          ─┼→ services/image-schema.js
  additional_fields)                                               │        │
                                                                   │        ├→ GET /api/images/capabilities → UI renders inputs
routes/ai/images.js → providers/one-min/images.js | providers/one-for-all/images.js → promptObject / additional_fields
```

Unknown parameters are rejected with `400 INVALID_IMAGE_PARAMS` (the response lists what the
model declares), and `POST /api/images/feature` covers the 1min.ai features that are not
plain generation (`IMAGE_VARIATOR`, `IMAGE_UPSCALER`, `IMAGE_INPAINTER`, ...).

### File Operations

```text
Editor Tab → app.js → api("/api/fs/*") → server.js → fs.js → fs-guard.js (validation)
                                                                      │
Editor Tab ← app.js ← server.js ← fs.js ←─────────────────────────────┘
```

### Agent Session

```text
Agent UI → agent-core.js → api("/api/agent/*") → agent-chat.js → providers/index.js → 1min / 1forall
                                                                                            │
Agent UI ← streaming XML progress ← agent-chat.js ←─────────────────────────────────────────┘
```
