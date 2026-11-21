# RE:VERSE (apps/reverse)

These rules add to the root `AGENTS.md` and never override it.

- RE:VERSE consumes AAO. Keep PostgreSQL, Docker and Atlassian/Forge code here, never in `packages/*` (ADR-036).
- Only the deterministic evaluator (`src/domain/evaluate.ts`) issues `PASS`/`FAIL`/`INCONCLUSIVE`. Models and runners propose evidence; they never decide.
- Infrastructure failure, timeout or missing evidence must yield `INCONCLUSIVE`, never `PASS` or `FAIL`.
- Run only allowlisted, in-repo, synthetic fixtures. Never run pull-request code, connect to a real database, or use production credentials.
- Never invent a commit SHA, an Atlassian installation or a callback. Report what has not been verified as `NOT_VERIFIED` or `BLOCKED`.
- Forge deploys and installs are external side effects and need explicit user approval for each one.
