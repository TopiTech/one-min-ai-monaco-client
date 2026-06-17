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

### Added
- `LICENSE` (MIT) and `SECURITY.md` for public distribution.
- `.github/` issue and pull request templates and Dependabot config.

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
