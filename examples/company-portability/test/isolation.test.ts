import { describe, expect, it } from "vitest";
import { createCompanyAAO, CompanyAdmissionError } from "../src/index.js";
import {
  createTestHostEnvironment,
  NORTHSTAR_MANIFEST,
  ARBOR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
  createCompanyApprovalVerifier,
} from "../fixtures/index.js";

describe("Sprint 25 — Pre-Execution Company Admission & Cross-Company Isolation Tests", () => {
  it("enforces pre-execution admission: foreign principal is rejected before planning model executes", async () => {
    // Arbor host resolves Company A (Northstar) principal for all runs
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst, // Registered in Northstar, unknown in Arbor
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const validRequest = {
      company: { name: "Arbor Consulting", domain: "arbor.example" },
      questions: [{ id: "offering", question: "What does Arbor offer?" }],
    };

    // 1. Calling via company convenience method throws COMPANY_ADMISSION_DENIED
    let thrownError: unknown;
    try {
      await arbor.runCompanyResearch({
        runId: "run.arb.unauthorized.foreign",
        request: validRequest,
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(CompanyAdmissionError);
    const admissionError = thrownError as CompanyAdmissionError;
    expect(admissionError.code).toBe("COMPANY_ADMISSION_DENIED");
    expect(admissionError.companyId).toBe("arbor-consulting");
    expect(admissionError.proof).toBe("company_research");
    expect(admissionError.runId).toBe("run.arb.unauthorized.foreign");
    expect(["GOVERNANCE_DEFAULT_DENY", "GOVERNANCE_INVALID_CONTEXT"]).toContain(
      admissionError.reasonCode
    );

    // CRITICAL INVARIANT: Zero model calls, zero provider calls, zero drafts before admission
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
    expect(env.arborWebProvider.calls.fetch.length).toBe(0);
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);

    // 2. Calling via guarded proof getter facade ALSO enforces admission and throws
    let getterError: unknown;
    try {
      await arbor.getCompanyResearchProof().run({
        runId: "run.arb.getter.unauthorized",
        request: validRequest,
      });
    } catch (err) {
      getterError = err;
    }

    expect(getterError).toBeInstanceOf(CompanyAdmissionError);
    expect((getterError as CompanyAdmissionError).code).toBe("COMPANY_ADMISSION_DENIED");
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
  });

  it("enforces pre-execution admission: registered but unauthorized principal is rejected with 0 calls", async () => {
    // Create an Arbor manifest with an actor having no role grant for read_only
    const guestActor = { id: "user.arbor.guest", type: "user" as const };
    const guestRole = {
      id: "consulting.guest",
      version: "1.0.0",
      description: "Guest with write_draft only, lacking read_only",
      permissionClasses: ["write_draft" as const],
    };
    const manifestWithGuest = {
      ...ARBOR_MANIFEST,
      governance: {
        ...ARBOR_MANIFEST.governance,
        actors: [...ARBOR_MANIFEST.governance.actors, guestActor],
        roles: [...ARBOR_MANIFEST.governance.roles, guestRole],
        bindings: [
          ...ARBOR_MANIFEST.governance.bindings,
          {
            id: "rb.arbor.guest",
            actorId: guestActor.id,
            roleId: guestRole.id,
            status: "active" as const,
          },
        ],
      },
    };

    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => guestActor,
    });

    const arbor = createCompanyAAO({
      manifest: manifestWithGuest,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    let thrown: unknown;
    try {
      await arbor.runCompanyResearch({
        runId: "run.arb.guest.unauthorized",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "offering", question: "What does Arbor offer?" }],
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CompanyAdmissionError);
    expect((thrown as CompanyAdmissionError).code).toBe("COMPANY_ADMISSION_DENIED");
    expect((thrown as CompanyAdmissionError).reasonCode).toBe("GOVERNANCE_DEFAULT_DENY");

    // Zero model calls and provider calls
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
  });

  it("enforces pre-execution admission: deny policy overrides role grant before model runs", async () => {
    // Add a deny policy revoking read_only for researchers
    const manifestWithDeny = {
      ...ARBOR_MANIFEST,
      governance: {
        ...ARBOR_MANIFEST.governance,
        policies: [
          {
            id: "policy.arbor.deny_all_reads",
            rules: [
              {
                id: "rule.deny_read_only",
                effect: "DENY" as const,
                permissionClasses: ["read_only" as const],
                roleIds: ["consulting.researcher"],
              },
            ],
          },
        ],
      },
    };

    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => ARBOR_ACTORS.researcher,
    });

    const arbor = createCompanyAAO({
      manifest: manifestWithDeny,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    let thrown: unknown;
    try {
      await arbor.runCompanyResearch({
        runId: "run.arb.policy.denied",
        request: {
          company: { name: "Arbor Consulting", domain: "arbor.example" },
          questions: [{ id: "offering", question: "What does Arbor offer?" }],
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CompanyAdmissionError);
    expect((thrown as CompanyAdmissionError).code).toBe("COMPANY_ADMISSION_DENIED");
    expect((thrown as CompanyAdmissionError).reasonCode).toBe("GOVERNANCE_POLICY_DENY");

    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborWebProvider.calls.search.length).toBe(0);
  });

  it("positive authorization control: authorized Arbor principal completes the exact same research request", async () => {
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => ARBOR_ACTORS.researcher,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const outcome = await arbor.runCompanyResearch({
      runId: "run.arb.authorized.control",
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What does Arbor offer?" }],
      },
    });

    expect(outcome.status).toBe("completed");
    if (outcome.status === "completed") {
      expect(outcome.result.coverage.questionsAnswered).toBe(1);
      expect(outcome.result.coverage.sourcesCited).toBeGreaterThan(0);
      expect(outcome.result.markdown).toContain("Arbor Consulting");
    }

    // Model and providers were invoked normally for authorized run
    expect(env.getArborProviderCalls()).toBeGreaterThan(0);
    expect(env.arborWebProvider.calls.search.length).toBeGreaterThan(0);
  });

  it("enforces Document Intelligence admission: unauthorized principal causes 0 model calls and 0 provider reads", async () => {
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    let thrownConvenience: unknown;
    try {
      await arbor.runDocumentIntelligence({
        runId: "run.arb.doc.unauth",
        request: {
          documentRef: OVERLAPPING_DOC_REF,
          questions: [{ id: "terms", question: "What are the fees?" }],
        },
      });
    } catch (err) {
      thrownConvenience = err;
    }
    expect(thrownConvenience).toBeInstanceOf(CompanyAdmissionError);

    let thrownGetter: unknown;
    try {
      await arbor.getDocumentIntelligenceProof().run({
        runId: "run.arb.doc.unauth.getter",
        request: {
          documentRef: OVERLAPPING_DOC_REF,
          questions: [{ id: "terms", question: "What are the fees?" }],
        },
      });
    } catch (err) {
      thrownGetter = err;
    }
    expect(thrownGetter).toBeInstanceOf(CompanyAdmissionError);

    // Assert zero calls
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborDocProvider.calls.length).toBe(0);

    // Authorized control succeeds
    const authEnv = createTestHostEnvironment({
      arborPrincipalOverride: () => ARBOR_ACTORS.researcher,
    });
    const authArbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: authEnv.hostCapabilities,
      principalForRun: authEnv.arborPrincipalForRun,
    });
    const authOutcome = await authArbor.runDocumentIntelligence({
      runId: "run.arb.doc.auth",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the fees?" }],
      },
    });
    expect(authOutcome.status).toBe("completed");
    expect(authEnv.getArborProviderCalls()).toBeGreaterThan(0);
    expect(authEnv.arborDocProvider.calls.length).toBe(1);
  });

  it("enforces Operational Request admission: unauthorized requester causes 0 model calls, 0 approval records, and 0 drafts", async () => {
    const env = createTestHostEnvironment({
      arborPrincipalOverride: () => NORTHSTAR_ACTORS.analyst, // Foreign principal lacking write_draft in Arbor
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    let thrownConvenience: unknown;
    try {
      await arbor.executeOperationalRequest({
        runId: "run.arb.ops.unauth",
        request: ARBOR_OPERATIONAL_REQUEST,
      });
    } catch (err) {
      thrownConvenience = err;
    }
    expect(thrownConvenience).toBeInstanceOf(CompanyAdmissionError);

    let thrownGetter: unknown;
    try {
      await arbor.getOperationalRequestProof().execute({
        runId: "run.arb.ops.unauth.getter",
        request: ARBOR_OPERATIONAL_REQUEST,
      });
    } catch (err) {
      thrownGetter = err;
    }
    expect(thrownGetter).toBeInstanceOf(CompanyAdmissionError);

    // Assert zero side effects
    expect(env.getArborProviderCalls()).toBe(0);
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);
    expect(arbor.getOperationalRequestProof().approvals.get("any-id")).toBeUndefined();
  });

  it("preserves canonical Approval Engine: approver without write_draft can approve when eligible", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    // Requester has write_draft and enters Operational Request
    const nsExec = await northstar.executeOperationalRequest({
      runId: "run.ns.ops.approver-check",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(nsExec.ok).toBe(true);
    if (!nsExec.ok) return;
    expect(nsExec.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const wait = nsExec.execution.wait!;
    const approvalRef = wait.referenceId;

    // Manager actor has read_only, NOT write_draft
    expect(NORTHSTAR_ACTORS.manager.id).toBe("user.northstar.manager");
    const managerRole = NORTHSTAR_MANIFEST.governance.roles.find(
      (r) => r.id === "operations.approver"
    );
    expect(managerRole?.permissionClasses).toEqual(["read_only"]);

    // The manager can approve because Approval eligibility is role-based, not write_draft-based
    const approvalRec = await northstar
      .getOperationalRequestProof()
      .approvals.approve(approvalRef, NORTHSTAR_ACTORS.manager);
    expect(approvalRec.status).toBe("approved");

    // Continuing with requester principal succeeds
    const continued = await northstar.continueOperationalRequest(nsExec.execution);
    expect(continued.ok).toBe(true);
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(1);
  });

  it("enforces guarded facades: raw app and approvalVerifier are not exposed on company proof getter", () => {
    const env = createTestHostEnvironment();
    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const opsProof = arbor.getOperationalRequestProof();

    // Guarded facade exposes safe inspection and admission-guarded execution
    expect(typeof opsProof.planFingerprint).toBe("string");
    expect(typeof opsProof.workflow).toBe("object");
    expect(typeof opsProof.execute).toBe("function");
    expect(typeof opsProof.continue).toBe("function");
    expect(typeof opsProof.approvals).toBe("object");

    // Intentionally removed implementation surfaces that could bypass admission
    const rawInspection = opsProof as unknown as Record<string, unknown>;
    expect(rawInspection.app).toBeUndefined();
    expect(rawInspection.approvalVerifier).toBeUndefined();
    expect(rawInspection.draftRepository).toBeUndefined();
  });

  it("enforces Approval isolation: Company A approval cannot authorize draft execution in Company B", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // 1. Run Northstar Operational Request until human approval waitpoint
    const nsExec = await northstar.executeOperationalRequest({
      runId: "run.ns.ops.001",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });

    expect(nsExec.ok).toBe(true);
    if (!nsExec.ok) return;
    expect(nsExec.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const nsProof = northstar.getOperationalRequestProof();
    const wait = nsExec.execution.wait!;
    const approvalRef = wait.referenceId;
    expect(approvalRef).toBeDefined();

    // Northstar manager approves Northstar run
    await nsProof.approvals.approve(approvalRef, NORTHSTAR_ACTORS.manager);

    // 2. Run Arbor Operational Request until human approval waitpoint
    const arbExec = await arbor.executeOperationalRequest({
      runId: "run.arb.ops.001",
      request: ARBOR_OPERATIONAL_REQUEST,
    });

    expect(arbExec.ok).toBe(true);
    if (!arbExec.ok) return;
    expect(arbExec.execution.run.status).toBe("WAITING_FOR_APPROVAL");

    const arbProof = arbor.getOperationalRequestProof();

    // 3. Attempt to verify Northstar's approval ID in Arbor's approval verifier
    const arborApprovalVerifier = createCompanyApprovalVerifier(arbProof.approvals);
    const verification = await arborApprovalVerifier.verifyApproval({
      approvalId: approvalRef,
      requestFingerprint: "tampered-or-real-fingerprint",
      toolExecutionId: "exec.isolation.1",
      runId: "run.arb.ops.001",
      draftPayload: {
        requestId: ARBOR_OPERATIONAL_REQUEST.requestId,
        operation: "account.update_display_name",
        accountId: ARBOR_OPERATIONAL_REQUEST.accountContext.accountId,
        proposedChanges: { displayName: "Arbor Strategic Partners" },
      },
    });

    // Mandatory Negative Test: Approval Verification Fails
    expect(verification.ok).toBe(false);
    if (!verification.ok) {
      expect(["APPROVAL_NOT_FOUND", "APPROVAL_VERIFICATION_FAILED"]).toContain(verification.code);
    }

    // 0 drafts created in Arbor's repository
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);
  });

  it("enforces Draft repository isolation: drafts are stored strictly in the company-configured repository", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Execute Northstar approved draft
    const nsExec = await northstar.executeOperationalRequest({
      runId: "run.ns.ops.draft-iso",
      request: NORTHSTAR_OPERATIONAL_REQUEST,
    });
    if (!nsExec.ok) return;
    const nsWait = nsExec.execution.wait!;
    await northstar.getOperationalRequestProof().approvals.approve(
      nsWait.referenceId,
      NORTHSTAR_ACTORS.manager
    );
    const nsCont = await northstar.continueOperationalRequest(nsExec.execution);
    expect(nsCont.ok).toBe(true);

    // Northstar has 1 draft
    const nsDrafts = env.northstarDraftRepo.getAllDrafts();
    expect(nsDrafts.length).toBe(1);
    const nsDraftId = nsDrafts[0]!.draftId;

    // Arbor cannot see Northstar's draft
    expect(env.arborDraftRepo.getDraft(nsDraftId)).toBeUndefined();
    expect(env.arborDraftRepo.getAllDrafts().length).toBe(0);

    // Execute Arbor approved draft
    const arbExec = await arbor.executeOperationalRequest({
      runId: "run.arb.ops.draft-iso",
      request: ARBOR_OPERATIONAL_REQUEST,
    });
    if (!arbExec.ok) return;
    const arbWait = arbExec.execution.wait!;
    await arbor.getOperationalRequestProof().approvals.approve(
      arbWait.referenceId,
      ARBOR_ACTORS.manager
    );
    const arbCont = await arbor.continueOperationalRequest(arbExec.execution);
    expect(arbCont.ok).toBe(true);

    // Arbor has 1 draft
    const arbDrafts = env.arborDraftRepo.getAllDrafts();
    expect(arbDrafts.length).toBe(1);
    const arbDraftId = arbDrafts[0]!.draftId;

    // Northstar cannot see Arbor's draft
    expect(env.northstarDraftRepo.getDraft(arbDraftId)).toBeUndefined();
    expect(env.northstarDraftRepo.getAllDrafts().length).toBe(1);
  });

  it("enforces Document isolation: overlapping opaque references resolve strictly to company provider", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    // Both companies query the exact same document reference: "fixture.contract-001"
    const nsOutcome = await northstar.runDocumentIntelligence({
      runId: "run.ns.doc.iso",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the payment terms?" }],
      },
    });

    const arbOutcome = await arbor.runDocumentIntelligence({
      runId: "run.arb.doc.iso",
      request: {
        documentRef: OVERLAPPING_DOC_REF,
        questions: [{ id: "terms", question: "What are the consulting fees?" }],
      },
    });

    expect(nsOutcome.status).toBe("completed");
    expect(arbOutcome.status).toBe("completed");

    if (nsOutcome.status === "completed" && arbOutcome.status === "completed") {
      // Different document fingerprints and document IDs
      expect(nsOutcome.result.document.documentId).not.toBe(arbOutcome.result.document.documentId);
      expect(nsOutcome.result.document.documentFingerprint).not.toBe(
        arbOutcome.result.document.documentFingerprint
      );

      // Northstar content discusses supplier terms
      expect(nsOutcome.result.markdown).toContain("Supplier terms");
      expect(nsOutcome.result.markdown).not.toContain("Consulting terms");

      // Arbor content discusses consulting fees
      expect(arbOutcome.result.markdown).toContain("Consulting terms");
      expect(arbOutcome.result.markdown).not.toContain("Supplier terms");
    }

    // Provider call counts: exactly 1 for each respective provider
    expect(env.northstarDocProvider.calls.length).toBe(1);
    expect(env.arborDocProvider.calls.length).toBe(1);
  });

  it("enforces cross-company identity collision resistance: literal same runId maintains strict company isolation", async () => {
    const env = createTestHostEnvironment();

    const northstar = createCompanyAAO({
      manifest: NORTHSTAR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.northstarPrincipalForRun,
    });

    const arbor = createCompanyAAO({
      manifest: ARBOR_MANIFEST,
      hostCapabilities: env.hostCapabilities,
      principalForRun: env.arborPrincipalForRun,
    });

    const sharedRunId = "run.literal.collision.001";

    const nsRes = await northstar.runCompanyResearch({
      runId: sharedRunId,
      request: {
        company: { name: "Northstar Commerce", domain: "northstar.example" },
        questions: [{ id: "offering", question: "What does Northstar offer?" }],
      },
    });

    const arbRes = await arbor.runCompanyResearch({
      runId: sharedRunId,
      request: {
        company: { name: "Arbor Consulting", domain: "arbor.example" },
        questions: [{ id: "offering", question: "What does Arbor offer?" }],
      },
    });

    expect(nsRes.status).toBe("completed");
    expect(arbRes.status).toBe("completed");

    // Northstar used Northstar provider; Arbor used Arbor provider
    expect(env.northstarWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(env.arborWebProvider.calls.search.length).toBeGreaterThan(0);
    expect(
      env.northstarWebProvider.calls.search.every((q) => q.toLowerCase().includes("northstar"))
    ).toBe(true);
    expect(
      env.arborWebProvider.calls.search.every((q) => q.toLowerCase().includes("arbor"))
    ).toBe(true);
  });
});
