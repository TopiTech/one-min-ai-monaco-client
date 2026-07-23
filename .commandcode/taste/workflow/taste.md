# Workflow
- Review/fix workflow uses prioritized tags: B- (blocker), H- (high), M- (medium), L- (low). Confidence: 0.65
- After implementing review fixes, conduct a full code review (Approve/Reject verdict with evidence). Confidence: 0.70
- Prefers deep code reading over relying on tool output (file listings, search results, git stats) for verification — tool output alone does not count as "reading code". Confidence: 0.90
- Investigates major functions and high-risk paths from entry through side effects to output, rather than exhaustive file scanning. Confidence: 0.90
- Makes autonomous decisions, investigating and reporting without excessive questioning. Confidence: 0.85
- Does not use CI/test success alone as release grounds; tests and lint are for hypothesis verification and gap-filling only. Confidence: 0.90
- Avoids side effects on external services, production, shared environments, and real data. Confidence: 0.90
- Verifies specs, compatibility, vulnerabilities, and external API specs only with official/primary sources when needed. Confidence: 0.85
