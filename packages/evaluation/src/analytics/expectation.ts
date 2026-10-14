import type { CaseExpectationVerdict, EvalExpectedVerdict, EvalResult, EvalVerdictSummary } from "@aao/contracts";
import { verdictSummary } from "./fingerprints.js";

/**
 * Did the regression case behave as declared? Mandatory distinction
 * (ADR-023): `EvalResult.status` is the evaluator's judgment of the
 * *system*; the case expectation verdict is whether the *case* behaved as
 * expected. A negative case that expects `failed(APPROVAL_BYPASSED)` and
 * gets exactly that is `MATCHED`; a deliberate evaluator-error case that
 * expects `error(EVAL_REQUIRED_EVIDENCE_INCOMPLETE)` and gets exactly that
 * is `MATCHED`.
 *
 * - `MATCHED`: same status; for `failed`, the same sorted set of failed
 *   assertion reason codes; for `error`, the same error code.
 * - `MISMATCHED`: a trustworthy judgment (`passed`/`failed`) that differs.
 * - `ERROR`: the evaluator could not judge, and the case did not expect
 *   exactly that error. Unexpected error codes never match.
 */
export function caseExpectationVerdict(expected: EvalExpectedVerdict, result: EvalResult): CaseExpectationVerdict {
  return expectationOfVerdict(expected, verdictSummary(result));
}

/** The same rule over an already-normalized verdict summary, so a suite report's verdicts can be recomputed from its own case data. */
export function expectationOfVerdict(expected: EvalExpectedVerdict, actual: EvalVerdictSummary): CaseExpectationVerdict {
  if (actual.status === "error") return expected.status === "error" && expected.errorCode === actual.errorCode ? "MATCHED" : "ERROR";
  if (expected.status !== actual.status) return "MISMATCHED";
  if (actual.status === "failed") return (expected.reasonCodes ?? []).join("\n") === actual.reasonCodes.join("\n") ? "MATCHED" : "MISMATCHED";
  return "MATCHED";
}
