# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Use GitHub's private vulnerability reporting:
- Go to https://github.com/TopiTech/one-min-ai-monaco-client/security/advisories/new
- Provide a clear description, reproduction steps, and impact assessment.

You can expect an initial response within 7 days. We will coordinate a fix
and a disclosure timeline before any public announcement.

## Operational Guidance

This is an MVP BFF server. The following are **not** implemented and
should be addressed before exposing the service beyond localhost:

- Authentication of end users (only a local BFF token is enforced).
- CSRF mitigation uses a double-submit cookie pattern (`HttpOnly` cookie +
  `x-local-bff-token` header + same-origin check). There are no
  traditional anti-CSRF tokens.
- Audit logging of agent command executions and file modifications.
- Sandboxed execution for `ENABLE_COMMAND_EXECUTION=true`.

## Secret Hygiene

- Never commit `.env`. The repository's `.gitignore` excludes it, but if
  a key is ever pushed, **rotate it immediately** via
  https://app.1min.ai/. Past leaks remain in git history even after a
  `git filter-repo` rewrite.
- The local BFF token is regenerated on every server start when not
  supplied via `LOCAL_BFF_AUTH_TOKEN`.

## Threat Model Summary

The server is designed for **local single-user development**. It exposes
file system operations scoped to `ALLOWED_ROOTS` and a command runner
that is **disabled by default** (`ENABLE_COMMAND_EXECUTION=false`).

Running this server on a publicly reachable address without additional
hardening is not supported.
