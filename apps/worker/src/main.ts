import { loadWorkerConfig } from "@aao/config";
import { Worker } from "./worker.js";

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "aao-worker", event, ...extra }));
}

function main(): void {
  const config = loadWorkerConfig(process.env);
  const worker = new Worker(config.workerId);

  worker.start();
  log("started", { environment: config.env, worker_id: worker.getWorkerId() });

  // The worker does no job processing, so nothing else holds the event loop
  // open. This interval never fires in practice (shutdown clears it first);
  // it exists only to keep the process alive until a termination signal
  // arrives. It is a lifecycle mechanism, not a polling loop: it performs no
  // work and inspects no external state.
  const keepAlive = setInterval(() => {}, 1 << 30);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log("shutting_down", { signal });
    clearInterval(keepAlive);
    worker.stop();
    log("stopped");
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ service: "aao-worker", event: "startup_failed" }), error);
  process.exit(1);
}
