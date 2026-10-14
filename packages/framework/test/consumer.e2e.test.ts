import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { alice, bob, runConsumerScenarios } from "./consumer/app.js";

const here = dirname(fileURLToPath(import.meta.url));
/** Code only: comments may mention lower-level packages; imports may not. */
const consumerSource = readFileSync(join(here, "consumer", "app.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

let outcome: Awaited<ReturnType<typeof runConsumerScenarios>>;
beforeAll(async () => {
  outcome = await runConsumerScenarios();
});

describe("consumer fixture: public imports only", () => {
  it("imports nothing but @aao/framework — no deep imports, relative repository imports, or lower-level packages", () => {
    const specifiers = [...consumerSource.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((match) => match[1]);
    expect(specifiers).toEqual(["@aao/framework"]);
    expect(consumerSource).not.toMatch(/@aao\/(?!framework["'])|from\s+["']\.|require\(|import\(/);
  });

  it("type-checks with TypeScript against the public surface only", () => {
    const tsc = join(here, "..", "..", "..", "node_modules", "typescript", "bin", "tsc");
    expect(() => execFileSync(process.execPath, [tsc, "-p", join(here, "consumer", "tsconfig.source.json")], { stdio: "pipe" })).not.toThrow();
  }, 60_000);
});

describe("consumer E2E: Approval → Tool → final_output through the public API", () => {
  it("waits for Approval with the Tool untouched; a pending continuation stays a canonical failure", () => {
    const { approved } = outcome;
    expect(approved.waiting).toMatchObject({ ok: true, status: "WAITING_FOR_APPROVAL", revision: 0, nodes: { approve: "WAITING", draft: "PENDING", final: "PENDING" } });
    expect(approved.approvalId).toMatch(/^approval:[a-f0-9]{64}$/);
    expect(approved.pendingContinue).toMatchObject({ ok: false, failure: "APPROVAL_STILL_PENDING", status: "WAITING_FOR_APPROVAL" });
    expect(approved.draftCallsWhileWaiting).toBe(0);
  });

  it("the requester comes from the host principal; self-approval is refused by the Approval Engine; an eligible manager approves", () => {
    const { approved } = outcome;
    expect(approved.requestedBy).toEqual(alice);
    expect(approved.selfApproval).toBe("APPROVAL_RESOLVER_NOT_ELIGIBLE");
    expect(approved.resolvedBy).toEqual(bob);
  });

  it("continues, executes the Tool exactly once, and completes", () => {
    const { approved } = outcome;
    expect(approved.completed).toMatchObject({ ok: true, status: "COMPLETED", revision: 1, nodes: { approve: "SUCCEEDED", draft: "SUCCEEDED", final: "SUCCEEDED" } });
    expect(approved.output).toMatchObject({ schemaVersion: 1, toolRef: { id: "crm.draft-update", version: "1.0.0" }, output: { draftId: "draft-acme" } });
    expect(approved.draftCalls).toBe(1);
  });

  it("rejection fails the Run canonically and the Tool is never called", () => {
    expect(outcome.rejected).toEqual({ result: expect.objectContaining({ ok: false, status: "FAILED", failure: "APPROVAL_REJECTED", nodes: { approve: "FAILED", draft: "PENDING", final: "PENDING" } }), draftCalls: 0 });
  });

  it("a principal without the Tool's permission is denied by canonical Authorization: zero handler calls", () => {
    expect(outcome.denied).toEqual({ result: expect.objectContaining({ ok: false, status: "FAILED", failure: "NODE_EXECUTION_FAILED", executorFailure: "TOOL_AUTHORIZATION_DENIED" }), draftCalls: 0 });
  });

  it("an external_side_effect Tool stays unsupported even when the principal holds the grant: zero handler calls", () => {
    expect(outcome.unsupported.emailCalls).toBe(0);
    expect(outcome.unsupported.result).toMatchObject({ ok: false, failure: "RUNTIME_PREFLIGHT_FAILED", status: "FAILED" });
    expect(JSON.stringify(outcome.unsupported.result.details)).toContain("TOOL_PERMISSION_UNSUPPORTED");
  });
});
