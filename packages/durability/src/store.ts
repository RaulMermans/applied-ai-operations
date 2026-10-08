import type { ApprovalRepository } from "@aao/approval";
import type { NodeAttemptOutcome } from "@aao/runtime";
import type { CancellationRecord, DurableCheckpoint, DurableOperation, RunManifest } from "./contracts.js";

/**
 * The storage-neutral durability port (ADR-019). AAO owns every semantic —
 * what a checkpoint, operation, or approval means, when each is written,
 * and how recovery decides — while an implementation only stores and
 * validates records. There is deliberately no raw file write, query, or
 * generic key/value access. Every method rejects with a redacted
 * `DurabilityError`; loaded data is schema-validated and corrupt data fails
 * closed rather than being skipped.
 *
 * Concurrency contract: a single writer per Run. Mutations of one Run are
 * serialized inside one store instance; checkpoint sequences are
 * create-if-absent; operation, approval, and cancellation updates are
 * compare-and-set and reject stale writes. No lease, election, or
 * multi-process coordination is provided.
 */
export interface DurabilityStore {
  /** Atomically creates the Run with its manifest and checkpoint 0. `DURABLE_RUN_ALREADY_EXISTS` if the Run exists. */
  createRun(manifest: RunManifest, initialCheckpoint: DurableCheckpoint): Promise<void>;
  getRun(runId: string): Promise<RunManifest | undefined>;
  /** Persists checkpoint `latest + 1` immutably. Any other sequence, or an existing one, is `DURABILITY_CONFLICT`. */
  writeCheckpoint(checkpoint: DurableCheckpoint): Promise<void>;
  /** The newest checkpoint, after validating the whole contiguous chain. */
  getLatestCheckpoint(runId: string): Promise<DurableCheckpoint | undefined>;
  /** Write-ahead intent: creates a `STARTED` operation. An existing operation id is `DURABILITY_CONFLICT`. */
  beginOperation(operation: DurableOperation): Promise<void>;
  /** Marks a bounded crash replay of a `STARTED` operation (compare-and-set on its replay count). */
  markOperationReplay(runId: string, operationId: string, expectedReplayCount: number): Promise<void>;
  /** `STARTED → OUTCOME_RECORDED` with a Runtime-validated outcome. Anything else is `DURABILITY_CONFLICT`. */
  recordOperationOutcome(runId: string, operationId: string, outcome: NodeAttemptOutcome, completedAt: string): Promise<void>;
  /** Every operation of the Run, validated, ordered by step then attempt. */
  getOperationsForRun(runId: string): Promise<DurableOperation[]>;
  /** Idempotent: returns the existing request if one was already persisted. */
  requestCancellation(runId: string, requestedAt: string): Promise<CancellationRecord>;
  getCancellation(runId: string): Promise<CancellationRecord | undefined>;
  /** Durable-capable Approval storage implementing the `@aao/approval` repository port. */
  readonly approvals: ApprovalRepository;
}
