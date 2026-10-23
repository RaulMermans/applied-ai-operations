import { describe, expect, it } from "vitest";
import {
  createCompanyAAO,
  CompanyAdmissionError,
} from "@aao/example-company-portability";
import {
  CapabilityPackError,
} from "@aao/capability-packs";
import {
  createStandardPackCatalog,
  resolveCompanyCapabilityPacks,
  type CompanyResearchFacade,
  type OperationalRequestFacade,
} from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  NORTHSTAR_PACK_SELECTION,
  ARBOR_PACK_SELECTION,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "../fixtures/index.js";

describe("Sprint 26 — Capability Pack Security & Boundary Enforcement", () => {
  it("enforces pre-execution company admission: foreign principal is denied before any model or tool invocation", async () => {
    const env = createTestHostEnvironment({
      // Configure host to return Northstar analyst when running in Arbor AAO
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
    });
    const catalog = createStandardPackCatalog();

    const arborAAO = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const arborPacks = resolveCompanyCapabilityPacks({
      company: arborAAO,
      catalog,
      selection: ARBOR_PACK_SELECTION,
    });

    const arborResearchPack = arborPacks.getPack<CompanyResearchFacade>("aao.company-research@1.0.0");

    const initialCalls = env.getArborProviderCalls();

    await expect(
      arborResearchPack.facade.run({
        runId: "run.arb.unauthorized",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "q1", question: "What does it offer?" }],
        },
      })
    ).rejects.toThrow(CompanyAdmissionError);

    // Verify 0 provider calls, 0 tool calls
    expect(env.getArborProviderCalls()).toBe(initialCalls);
  });

  it("fails fast with PACK_PROOF_DISABLED if a company attempts to activate a disabled proof pack", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    // Company with ONLY document_intelligence enabled
    const restrictedManifest = {
      ...ARBOR_MANIFEST,
      enabledProofs: ["document_intelligence"] as const,
    };

    const restrictedAAO = createCompanyAAO({
      manifest: restrictedManifest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Attempting to select company-research pack
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: restrictedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: restrictedManifest.companyId,
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(CapabilityPackError);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: restrictedAAO,
        catalog,
        selection: {
          schemaVersion: 1,
          companyId: restrictedManifest.companyId,
          packRefs: [{ id: "aao.company-research", version: "1.0.0" }],
        },
      })
    ).toThrow(/PACK_PROOF_DISABLED/);
  });

  it("fails fast with PACK_SCOPE_MISMATCH if pack selection companyId does not match composed company", () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Selection has companyId "arbor-consulting" but composed company is "northstar-commerce"
    expect(() =>
      resolveCompanyCapabilityPacks({
        company: northstarAAO,
        catalog,
        selection: ARBOR_PACK_SELECTION,
      })
    ).toThrow(CapabilityPackError);

    expect(() =>
      resolveCompanyCapabilityPacks({
        company: northstarAAO,
        catalog,
        selection: ARBOR_PACK_SELECTION,
      })
    ).toThrow(/PACK_SCOPE_MISMATCH/);
  });

  it("enforces approval isolation: Northstar approver cannot approve Arbor approval waitpoint", async () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const arborAAO = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const arborPacks = resolveCompanyCapabilityPacks({
      company: arborAAO,
      catalog,
      selection: ARBOR_PACK_SELECTION,
    });

    const arbOpsPack = arborPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const arbOpsInit = await arbOpsPack.facade.execute({
      runId: "run.arb.isolation.ops",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbOpsInit.ok).toBe(true);
    if (!arbOpsInit.ok) return;

    const arbWaitRef = arbOpsInit.execution.wait?.referenceId as string;

    // Northstar manager attempts to approve Arbor waitpoint
    expect(() =>
      arbOpsPack.facade.approvals.approve(arbWaitRef, NORTHSTAR_ACTORS.manager)
    ).toThrow(/APPROVAL_RESOLVER_NOT_ELIGIBLE/);
  });

  it("handles human rejection: when human approver rejects, 0 drafts are persisted", async () => {
    const env = createTestHostEnvironment();
    const catalog = createStandardPackCatalog();

    const northstarAAO = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const northstarPacks = resolveCompanyCapabilityPacks({
      company: northstarAAO,
      catalog,
      selection: NORTHSTAR_PACK_SELECTION,
    });

    const nsOpsPack = northstarPacks.getPack<OperationalRequestFacade>("aao.operational-request@1.0.0");
    const initResult = await nsOpsPack.facade.execute({
      runId: "run.ns.rejection.ops",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(initResult.ok).toBe(true);
    if (!initResult.ok) return;
    expect(initResult.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const initialDraftCount = env.northstarDraftRepo.getAllDrafts().length;

    // Human manager deliberately rejects
    const waitRef = initResult.execution.wait?.referenceId as string;
    const rejectedRecord = nsOpsPack.facade.approvals.reject(waitRef, NORTHSTAR_ACTORS.manager);
    expect(rejectedRecord.status).toBe("rejected");

    const continuation = await nsOpsPack.facade.continue(initResult.execution);
    // Because approval was rejected, continuation fails closed with FAILED status and zero drafts persisted
    expect(continuation.ok).toBe(false);
    expect(continuation.execution?.run.status).toBe("FAILED");
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(initialDraftCount);
  });
});
