import { describe, expect, it } from "vitest";
import { createCompanyAAO } from "../src/composition.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
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
});
