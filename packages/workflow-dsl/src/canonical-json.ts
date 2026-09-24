/**
 * Re-exports `@aao/contracts`'s canonical JSON fingerprint helper. The
 * implementation lives in `@aao/contracts` (see `packages/contracts/src/json.ts`)
 * because `@aao/runtime`'s preflight needs the exact same structural-equality
 * semantics for its own edge-fingerprint comparison (see ADR-010) and both
 * packages already depend on `@aao/contracts` — this avoids a private
 * cross-package import and duplicate logic. This module is kept only so
 * existing local imports (`./canonical-json.js`) and this package's own test
 * for it continue to work unchanged.
 */
export { canonicalJsonStringify } from "@aao/contracts";
