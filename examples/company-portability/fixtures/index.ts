import {
  createHostCapabilityCatalog,
  type HostCapabilityCatalog,
} from "../src/catalog.js";
import {
  NORTHSTAR_MANIFEST,
  NORTHSTAR_ACTORS,
} from "../src/profiles/northstar-commerce.js";
import {
  ARBOR_MANIFEST,
  ARBOR_ACTORS,
} from "../src/profiles/arbor-consulting.js";
import {
  createNorthstarWebProvider,
  createArborWebProvider,
  type FixtureWebProvider,
} from "./public-web.js";
import {
  createNorthstarDocumentProvider,
  createArborDocumentProvider,
  OVERLAPPING_DOC_REF,
  type FixtureDocumentSourceProvider,
} from "./documents.js";
import {
  createNorthstarDraftRepository,
  createArborDraftRepository,
  createCompanyApprovalVerifier,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
} from "./operations.js";
import {
  createNorthstarModelAdapter,
  createArborModelAdapter,
  NORTHSTAR_MODEL_BINDING,
  ARBOR_MODEL_BINDING,
} from "./models.js";
import type { Principal, PrincipalForRun } from "@aao/framework";
import type { OperationalDraftRepository } from "@aao/example-operational-request";

export {
  NORTHSTAR_MANIFEST,
  NORTHSTAR_ACTORS,
  ARBOR_MANIFEST,
  ARBOR_ACTORS,
  OVERLAPPING_DOC_REF,
  NORTHSTAR_OPERATIONAL_REQUEST,
  ARBOR_OPERATIONAL_REQUEST,
  createCompanyApprovalVerifier,
  createNorthstarModelAdapter,
  NORTHSTAR_MODEL_BINDING,
};

export interface TestHostEnvironment {
  readonly hostCapabilities: HostCapabilityCatalog;
  readonly northstarWebProvider: FixtureWebProvider;
  readonly arborWebProvider: FixtureWebProvider;
  readonly northstarDocProvider: FixtureDocumentSourceProvider;
  readonly arborDocProvider: FixtureDocumentSourceProvider;
  readonly northstarDraftRepo: OperationalDraftRepository;
  readonly arborDraftRepo: OperationalDraftRepository;
  readonly northstarPrincipalForRun: PrincipalForRun;
  readonly arborPrincipalForRun: PrincipalForRun;
  readonly getArborProviderCalls: () => number;
  readonly getNorthstarProviderCalls: () => number;
}

export interface TestHostOptions {
  northstarPrincipalOverride?: (runId: string) => Principal;
  arborPrincipalOverride?: (runId: string) => Principal;
}

/**
 * Creates an isolated test host environment with independent capability providers
 * for both Northstar Commerce and Arbor Consulting.
 */
export function createTestHostEnvironment(options: TestHostOptions = {}): TestHostEnvironment {
  const northstarWebProvider = createNorthstarWebProvider();
  const arborWebProvider = createArborWebProvider();
  const northstarDocProvider = createNorthstarDocumentProvider();
  const arborDocProvider = createArborDocumentProvider();
  const northstarDraftRepo = createNorthstarDraftRepository();
  const arborDraftRepo = createArborDraftRepository();

  const northstarModelRequests: unknown[] = [];
  const northstarModelAdapterDef = createNorthstarModelAdapter(northstarModelRequests as never[]);
  const arborModel = createArborModelAdapter();

  const hostCapabilities = createHostCapabilityCatalog({
    modelAdapters: {
      [northstarModelAdapterDef.manifest.id]: northstarModelAdapterDef,
      [arborModel.definition.manifest.id]: arborModel.definition,
    },
    modelBindings: {
      [NORTHSTAR_MODEL_BINDING.id]: NORTHSTAR_MODEL_BINDING,
      [ARBOR_MODEL_BINDING.id]: ARBOR_MODEL_BINDING,
    },
    publicWebProviders: {
      "northstar.web-provider": northstarWebProvider,
      "arbor.web-provider": arborWebProvider,
    },
    documentSourceProviders: {
      "northstar.doc-provider": northstarDocProvider,
      "arbor.doc-provider": arborDocProvider,
    },
    draftRepositories: {
      "northstar.draft-repository": northstarDraftRepo,
      "arbor.draft-repository": arborDraftRepo,
    },
  });

  // shortcut: demo-only identity convention (Run ID text picks the actor); hardened hosts use trustedIdentity (ADR-034).
  const northstarPrincipalForRun: PrincipalForRun = ({ runId }) => {
    if (options.northstarPrincipalOverride) {
      return options.northstarPrincipalOverride(runId);
    }
    if (runId.includes("ops")) {
      return NORTHSTAR_ACTORS.requester;
    }
    return NORTHSTAR_ACTORS.analyst;
  };

  const arborPrincipalForRun: PrincipalForRun = ({ runId }) => {
    if (options.arborPrincipalOverride) {
      return options.arborPrincipalOverride(runId);
    }
    if (runId.includes("ops")) {
      return ARBOR_ACTORS.requester;
    }
    return ARBOR_ACTORS.researcher;
  };

  return {
    hostCapabilities,
    northstarWebProvider,
    arborWebProvider,
    northstarDocProvider,
    arborDocProvider,
    northstarDraftRepo,
    arborDraftRepo,
    northstarPrincipalForRun,
    arborPrincipalForRun,
    getArborProviderCalls: arborModel.providerCalls,
    getNorthstarProviderCalls: () => northstarModelRequests.length,
  };
}
