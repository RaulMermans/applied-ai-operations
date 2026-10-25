import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  OperatorInspectionError,
  createOperatorInspectionService,
  normalizeInspectionError,
  type OperatorInspectionService,
  type OperatorInspectionSource,
} from "@aao/operator-inspection";
import { renderControlCenterHtml } from "./ui.js";

/** A small, deterministic health payload. No decorative timestamps. */
function healthPayload(): { service: string; status: "ok" } {
  return { service: "aao-control-plane", status: "ok" };
}

export interface BuildAppOptions {
  /**
   * Trusted-host-supplied read-only inspection source. When omitted, no
   * inspection routes are registered. Requests can never supply sources or paths.
   */
  readonly inspectionSource?: OperatorInspectionSource;
}

const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function hostnameOf(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  return trimmed.split(":")[0] ?? "";
}

function isLoopbackRequest(request: FastifyRequest): boolean {
  const host = request.headers.host;
  if (typeof host !== "string" || !LOOPBACK_NAMES.has(hostnameOf(host))) return false;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      const url = new URL(origin);
      if (!LOOPBACK_NAMES.has(url.hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const normalized = normalizeInspectionError(err);
  return reply.code(normalized.httpStatus()).send(normalized.toResponse());
}

/** Builds the Fastify application without binding a port. Kept separate from
 * process startup (see server.ts) so it can be tested with `inject()`. */
export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });

  // Is the process alive? No dependency checks.
  app.get("/health/live", async () => healthPayload());

  // Have the dependencies that currently exist initialized successfully?
  app.get("/health/ready", async () => healthPayload());

  if (options.inspectionSource === undefined) return app;

  const service: OperatorInspectionService = createOperatorInspectionService(options.inspectionSource);

  // Read-only guard: loopback Host/Origin only, GET only, no CORS headers ever emitted.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const inspected = path.startsWith("/api/v1/inspection") || path === "/" || path === "/control-center";
    if (!inspected) return;
    if (!isLoopbackRequest(request)) {
      return reply.code(403).send({ error: { code: "INSPECTION_INVALID_REQUEST", message: "Control Center accepts loopback requests only." } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(405).header("allow", "GET, HEAD").send({ error: { code: "INSPECTION_INVALID_REQUEST", message: "Inspection surface is read-only." } });
    }
  });

  const guarded = <T>(handler: (request: FastifyRequest) => Promise<T>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(request);
      } catch (err) {
        return sendError(reply, err);
      }
    };

  const base = "/api/v1/inspection";
  app.get(`${base}/overview`, guarded(() => service.getOverview()));
  app.get(`${base}/companies`, guarded(async () => ({ companies: await service.listCompanies() })));
  app.get(`${base}/packs`, guarded((r) => service.listCapabilityPacks(r.query)));
  app.get(`${base}/workflows`, guarded(async () => ({ workflows: await service.listWorkflows() })));
  app.get(`${base}/runs`, guarded(async (r) => ({ runs: await service.listKnownRuns(r.query) })));
  app.get(`${base}/runs/:runId`, guarded((r) => service.getRunInspection((r.params as { runId: string }).runId)));
  app.get(`${base}/runs/:runId/trace`, guarded((r) => service.getRunTraceInspection((r.params as { runId: string }).runId, r.query)));
  app.get(`${base}/approvals`, guarded(async () => ({ approvals: await service.listKnownApprovals() })));
  app.get(`${base}/approvals/:approvalId`, guarded(async (r) => ({ approval: await service.getApprovalSummary((r.params as { approvalId: string }).approvalId) })));
  app.get(`${base}/evaluations`, guarded(async (r) => ({ evaluations: await service.listKnownEvaluationResults(r.query) })));

  // Any other non-GET method on the inspection prefix is refused by the guard; unknown GETs are 404.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: { code: "INSPECTION_NOT_FOUND", message: `Unknown route ${request.method} ${request.url.split("?")[0]}` } });
  });

  const page = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const overview = await service.getOverview();
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .header("x-content-type-options", "nosniff")
        .send(renderControlCenterHtml(overview));
    } catch (err) {
      if (err instanceof OperatorInspectionError) return sendError(reply, err);
      return sendError(reply, err);
    }
  };
  app.get("/", page);
  app.get("/control-center", page);

  return app;
}
