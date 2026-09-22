/** Process lifecycle states for the AAO Worker process itself. These are
 * distinct from the canonical AAO Workflow/Run lifecycle (see
 * docs/architecture/runtime-lifecycle.md), which belongs to a later sprint. */
export type WorkerProcessState = "CREATED" | "RUNNING" | "STOPPED";

/** An idle process-boundary worker. It performs no workflow execution, job
 * processing, polling, or queue consumption — see Section 15 of the Sprint 1
 * engineering foundation for the deliberate non-goals. */
export class Worker {
  private state: WorkerProcessState = "CREATED";

  constructor(private readonly workerId: string) {}

  getWorkerId(): string {
    return this.workerId;
  }

  getState(): WorkerProcessState {
    return this.state;
  }

  /** CREATED -> RUNNING. Starting twice is a genuine misuse and throws. */
  start(): void {
    if (this.state !== "CREATED") {
      throw new Error(`Worker cannot start from state ${this.state}`);
    }
    this.state = "RUNNING";
  }

  /** CREATED|RUNNING -> STOPPED. Idempotent so shutdown handlers never throw. */
  stop(): void {
    this.state = "STOPPED";
  }
}
