import { loadControlPlaneConfig } from "@aao/config";
import { buildApp } from "./app.js";

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "aao-control-plane", event, ...extra }));
}

async function main(): Promise<void> {
  const config = loadControlPlaneConfig(process.env);
  const app = buildApp();

  await app.listen({ host: config.host, port: config.port });
  log("started", { environment: config.env, port: config.port });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    log("shutting_down", { signal });
    app
      .close()
      .then(() => {
        log("stopped");
        process.exit(0);
      })
      .catch((error: unknown) => {
        console.error(JSON.stringify({ service: "aao-control-plane", event: "shutdown_failed" }), error);
        process.exit(1);
      });
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ service: "aao-control-plane", event: "startup_failed" }), error);
  process.exit(1);
});
