import type { DurableExecutor, DurableRun } from "@aao/substrate-contracts";

export class CheckpointError extends Error {}

type StoredRun = DurableRun;

/** In-memory only: demonstrates an AAO-owned persistence contract, not production durability. */
export class LocalDurableSpike implements DurableExecutor {
  private readonly runs = new Map<string, StoredRun>();

  async start(runId: string): Promise<DurableRun> {
    if (this.runs.has(runId)) throw new CheckpointError(`Run already exists: ${runId}`);
    const run: StoredRun = {
      runId,
      status: "running",
      currentStep: "first-step",
      state: {},
      completedOperations: [],
      checkpoint: 0,
    };
    this.runs.set(runId, run);
    return structuredClone(run);
  }

  async getRun(runId: string): Promise<DurableRun> {
    const run = this.runs.get(runId);
    if (!run) throw new CheckpointError(`Checkpoint missing or corrupt: ${runId}`);
    return structuredClone(run);
  }

  async cancel(runId: string): Promise<DurableRun> {
    const run = await this.getRun(runId);
    run.status = "interrupted";
    this.runs.set(runId, run);
    return structuredClone(run);
  }

  async resume(runId: string): Promise<DurableRun> {
    const run = await this.getRun(runId);
    if (run.status !== "interrupted") throw new CheckpointError(`Run is not resumable: ${runId}`);
    run.status = "running";
    this.runs.set(runId, run);
    return structuredClone(run);
  }

  /** Idempotently records an operation before an interruption can lead to a replay. */
  async executeOnce(runId: string, operation: string, effect: () => void): Promise<DurableRun> {
    const run = await this.getRun(runId);
    if (!run.completedOperations.includes(operation)) {
      effect();
      run.completedOperations.push(operation);
      run.currentStep = operation;
      run.checkpoint += 1;
      this.runs.set(runId, run);
    }
    return structuredClone(run);
  }

  async complete(runId: string): Promise<DurableRun> {
    const run = await this.getRun(runId);
    run.status = "completed";
    this.runs.set(runId, run);
    return structuredClone(run);
  }
}
