import type { CaseExpectationVerdict, EvalExpectedVerdict, EvalResult } from "@aao/contracts";
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
  if (result.status === "error") return expected.status === "error" && expected.errorCode === result.errorCode ? "MATCHED" : "ERROR";
  if (expected.status !== result.status) return "MISMATCHED";
  if (result.status === "failed") return (expected.reasonCodes ?? []).join("\n") === verdictSummary(result).reasonCodes.join("\n") ? "MATCHED" : "MISMATCHED";
  return "MATCHED";
}
