# Security Policy

AAO is pre-release software. Security fixes go to the `main` branch only.

## Reporting a vulnerability

Do **not** open a public issue. Report the vulnerability privately through GitHub instead: open the **Security** tab and choose **Report a vulnerability**.

Include the affected package, steps to reproduce, and the impact. We aim to acknowledge reports within 7 days.

Bypasses of the authorization, approval, or Tool permission boundaries are in scope and get priority. See [docs/security/permission-model.md](docs/security/permission-model.md), the [Local V1 threat model](docs/security/local-v1-threat-model.md), and [limitations](docs/release/local-v1-limitations.md).

The executable security suite is `pnpm proof:security-hardening` (also part of `pnpm test` and Local V1 release verification). Case count is defined by `SECURITY_CASES` in `examples/security-hardening`, including Sprint 29C original-requester ownership and Audit coverage.
