# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `/api/health` no longer exposes internal 1min.ai error messages
  (`models.error` → boolean `syncFailed`).
- Image extraction falls back to `aiRecord.output` to support newer
  1min.ai response shapes.
- `docs/api-specifications.md` aligned with current 1min.ai field names.
- `.env.example` documents `LOG_TO_FILE`.
- Monaco Editor assets are served locally (`public/vs/`) instead of
  from a CDN, eliminating external dependency and allowing tighter CSP.
- CSP directives tightened: removed `cdn.jsdelivr.net` from
  `script-src`, `connect-src`, `font-src`, and `worker-src`.
- `server.js` `express.static` now sets `X-Content-Type-Options: nosniff`
  for `.js` files and excludes `.map` files from serving.
- `scripts/copy-monaco.js` improved with existence check to avoid
  redundant copy when `public/vs/` already matches `node_modules`.

### Added

- Per-model image parameters for both providers: 1min.ai's 46 generator /
  27 editor models and 1forall.ai's catalog `sizes` + `additional_fields` are
  described by `services/image-schema.js` and exposed through
  `GET /api/images/capabilities`, so the UI renders model-specific controls
  instead of a fixed form.
- `POST /api/images/feature` for the remaining 1min.ai image features
  (`IMAGE_VARIATOR`, `IMAGE_UPSCALER`, `IMAGE_INPAINTER`, background/object
  removal, face swap, 3D, image-to-prompt, ...).
- `scripts/sync-image-specs.js` regenerates `config/image-specs/1min.json`
  from the public docs (`--dry-run`, `--verbose`, `--report`), with
  `config/image-specs/1min-overrides.json` holding enums and ranges.
- 1forall.ai image editing now uploads the source to the model library before
  calling `image-to-image`, and job polling flattens `urls` /
  `child_conversions` into a single URL list.
- Image feature selector and dynamic parameter grid in the image panel
  (ja/en labels), plus `model-selected` event from the model picker.
- `tests/image-expansion.test.js` covering capabilities, per-model payloads,
  unknown-parameter rejection, upload hand-off, multi-output polling, docs
  transcription integrity, and frontend wiring/i18n.
- `LICENSE` (MIT) and `SECURITY.md` for public distribution.
- `.github/` issue and pull request templates and Dependabot config.
- `monaco-editor` added to Dependabot monitoring.
- `editor-tabs-bar` CSS for multi-tab editor UI.
- Integration tests for `/api/fs/*` routes (list, read, delete, rename)
  with protection checks.
- Unit tests for `api-client.js` retry and timeout logic.
- Unit tests for `server.js` multer error mapping and `/api/health`.
- Unit tests for `config/models.js` fetchModels fallback behavior.

## [1.0.0] - 2026-06-17

### Added

- BFF Express server that proxies the 1min.ai API without leaking the
  key to the browser.
- Normal chat (`/api/chat`, `/api/chat/stream` with SSE) and conversation
  history (`/api/conversations`).
- Image generation (`/api/images/generate`) and image text editor
  (`/api/images/text-editor`) with `gpt-image-*` size validation.
- Code generation, autocomplete, and inline chat (`/api/code/*`).
- Asset upload (`/api/assets/upload`) with MIME sniffing and size limit.
- File system access (`/api/fs/*`) confined to `ALLOWED_ROOTS` with
  symlink / TOCTOU protection.
- Coding agent (`/api/agent/*`) with session persistence, command
  approval flow, diff-based patching, and search.
- Monaco editor integration with tabs, theme, autocompletion, and
  inline chat widget.
- Model picker with provider grouping, tag filter, and credit-saving
  mode.
- Local BFF authentication (HttpOnly cookie + custom header + same-origin
  check) for dev servers.
- Helmet CSP, rate limiting, request logging, and an atomic-write
  session store.

### Security

- `command-runner` with allowlist + dangerous-pattern blocking + shell
  metacharacter blocking.
- MIME-type guard against binary spoofing as text.
- `fs-guard` with `realpathSync`-based path validation.

[Unreleased]: https://github.com/TopiTech/one-min-ai-monaco-client/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/TopiTech/one-min-ai-monaco-client/releases/tag/v1.0.0
