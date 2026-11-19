// Sprint 29 compiled smoke: the security-hardening proof from compiled
// package output only (run after `pnpm build`). Offline; fictional data.
import process from 'node:process';
import { FIXTURE_SECRET, SECURITY_CASES, runSecurityRegressionSuite } from '../dist/src/index.js';

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// Mandatory Sprint 29 checks → the case(s) that measure each.
const MANDATORY = {
  'Forged Principal → Admission Denied → 0 Model Calls → 0 Tool Calls': ['identity.forged-principal', 'identity.missing-attestation'],
  'Cross-Company Run Binding → Refused': ['identity.rebind-other-company', 'continuation.cross-company-replay'],
  'Forged Continuation → Refused Before Origin Attestation': ['continuation.forged-refused-before-origin-attestation', 'continuation.forged-state-refused'],
  'Approval Fingerprint Mismatch → Refused': ['replay.approval-fingerprint-mismatch'],
  'Concurrent Draft Replay → No Duplicate Logical Draft': ['replay.concurrent-continuation'],
  'Invalid Adapter Output → Normalized Failure': ['model.invalid-json-output', 'tool.extra-fields-rejected'],
  'Unsafe Tool Retry → No Duplicate Handler Invocation': ['replay.unsafe-tool-retry-not-repeated'],
  'Non-Loopback Control Center Request → Refused': ['control-center.non-loopback-refused'],
  'Sensitive Error Payload → Not Exposed in Trace / API / CLI': ['observability.sensitive-error-not-exposed'],
  'Requester B same company/permission continues Run R → RUN_BINDING_MISMATCH, 0 unauthorized Tools': ['continuation.other-requester-same-role-refused'],
  'Requester B refused; Requester A continues → COMPLETED, exactly one logical draft': ['continuation.other-requester-same-role-refused'],
  'Company Research Tool Execution → Canonical Tool Audit event observed': ['audit.company-research-tool-access'],
  'Document Intelligence Tool Execution → Canonical Tool Audit event observed': ['audit.document-intelligence-tool-access'],
  'Operational Request Approval + Tool → Existing canonical Audit events preserved': ['audit.operational-request-approval-and-tool'],
  'Audit Sink Failure → No authorization bypass, no duplicate side effect': ['audit.sink-failure-does-not-bypass-or-duplicate'],
};

const results = await runSecurityRegressionSuite();
const byId = new Map(results.map((r) => [r.id, r]));
assert(results.length === SECURITY_CASES.length && results.length >= 40, `expected ≥ 40 cases, got ${results.length}`);
for (const [check, ids] of Object.entries(MANDATORY)) {
  for (const id of ids) {
    const r = byId.get(id);
    assert(r, `mandatory case ${id} is missing`);
    assert(r.passed, `${check}: ${id} failed — ${r.evidence}`);
  }
  process.stdout.write(`ok  ${check}\n`);
}
const failed = results.filter((r) => !r.passed);
assert(failed.length === 0, `failed cases: ${failed.map((r) => `${r.id} (${r.evidence})`).join('; ')}`);
assert(!JSON.stringify(results).includes(FIXTURE_SECRET), 'suite evidence contains the fixture secret');
process.stdout.write(`ok  ${results.length}/${results.length} security regression cases\n`);
process.stdout.write('SPRINT_29_SECURITY_IDENTITY_ADAPTER_HARDENING_SMOKE_OK\n');
