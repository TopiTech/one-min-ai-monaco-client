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

This is an MVP BFF server designed for local single-user development. The following security measures are implemented to protect the local environment:

- **BFF Authentication:** Uses a generated local BFF token validated via both a custom header (`x-local-bff-token`) and an `HttpOnly` same-site strict cookie (`__bff_session`).
- **CORS Protection:** Enforces origin checks. Only same-origin requests or cross-origin requests originating from `localhost` / `127.0.0.1` are permitted. All external origins are blocked (403 Forbidden).
- **Symlink Path Traversal Checks:** Standard reads and agent write/replace operations are guarded against directory traversal and TOCTOU symlink swap attacks via paths validation (`revalidateRealPath`).
- **Asset Proxy Restrictions:** Limits the `/api/assets/proxy` route strictly to domains owned by 1min.ai (including regional `asset.1min.ai.s3` Amazon S3 buckets) to mitigate SSRF (Server-Side Request Forgery) vulnerabilities.

The following are **not** implemented and must be addressed before hosting the service on any public or shared platform:

- Authentication and authorization of multiple end-users (no user account management or RBAC exists).
- Audit logging of agent command executions and file modifications.
- Sandboxed or containerized environment execution for arbitrary command runs when `ENABLE_COMMAND_EXECUTION=true`.
- **RCE Warning:** Enabling `ENABLE_COMMAND_EXECUTION=true` alongside `AGENT_AUTO_APPROVE=true` allows the AI agent to execute arbitrary OS commands without user confirmation. This introduces a Remote Code Execution (RCE) vector if the model is fed malicious instructions. For public hosting, a containerized execution sandbox (e.g., Docker/gVisor) is mandatory.

## Secret Hygiene

- Never commit `.env`. The repository's `.gitignore` excludes it, but if a key is ever pushed, **rotate it immediately** via https://app.1min.ai/. Past leaks remain in git history even after a `git filter-repo` rewrite.
- The local BFF token is regenerated on every server start when not supplied via `LOCAL_BFF_AUTH_TOKEN`.

## Threat Model Summary

The server is designed for **local single-user development** only. It exposes file system operations scoped to `ALLOWED_ROOTS` and a command runner that is **disabled by default** (`ENABLE_COMMAND_EXECUTION=false`).

Running this server on a publicly reachable address or in multi-tenant environments without additional custom authentication, auditing, and sandboxing is **not supported and is highly insecure**.
