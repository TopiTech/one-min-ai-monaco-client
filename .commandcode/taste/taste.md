# Taste (Continuously Learned by [CommandCode][cmd])

[cmd]: https://commandcode.ai/


# Workflow
- Review/fix workflow uses prioritized tags: B- (blocker), H- (high), M- (medium), L- (low). Confidence: 0.65
- After implementing review fixes, conduct a full code review (Approve/Reject verdict with evidence). Confidence: 0.70

# Communication
- Respond in Japanese for this project. Confidence: 0.85

# Build & Test
- Run `npm test` to verify changes before declaring done. Confidence: 0.80
- Run `npm run test:coverage` to check line coverage. Confidence: 0.70

# Git
- Use `git rm --cached <file>` to untrack files already in `.gitignore`. Confidence: 0.75

# Code Style
- Prefer try/finally for cleanup of in-flight state (counters, locks, timers). Confidence: 0.70
- Use atomic file writes: write to `.tmp` then `fs.rename` to target. Confidence: 0.75
- Throttle expensive UI re-renders with `requestAnimationFrame`. Confidence: 0.65
- Validate HTTP requests with explicit positive-integer range checks for line/column parameters. Confidence: 0.65

# Security / CSP
- When a CSP `style-src` or `script-src` directive contains a nonce, `'unsafe-inline'` is ignored by the browser. To allow inline styles/scripts alongside a nonce, use hashes (e.g. `'sha256-...'`) or remove the nonce, not both together. Confidence: 0.85
- For libraries like Monaco that internally use `element.style.*` and `setAttribute('style', ...)`, set both `style-src` and `style-src-attr` directives together. Confidence: 0.80

# Testing
- When building `new RegExp()` from a template literal with user-controlled strings (e.g. base64 nonces containing `+`, `/`, `=`), escape regex metacharacters first with `String.prototype.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`. Confidence: 0.75

# Assumptions
- Do not assume unusual-looking code (e.g. embedded system prompts, foreign-language strings, mojibake) is a "prompt injection" or "contamination" — ask the user to confirm intent before declaring it an attack. Confidence: 0.75