import Fastify, { type FastifyInstance } from "fastify";

/** A small, deterministic health payload. No decorative timestamps. */
function healthPayload(): { service: string; status: "ok" } {
  return { service: "aao-control-plane", status: "ok" };
}

/** Builds the Fastify application without binding a port. Kept separate from
 * process startup (see server.ts) so it can be tested with `inject()`. */
export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  // Is the process alive? No dependency checks.
  app.get("/health/live", async () => healthPayload());

  // Have the dependencies that currently exist initialized successfully?
  // There is no database, queue, workflow runtime, or model provider yet,
  // so there is nothing to check beyond the process being up.
  app.get("/health/ready", async () => healthPayload());

  return app;
}
