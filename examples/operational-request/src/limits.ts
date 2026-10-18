/**
 * Bounded limits for the Operational Request proof (Sprint 24).
 * Everything that enters the Workflow, model, proposal, draft, or result
 * has a strict upper bound. No open-ended payloads.
 */
export const OPERATIONAL_REQUEST_LIMITS = Object.freeze({
  minRequestIdLength: 3,
  maxRequestIdLength: 64,
  minInstructionLength: 5,
  maxInstructionLength: 1000,
  minAccountIdLength: 3,
  maxAccountIdLength: 32,
  minDisplayNameLength: 1,
  maxDisplayNameLength: 128,
  minJustificationLength: 5,
  maxJustificationLength: 500,
  maxDraftIdLength: 64,
});
