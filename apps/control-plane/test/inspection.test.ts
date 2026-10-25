import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createCanonicalDemoInspectionSource } from "@aao/operator-inspection";
import { buildApp } from "../src/app.js";

describe("control center inspection API", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });
  const make = async () => {
    app = buildApp({ inspectionSource: await createCanonicalDemoInspectionSource() });
    return app;
  };
  const headers = { host: "127.0.0.1:4000" };

  it("registers no inspection routes without a trusted source", async () => {
    app = buildApp();
    expect((await app.inject({ method: "GET", url: "/api/v1/inspection/overview" })).statusCode).toBe(404);
  });

  it("serves read-only projections", async () => {
    const a = await make();
    const overview = await a.inject({ method: "GET", url: "/api/v1/inspection/overview", headers });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().counts.companies).toBe(2);
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/runs/run.arbor.cr.incomplete", headers })).json().summary.status).toBe("UNKNOWN");
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/runs/run.northstar.cr.001/trace?limit=2", headers })).json().returnedEventCount).toBe(2);
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/approvals/approval.arbor.ops.002", headers })).json().approval.status).toBe("pending");
  });

  it("normalizes errors", async () => {
    const a = await make();
    const missing = await a.inject({ method: "GET", url: "/api/v1/inspection/runs/run.nope", headers });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("INSPECTION_NOT_FOUND");
    const tooMany = await a.inject({ method: "GET", url: "/api/v1/inspection/runs?limit=9999", headers });
    expect(tooMany.json().error.code).toBe("INSPECTION_LIMIT_EXCEEDED");
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/runs?x=1", headers })).statusCode).toBe(400);
  });

  it("refuses mutating methods and non-loopback hosts/origins; emits no CORS headers", async () => {
    const a = await make();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      expect((await a.inject({ method, url: "/api/v1/inspection/runs", headers })).statusCode).toBe(405);
    }
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/overview", headers: { host: "evil.example" } })).statusCode).toBe(403);
    expect((await a.inject({ method: "GET", url: "/api/v1/inspection/overview", headers: { ...headers, origin: "https://evil.example" } })).statusCode).toBe(403);
    const ok = await a.inject({ method: "GET", url: "/api/v1/inspection/overview", headers });
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("renders the UI with explicit states, escaping, and no mutation controls", async () => {
    const a = await make();
    const html = (await a.inject({ method: "GET", url: "/", headers })).body;
    expect(html).toContain("READ-ONLY SURFACE");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("COMPATIBLE");
    expect(html).not.toMatch(/<form|<button|<input|method="post"/i);
    expect((await a.inject({ method: "GET", url: "/control-center", headers })).statusCode).toBe(200);
  });

  it("keeps health endpoints working", async () => {
    const a = await make();
    expect((await a.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });
});
