// @aao/durability — AAO's durable execution layer (Sprint 14; see
// docs/architecture/durable-execution.md and ADR-019). Persists Runtime
// truth at safe boundaries, writes operation intent ahead of every executor
// attempt and validated outcomes before every commit, recovers Runs after a
// process restart through the single Runtime loop, and replays an ambiguous
// operation only when trusted recovery/idempotency metadata makes it safe.
// The reference store is local, single-host, single-writer filesystem
// storage. No exactly-once claim, queue, worker pool, distributed
// coordination, tracing, or external-side-effect enablement.

export {
  MAX_RECOVERY_REPLAYS,
  RunManifestSchema,
  DurableCheckpointSchema,
  DurableOperationSchema,
  CancellationRecordSchema,
  DURABILITY_FAILURE_CODES,
  DurabilityError,
  checkpointIdFor,
  operationIdFor,
  type RunManifest,
  type DurableCheckpoint,
  type DurableOperation,
  type CancellationRecord,
  type DurabilityFailureCode,
} from "./contracts.js";
export { planFingerprint } from "./fingerprint.js";
export type { DurabilityStore } from "./store.js";
export { createFileDurabilityStore } from "./file-store.js";
export { executionFromCheckpoint, planRecovery, type RecoveryPlan } from "./recovery.js";
export { createDurableRuntimeHost, type DurableRuntimeHost, type DurableRuntimeHostOptions, type DurableRunResult, type DurableRunView, type DurabilityFailure, type CancellationRequest } from "./host.js";
