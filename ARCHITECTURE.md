# Architecture

## Overview

```text
┌──────────────────────────────────────────────────────┐
│                    Browser (User)                     │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Monaco       │  │ Chat UI      │  │ Image Gen   │ │
│  │ Editor       │  │              │  │ UI          │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
│         └─────────────────┼──────────────────┘        │
│                          │                           │
│              fetch() /api/*  (same-origin)            │
└──────────────────────────┬────────────────────────────┘
                           │
┌──────────────────────────▼────────────────────────────┐
│               Express BFF (server.js)                  │
│                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐│
│  │ /api/chat │  │ /api/code│  │ /api/fs  │  │/api/   ││
│  │          │  │          │  │  *.rw    │  │agent/  ││
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘│
│       │             │             │              │     │
│  ┌────▼─────────────▼─────────────▼──────────────▼──┐ │
│  │           Security Layer                          │ │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │ │
│  │  │localBff  │ │CORS (only│ │ CSP / Helmet      │ │ │
│  │  │Auth      │ │localhost)│ │                    │ │ │
│  │  └──────────┘ └──────────┘ └───────────────────┘ │ │
│  └────────────────────┬──────────────────────────────┘ │
│                       │                                │
│  ┌────────────────────▼──────────────────────────────┐ │
│  │  utils/api-client.js  (1min.ai API proxy)         │ │
│  │  utils/fs-guard.js    (path restriction)          │ │
│  │  utils/logger.js      (logging)                   │ │
│  │  config/server.js     (config)                     │ │
│  └────────────────────┬──────────────────────────────┘ │
└───────────────────────┼────────────────────────────────┘
                        │
           HTTPS (API-KEY header)
                        │
┌───────────────────────▼────────────────────────────────┐
│              1min.ai API (api.1min.ai)                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Chat w/  │ │ AI       │ │ Asset    │ │ Conver-  │ │
│  │ AI       │ │ Feature  │ │ API      │ │ sations  │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ │
└────────────────────────────────────────────────────────┘
```

## Directory Layout

```
├── server.js              # Express BFF entry point
├── config/
│   ├── models.js          # Model definitions (chat/code/image)
│   └── server.js          # Server configuration (env vars)
├── routes/
│   ├── ai.js              # Chat, code, image generation APIs
│   ├── agent.js           # AI coding agent session management
│   └── fs.js              # File read/write/delete APIs
├── utils/
│   ├── api-client.js      # 1min.ai API client with retry
│   ├── fs-guard.js        # File path security guard
│   ├── logger.js          # Structured logging
│   └── mime-guard.js      # MIME type signature validation
├── services/
│   └── command-runner.js  # Safe command execution for agent
├── public/
│   ├── index.html         # Single-page app shell
│   ├── styles.css         # Global styles
│   ├── app.js             # Main frontend logic (ES module)
│   └── js/
│       ├── api.js         # Frontend API helpers
│       ├── chat.js        # Chat UI & SSE streaming
│       ├── image.js       # Image generation UI
│       ├── editor.js      # Monaco Editor integration
│       ├── inline-chat.js # Inline chat widget
│       ├── editor-tabs.js # Editor tab management
│       ├── models.js      # Model picker
│       ├── theme.js       # Dark/light theme
│       ├── settings.js    # Settings panel
│       ├── toast.js       # Toast notifications
│       ├── dom-style.js   # Dynamic CSS injection
│       └── utils.js       # Common utilities
├── tests/
│   ├── api-client.test.js
│   ├── agent-routes.test.js
│   ├── fs-routes.test.js
│   ├── routes.test.js
│   ├── server.test.js
│   ├── security-fixes.test.js
│   ├── review-fixes.test.js
│   ├── csp-style-src.test.js
│   ├── known-issues-fixes.test.js
│   ├── ...
│   └── test-helper.js     # Shared test utilities
└── docs/
    ├── api-specifications.md
    └── screenshots/        # Screenshots for README
```

## Key Design Decisions

### 1. BFF (Backend-for-Frontend) Pattern

The Express server acts as a BFF, keeping the 1min.ai API key on the server side. The browser never has direct access to the API key.

### 2. Security-First Architecture

- **localBffAuth**: Cookie + header double-submit pattern for CSRF protection
- **fs-guard**: Path traversal protection, symlink resolution, protected paths
- **CSP**: Strict policy with per-request nonces
- **CORS**: Localhost-only access
- **Host validation**: DNS rebinding protection

### 3. Monaco Editor Integration

The editor runs entirely in the browser. The BFF proxies all code-related API calls (`/api/code/*`). The editor is loaded via CDN by default, with an option for local copy.

### 4. Agent System

The AI coding agent maintains server-side sessions with:

- History management (trimming, persistence)
- Command execution with approval flow
- Pending command TTL (5 min)
- SEARCH/REPLACE diff application

### 5. Rate Limiting

All API endpoints are rate-limited per 1min.ai's official limits (180 req/min default). Autocomplete endpoints share the same limit to prevent upstream rejection.

## Data Flow

### Chat

```
User Input → chat.js → api("/api/chat") → server.js → ai.js → api-client.js → 1min.ai API
                                                                                     │
User ← chat.js (SSE) ← server.js (streaming) ← ai.js ← api-client.js ←──────────────┘
```

### File Operations

```
Editor Tab → app.js → api("/api/fs/*") → server.js → fs.js → fs-guard.js (validation)
                                                                      │
Editor Tab ← app.js ← server.js ← fs.js ←─────────────────────────────┘
```

### Agent Session

```
Agent UI → app.js → api("/api/agent/*") → server.js → agent.js → api-client.js → 1min.ai
                                                                      │
Agent UI ← app.js (streaming) ← server.js ← agent.js ←───────────────┘
```
