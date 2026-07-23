# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/

# Workflow
See [workflow/taste.md](workflow/taste.md)
# Communication

- Respond in Japanese for this project. Confidence: 0.85
- Reports only confirmed issues as "problems"; separates speculation, general statements, preferences, and unverifiable concerns into "unconfirmed items". Confidence: 0.90
- Uses a structured 9-section release report format (conclusion, investigation scope, structure/flow, confirmed issues, verification, references, unconfirmed items, residual risks, fix order). Confidence: 0.80

# Build & Test

- Run `npm test` to verify changes before declaring done. Confidence: 0.80
- Run `npm run test:coverage` to check line coverage. Confidence: 0.70

# Git

- Use `git rm --cached <file>` to untrack files already in `.gitignore`. Confidence: 0.75
- Prohibits destructive git operations: reset, checkout, clean, stage, commit, push. Confidence: 0.90

# Code Style

- Prefer try/finally for cleanup of in-flight state (counters, locks, timers). Confidence: 0.70
- Use atomic file writes: write to `.tmp` then `fs.rename` to target. Confidence: 0.75
- Throttle expensive UI re-renders with `requestAnimationFrame`. Confidence: 0.65
- Validate HTTP requests with explicit positive-integer range checks for line/column parameters. Confidence: 0.65

# Security / CSP

- When a CSP `style-src` or `script-src` directive contains a nonce, `'unsafe-inline'` is ignored by the browser. To allow inline styles/scripts alongside a nonce, use hashes (e.g. `'sha256-...'`) or remove the nonce, not both together. Confidence: 0.85
- For libraries like Monaco that internally use `element.style.*` and `setAttribute('style', ...)`, set both `style-src` and `style-src-attr` directives together. Confidence: 0.80
- Does not output secrets or PII; reports type and location only. Confidence: 0.90

# Testing

- When building `new RegExp()` from a template literal with user-controlled strings (e.g. base64 nonces containing `+`, `/`, `=`), escape regex metacharacters first with `String.prototype.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`. Confidence: 0.75
- Fix all test failures including pre-existing ones — dismissing an existing test failure as "already broken before changes" is not acceptable; resolve them as part of the review/fix cycle. Confidence: 0.70

# Assumptions

- Do not assume unusual-looking code (e.g. embedded system prompts, foreign-language strings, mojibake) is a "prompt injection" or "contamination" — ask the user to confirm intent before declaring it an attack. Confidence: 0.75
