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

  it("renders the UI with explicit states, escaping, links, and no mutation controls", async () => {
    const a = await make();
    const html = (await a.inject({ method: "GET", url: "/", headers })).body;
    expect(html).toContain("READ-ONLY SURFACE");
    expect(html).toContain("DEMO DATA — NOT LIVE OPERATIONS");
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("NOT_VERIFIED");
    expect(html).toContain('/control-center/runs/run.northstar.cr.001');
    expect(html).not.toMatch(/<form|<button|<input|method="post"/i);
    expect((await a.inject({ method: "GET", url: "/control-center", headers })).statusCode).toBe(200);
  });

  it("serves read-only browser run detail with authoritative status and timeline", async () => {
    const a = await make();
    const res = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.northstar.cr.001",
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    const html = res.body;
    expect(html).toContain("DEMO DATA — NOT LIVE OPERATIONS");
    expect(html).toContain("run.northstar.cr.001");
    expect(html).toContain("COMPLETED");
    expect(html).toContain("Trace Timeline");
    expect(html).toContain("/control-center");
    expect(html).not.toMatch(/<form|<button|<input|method="post"/i);
  });

  it("browser run detail reports UNKNOWN for incomplete runs", async () => {
    const a = await make();
    const res = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.arbor.cr.incomplete",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toContain("UNKNOWN");
    expect(html).toContain("unavailable");
  });

  it("browser run detail returns safe 404 with INSPECTION_RUN_NOT_FOUND and no stack trace", async () => {
    const a = await make();
    const res = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.missing.404",
      headers,
    });
    expect(res.statusCode).toBe(404);
    const html = res.body;
    expect(html).toContain("INSPECTION_RUN_NOT_FOUND");
    expect(html).toContain("was not found in known inspection sources");
    expect(html).not.toMatch(/\.ts:\d+|\.js:\d+|at\s+async\s+/);
  });

  it("refuses mutating methods and non-loopback hosts on browser run detail routes", async () => {
    const a = await make();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await a.inject({
        method,
        url: "/control-center/runs/run.northstar.cr.001",
        headers,
      });
      expect(res.statusCode).toBe(405);
    }
    const evilHost = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.northstar.cr.001",
      headers: { host: "evil.example" },
    });
    expect(evilHost.statusCode).toBe(403);

    const evilOrigin = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.northstar.cr.001",
      headers: { ...headers, origin: "https://evil.example" },
    });
    expect(evilOrigin.statusCode).toBe(403);
  });

  it("keeps health endpoints working", async () => {
    const a = await make();
    expect((await a.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
  });

  it("serves integration diagnostics API and browser routes", async () => {
    const a = await make();
    // JSON API
    const apiRes = await a.inject({
      method: "GET",
      url: "/api/v1/inspection/companies/northstar-commerce/packs/aao.company-research@1.0.0/diagnostics",
      headers,
    });
    expect(apiRes.statusCode).toBe(200);
    const json = apiRes.json();
    expect(json.status).toBe("NOT_VERIFIED");
    expect(json.requirements.length).toBeGreaterThan(0);
    expect(json.sourceProvenance.mode).toBe("demo");

    // Browser UI
    const uiRes = await a.inject({
      method: "GET",
      url: "/control-center/companies/northstar-commerce/packs/aao.company-research@1.0.0",
      headers,
    });
    expect(uiRes.statusCode).toBe(200);
    expect(uiRes.headers["content-type"]).toContain("text/html");
    const html = uiRes.body;
    expect(html).toContain("Integration Readiness Overview");
    expect(html).toContain("Requirements Checklist");
    expect(html).toContain("Actionable Next Steps");
    expect(html).toContain("READ-ONLY SURFACE");
    expect(html).not.toMatch(/<form|<button|<input|method="post"/i);

    // 404 for unknown pack
    const notFoundRes = await a.inject({
      method: "GET",
      url: "/control-center/companies/northstar-commerce/packs/pack.unknown@1.0.0",
      headers,
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it("serves advanced run analysis API and enhanced browser run detail with node selection", async () => {
    const a = await make();
    // JSON API
    const analysisRes = await a.inject({
      method: "GET",
      url: "/api/v1/inspection/runs/run.northstar.cr.001/analysis",
      headers,
    });
    expect(analysisRes.statusCode).toBe(200);
    const json = analysisRes.json();
    expect(json.runId).toBe("run.northstar.cr.001");
    expect(json.authoritativeStatus).toBe("COMPLETED");
    expect(json.nodes.length).toBeGreaterThan(0);
    expect(json.attempts.length).toBeGreaterThan(0);

    // Enhanced browser run detail with node selection
    const uiRes = await a.inject({
      method: "GET",
      url: "/control-center/runs/run.northstar.cr.001?nodeId=plan",
      headers,
    });
    expect(uiRes.statusCode).toBe(200);
    const html = uiRes.body;
    expect(html).toContain("Execution Summary (Correlated Runtime &amp; Trace Evidence)");
    expect(html).toContain("Workflow Node Execution Map");
    expect(html).toContain("Selected Node Detail");
    expect(html).toContain("plan");
    expect(html).toContain("Node Attempts (2)");
    expect(html).not.toContain("Total Attempts");
    expect(html).not.toMatch(/<form|<button|<input|method="post"/i);
  });
});
