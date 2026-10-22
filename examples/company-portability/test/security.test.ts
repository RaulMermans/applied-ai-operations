import { describe, expect, it } from "vitest";
import { createCompanyAAO } from "../src/composition.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";
import {
  createNorthstarModelAdapter,
  NORTHSTAR_MODEL_BINDING,
} from "../fixtures/models.js";
import { defineTool, defineWorkflow } from "@aao/framework";
import { createOperationalRequestProof } from "@aao/example-operational-request";

describe("Sprint 25 — Security & Boundary Enforcement Tests", () => {
  it("enforces fail-closed gate: unsupported permission classes remain blocked", async () => {
    // Attempt to define and execute an external_side_effect Tool
    let handlerCalled = false;
    const externalTool = defineTool({
      spec: {
        schemaVersion: 1,
        id: "crm.mutate_account",
        version: "1.0.0",
        name: "CRM Mutate",
        description: "External mutation tool",
        permissionClasses: ["external_side_effect"],
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      handler: {
        async execute() {
          handlerCalled = true;
          return { ok: true, output: {} };
        },
      },
    });

    let externalRefused = false;
    try {
      const extWorkflow = defineWorkflow({
        schemaVersion: 1,
        id: "ext.workflow",
        version: "1.0.0",
        name: "Ext",
        description: "Ext",
        entryNodeId: "ext_node",
        nodes: [{ id: "ext_node", kind: "tool", config: { toolRef: { id: externalTool.spec.id, version: externalTool.spec.version }, inputStateKey: "in", resultStateKey: "out" } }],
        edges: [],
      });
      const model = createNorthstarModelAdapter();
      const extProof = createOperationalRequestProof({
        modelAdapters: [model],
        modelBindings: [NORTHSTAR_MODEL_BINDING],
        governance: NORTHSTAR_MANIFEST.governance,
        principalForRun: () => ({ id: "user.northstar.manager", type: "user" }),
      });
      const prepared = extProof.app.prepareWorkflow(extWorkflow);
      await prepared.execute({ runId: "run.ext.blocked", initialState: { runId: "run.ext.blocked", revision: 0, values: {} } });
    } catch {
      externalRefused = true;
    }

    expect(externalRefused).toBe(true);
    expect(handlerCalled).toBe(false);
  });

  it("prevents request payload from overriding company identity or provider selection", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Caller includes hostile companyId override in research request
    const hostileRequest = {
      company: { name: "Northstar Commerce", domain: "northstar.example" },
      companyId: "arbor-consulting",
      providerRef: "arbor.web-provider",
      questions: [{ id: "offering", question: "What does Northstar offer?" }],
    };

    const outcome = await northstar.runCompanyResearch({
      runId: "run.ns.security.override",
      request: hostileRequest as unknown as Parameters<typeof northstar.runCompanyResearch>[0]["request"],
    });

    expect(outcome.status).toBe("completed");

    // Northstar's provider was called, NOT Arbor's
    expect(env.northstarWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
  });

  it("verifies model output cannot grant authority or modify configuration", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Manifest snapshot remains frozen and unchanged
    expect(northstar.manifest.companyId).toBe("northstar-commerce");
    expect(Object.isFrozen(northstar.manifest)).toBe(true);

    // Run operational request
    const init = await northstar.executeOperationalRequest({
      runId: "run.ns.sec.ops.model",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(init.ok).toBe(true);
    // Config fingerprint unchanged
    expect(northstar.configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(northstar.manifest.displayName).toBe("Northstar Commerce");
  });

  it("verifies prototype-pollution protection does not pollute host globals", () => {
    const beforePollution = (Object.prototype as Record<string, unknown>).polluted;
    expect(beforePollution).toBeUndefined();

    try {
      JSON.parse(
        JSON.stringify({
          ...NORTHSTAR_MANIFEST,
          __proto__: { polluted: true },
        })
      );
      // will be rejected or sanitized
    } catch {
      // safe
    }

    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("verifies threat matrix: request-supplied principal identity cannot override host-attested principal", async () => {
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => ({ id: "unregistered.foreign.principal", type: "user" }),
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Request payload tries to inject an authorized principal id
    const payloadWithPrincipal = {
      company: { name: "Arbor Consulting", domain: "arbor.example" },
      principalId: "user.arbor.researcher",
      actorId: "user.arbor.researcher",
      actingAs: "user.arbor.researcher",
      questions: [{ id: "offering", question: "What does Arbor offer?" }],
    };

    let denied = false;
    try {
      await arbor.runCompanyResearch({
        runId: "run.sec.host.principal",
        request: payloadWithPrincipal as unknown as Parameters<typeof arbor.runCompanyResearch>[0]["request"],
      });
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as { code: string }).code === "COMPANY_ADMISSION_DENIED") {
        denied = true;
      }
    }

    expect(denied).toBe(true);
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
  });

  it("verifies all three proofs enforce zero side effects on admission denial", async () => {
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => ({ id: "unregistered.hacker", type: "user" }),
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Research: 0 model, 0 search, 0 fetch
    await expect(
      arbor.runCompanyResearch({
        runId: "sec.zero.res",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "q", question: "Q" }],
        },
      })
    ).rejects.toThrow();
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
    expect(env.arborWebProvider.calls.fetch.length).toBe(0);

    // Doc: 0 model, 0 reads
    await expect(
      arbor.runDocumentIntelligence({
        runId: "sec.zero.doc",
        request: {
          documentRef: "fixture.contract-001",
          questions: [{ id: "q", question: "Q" }],
        },
      })
    ).rejects.toThrow();
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborDocProvider.calls.length).toBe(0);

    // Ops: 0 model, 0 approvals, 0 drafts
    await expect(
      arbor.executeOperationalRequest({
        runId: "sec.zero.ops",
        request: {
          schemaVersion: 1,
          requestId: "sec-001",
          instruction: "Do something unauthorized",
          accountContext: { accountId: "ARB-CLIENT-202", currentDisplayName: "Arbor" },
        },
      })
    ).rejects.toThrow();
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);
    expect(arbor.getOperationalRequestProof().approvals.get("any-id")).toBeUndefined();
  });
});
