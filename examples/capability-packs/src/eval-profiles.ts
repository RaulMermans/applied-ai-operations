import {
  CapabilityPackError,
  ExactEvalProfileRefSchema,
  deepFreeze,
} from "@aao/capability-packs";
import {
  createEvaluatorRegistry,
  deterministicGraders,
  runEvalDataset,
  type EvalEvidenceBundle,
  type EvaluatorRegistry,
} from "@aao/evaluation";
import {
  EvalDatasetSchema,
  EvalDefinitionSchema,
  type EvalCase,
  type EvalCategory,
  type EvalDataset,
  type EvalDatasetRun,
  type EvalDefinition,
  type EvalMode,
  type EvalTargetType,
} from "@aao/contracts";
import type { JsonValue } from "@aao/framework";

export const EVAL_PROFILES = Object.freeze({
  companyResearch: "aao.company-research.evals@1.0.0",
  documentIntelligence: "aao.document-intelligence.evals@1.0.0",
  operationalRequest: "aao.operational-request.evals@1.0.0",
} as const);

const g = (id: string, version = "1.0.0") => ({ id, version });
const OUTCOME = g("aao.run-outcome");
const TRAJECTORY = g("aao.trajectory");
const TOOL_USAGE = g("aao.tool-usage");
const MODEL = g("aao.model-call");
const TRACE = g("aao.trace-contract");
const APPROVAL_COMPLIANCE = g("aao.approval-compliance", "2.0.0");

function createEvalDef(
  id: string,
  graderRef: { id: string; version: string },
  targetType: EvalTargetType,
  categories: EvalCategory[],
  config: Record<string, JsonValue>
): EvalDefinition {
  return {
    schemaVersion: 2,
    id: `pack-eval.${id}`,
    version: "1.0.0",
    name: id,
    categories,
    supportedModes: ["RUNTIME"],
    targetType,
    graderRef,
    config,
  };
}

export interface PackEvalDatasetPackage {
  readonly dataset: EvalDataset;
  readonly definitions: readonly EvalDefinition[];
}

/**
 * Builds the canonical evaluation dataset and definitions for a given Capability Pack evaluation profile.
 */
export function buildPackEvalDataset(profileRef: string, evidenceKey: string): PackEvalDatasetPackage {
  const definitions: EvalDefinition[] = [];
  const cases: EvalCase[] = [];

  switch (profileRef) {
    case EVAL_PROFILES.companyResearch: {
      const outcomeDef = createEvalDef("cr-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const trajectoryDef = createEvalDef("cr-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
        forbiddenEvents: [{ type: "tool.call.blocked" }],
      });
      const toolDef = createEvalDef("cr-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [
          { id: "public_web.search", version: "1.0.0" },
          { id: "records.dedupe", version: "1.0.0" },
          { id: "public_web.fetch_pages", version: "1.0.0" },
          { id: "records.project", version: "1.0.0" },
        ],
      });
      const modelDef = createEvalDef("cr-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 2, max: 2 },
      });
      const traceDef = createEvalDef("cr-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, trajectoryDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "cr-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-trajectory-case", evalRef: { id: trajectoryDef.id, version: trajectoryDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "cr-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    case EVAL_PROFILES.documentIntelligence: {
      const outcomeDef = createEvalDef("di-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const trajectoryDef = createEvalDef("di-trajectory", TRAJECTORY, "trajectory", ["trajectory"], {
        forbiddenEvents: [{ type: "tool.call.blocked" }],
      });
      const toolDef = createEvalDef("di-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [{ id: "document.extract_text", version: "1.0.0" }],
      });
      const modelDef = createEvalDef("di-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 1, max: 1 },
      });
      const traceDef = createEvalDef("di-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, trajectoryDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "di-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-trajectory-case", evalRef: { id: trajectoryDef.id, version: trajectoryDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "di-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    case EVAL_PROFILES.operationalRequest: {
      const outcomeDef = createEvalDef("or-outcome", OUTCOME, "run", ["capability"], {
        expectedStatus: "COMPLETED",
      });
      const approvalDef = createEvalDef("or-approval", APPROVAL_COMPLIANCE, "approval", ["safety"], {
        approvalRequired: true,
        expectedResolution: "approved",
        guardApprovalNodeId: "require_approval",
        noToolBeforeApproval: true,
      });
      const toolDef = createEvalDef("or-tool-usage", TOOL_USAGE, "tool_use", ["tool_use"], {
        requiredTools: [{ id: "operations.create_change_draft", version: "1.0.0" }],
      });
      const modelDef = createEvalDef("or-model-call", MODEL, "run", ["capability"], {
        expectedCalls: { min: 1, max: 1 },
      });
      const traceDef = createEvalDef("or-trace", TRACE, "run", ["trace_contract"], {
        expectedRunStatus: "COMPLETED",
        compareWithExecution: true,
      });

      definitions.push(outcomeDef, approvalDef, toolDef, modelDef, traceDef);
      cases.push(
        { id: "or-outcome-case", evalRef: { id: outcomeDef.id, version: outcomeDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-approval-case", evalRef: { id: approvalDef.id, version: approvalDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-tool-case", evalRef: { id: toolDef.id, version: toolDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-model-case", evalRef: { id: modelDef.id, version: modelDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } },
        { id: "or-trace-case", evalRef: { id: traceDef.id, version: traceDef.version }, mode: "RUNTIME", evidenceRef: evidenceKey, expected: { status: "passed" } }
      );
      break;
    }

    default:
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Unknown pack eval profile: '${profileRef}'`
      );
  }

  const dataset: EvalDataset = {
    schemaVersion: 2,
    id: `pack-eval-dataset.${profileRef.replace(/[@.]/g, "-")}`,
    version: "1.0.0",
    name: `Capability Pack Evaluation Dataset for ${profileRef}`,
    cases,
  };

  return { dataset, definitions };
}

export interface PackEvalProfileDescriptor {
  readonly profileRef: string;
  readonly id: string;
  readonly version: string;
  readonly datasetId: string;
  readonly caseCount: number;
  readonly definitionIds: ReadonlyArray<string>;
  readonly graderRefs: ReadonlyArray<{ readonly id: string; readonly version: string }>;
  readonly supportedModes: ReadonlyArray<EvalMode>;
}

export interface PackEvalProfileRegistration {
  readonly profileRef: string;
  readonly buildDataset: (evidenceKey: string) => PackEvalDatasetPackage;
}

export interface PackEvalProfileCatalog {
  hasProfile(ref: string): boolean;
  describeProfile(ref: string): PackEvalProfileDescriptor | undefined;
  listProfileRefs(): ReadonlyArray<string>;
  buildDataset(ref: string, evidenceKey: string): PackEvalDatasetPackage;
}

export interface CreatePackEvalProfileCatalogOptions {
  readonly profiles?: ReadonlyArray<PackEvalProfileRegistration>;
  readonly evaluatorRegistry?: EvaluatorRegistry;
}

export const STANDARD_EVAL_PROFILE_REGISTRATIONS: ReadonlyArray<PackEvalProfileRegistration> =
  Object.freeze([
    Object.freeze({
      profileRef: EVAL_PROFILES.companyResearch,
      buildDataset: (evidenceKey: string) =>
        buildPackEvalDataset(EVAL_PROFILES.companyResearch, evidenceKey),
    }),
    Object.freeze({
      profileRef: EVAL_PROFILES.documentIntelligence,
      buildDataset: (evidenceKey: string) =>
        buildPackEvalDataset(EVAL_PROFILES.documentIntelligence, evidenceKey),
    }),
    Object.freeze({
      profileRef: EVAL_PROFILES.operationalRequest,
      buildDataset: (evidenceKey: string) =>
        buildPackEvalDataset(EVAL_PROFILES.operationalRequest, evidenceKey),
    }),
  ]);

function validateDatasetPackageAndGraders(
  profileRef: string,
  pkg: unknown,
  evaluatorRegistry: EvaluatorRegistry
): PackEvalProfileDescriptor {
  const parsedRef = ExactEvalProfileRefSchema.safeParse(profileRef);
  if (!parsedRef.success) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Invalid evaluation profile reference '${String(profileRef)}'`
    );
  }
  const [profileId, profileVersion] = parsedRef.data.split("@");

  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Evaluation profile '${profileRef}' did not produce a valid dataset package`
    );
  }

  const candidate = pkg as { dataset?: unknown; definitions?: unknown };
  const datasetParse = EvalDatasetSchema.safeParse(candidate.dataset);
  if (!datasetParse.success || datasetParse.data.cases.length === 0) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Evaluation profile '${profileRef}' has an invalid or empty EvalDataset contract`
    );
  }

  if (!Array.isArray(candidate.definitions) || candidate.definitions.length === 0) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Evaluation profile '${profileRef}' has no registered EvalDefinition contracts`
    );
  }

  const definitionsByKey = new Map<string, EvalDefinition>();
  const graderRefs: Array<{ readonly id: string; readonly version: string }> = [];

  for (const rawDef of candidate.definitions) {
    const defParse = EvalDefinitionSchema.safeParse(rawDef);
    if (!defParse.success) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${profileRef}' contains an invalid EvalDefinition contract`
      );
    }
    const def = defParse.data;
    const defKey = `${def.id}@${def.version}`;
    if (definitionsByKey.has(defKey)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Evaluation profile '${profileRef}' contains duplicate EvalDefinition '${defKey}'`
      );
    }
    definitionsByKey.set(defKey, def);

    const lookup = evaluatorRegistry.resolve(def.graderRef);
    if (!lookup.ok) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${profileRef}' requires grader '${def.graderRef.id}@${def.graderRef.version}', which is not registered in the EvaluatorRegistry (${lookup.code})`
      );
    }
    const grader = lookup.grader;
    if (!grader.supportedTargetTypes.includes(def.targetType)) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Grader '${def.graderRef.id}@${def.graderRef.version}' does not support targetType '${def.targetType}' required by profile '${profileRef}'`
      );
    }
    for (const mode of def.supportedModes) {
      if (!grader.supportedModes.includes(mode)) {
        throw new CapabilityPackError(
          "PACK_VERIFICATION_PROFILE_MISSING",
          `Grader '${def.graderRef.id}@${def.graderRef.version}' does not support mode '${mode}' required by profile '${profileRef}'`
        );
      }
    }

    graderRefs.push({ id: def.graderRef.id, version: def.graderRef.version });
  }

  for (const evalCase of datasetParse.data.cases) {
    const caseDefKey = `${evalCase.evalRef.id}@${evalCase.evalRef.version}`;
    const matchedDef = definitionsByKey.get(caseDefKey);
    if (!matchedDef) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${profileRef}' case '${evalCase.id}' references missing definition '${caseDefKey}'`
      );
    }
    if (!matchedDef.supportedModes.includes(evalCase.mode)) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${profileRef}' case '${evalCase.id}' requires unsupported mode '${evalCase.mode}'`
      );
    }
  }

  const supportedModes = Array.from(
    new Set(Array.from(definitionsByKey.values()).flatMap((d) => d.supportedModes))
  );

  return deepFreeze({
    profileRef: parsedRef.data,
    id: profileId!,
    version: profileVersion!,
    datasetId: datasetParse.data.id,
    caseCount: datasetParse.data.cases.length,
    definitionIds: Array.from(definitionsByKey.keys()),
    graderRefs,
    supportedModes,
  });
}

const DEFAULT_EVALUATOR_REGISTRY = createEvaluatorRegistry(deterministicGraders());

/**
 * Creates a deterministic, read-only lookup catalog over verified Capability Pack
 * evaluation profiles and builders. Performs bounded registration verification
 * without executing the evaluation dataset.
 */
export function createPackEvalProfileCatalog(
  options: CreatePackEvalProfileCatalogOptions = {}
): PackEvalProfileCatalog {
  const profiles = options.profiles ?? STANDARD_EVAL_PROFILE_REGISTRATIONS;
  const evaluatorRegistry = options.evaluatorRegistry ?? DEFAULT_EVALUATOR_REGISTRY;

  if (!Array.isArray(profiles)) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      "Eval profile registrations must be an array"
    );
  }

  const entries = new Map<
    string,
    {
      readonly descriptor: PackEvalProfileDescriptor;
      readonly buildDataset: (evidenceKey: string) => PackEvalDatasetPackage;
    }
  >();
  const versionsById = new Map<string, string>();

  for (const reg of profiles) {
    if (!reg || typeof reg !== "object") {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        "Eval profile registration must be a non-null object"
      );
    }
    const parsedRef = ExactEvalProfileRefSchema.safeParse(reg.profileRef);
    if (!parsedRef.success) {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Invalid evaluation profile reference '${String(reg.profileRef)}'`
      );
    }
    const ref = parsedRef.data;
    if (entries.has(ref)) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Duplicate evaluation profile registration '${ref}'`
      );
    }
    const [id, version] = ref.split("@");
    const existingVer = versionsById.get(id!);
    if (existingVer !== undefined && existingVer !== version) {
      throw new CapabilityPackError(
        "PACK_DUPLICATE_REF",
        `Conflicting evaluation profile versions '${id}@${existingVer}' and '${ref}'`
      );
    }
    if (typeof reg.buildDataset !== "function") {
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${ref}' is missing a dataset builder function`
      );
    }

    let probePkg: PackEvalDatasetPackage;
    try {
      probePkg = reg.buildDataset("probe://registration-verification");
    } catch (err) {
      if (err instanceof CapabilityPackError) throw err;
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${ref}' builder failed registration verification: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    const descriptor = validateDatasetPackageAndGraders(ref, probePkg, evaluatorRegistry);
    entries.set(ref, Object.freeze({ descriptor, buildDataset: reg.buildDataset }));
    versionsById.set(id!, version!);
  }

  const sortedRefs = Object.freeze(Array.from(entries.keys()).sort());

  return Object.freeze({
    hasProfile(ref: string): boolean {
      if (typeof ref !== "string") return false;
      return entries.has(ref);
    },
    describeProfile(ref: string): PackEvalProfileDescriptor | undefined {
      if (typeof ref !== "string") return undefined;
      return entries.get(ref)?.descriptor;
    },
    listProfileRefs(): ReadonlyArray<string> {
      return sortedRefs;
    },
    buildDataset(ref: string, evidenceKey: string): PackEvalDatasetPackage {
      const hit = typeof ref === "string" ? entries.get(ref) : undefined;
      if (!hit) {
        throw new CapabilityPackError(
          "PACK_VERIFICATION_PROFILE_MISSING",
          `Evaluation profile '${String(ref)}' is not registered in the evaluation profile catalog`
        );
      }
      return hit.buildDataset(evidenceKey);
    },
  });
}

/**
 * Verifies that a referenced evaluation profile is registered and backed by a usable
 * canonical dataset/definition builder and grader set without executing the dataset.
 */
export function verifyEvalProfileRegistration(
  catalog: PackEvalProfileCatalog,
  profileRef: string,
  evaluatorRegistry?: EvaluatorRegistry
): PackEvalProfileDescriptor {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    typeof catalog.hasProfile !== "function" ||
    typeof catalog.describeProfile !== "function" ||
    typeof catalog.buildDataset !== "function"
  ) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      "A valid PackEvalProfileCatalog is required to verify evaluation profile registration"
    );
  }

  if (!catalog.hasProfile(profileRef)) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Evaluation profile '${profileRef}' is not registered in the evaluation profile catalog`
    );
  }

  const descriptor = catalog.describeProfile(profileRef);
  if (!descriptor || descriptor.profileRef !== profileRef) {
    throw new CapabilityPackError(
      "PACK_VERIFICATION_PROFILE_MISSING",
      `Evaluation profile '${profileRef}' has no valid profile descriptor`
    );
  }

  if (evaluatorRegistry !== undefined) {
    let pkg: PackEvalDatasetPackage;
    try {
      pkg = catalog.buildDataset(profileRef, "probe://preflight-verification");
    } catch (err) {
      if (err instanceof CapabilityPackError) throw err;
      throw new CapabilityPackError(
        "PACK_VERIFICATION_PROFILE_MISSING",
        `Evaluation profile '${profileRef}' builder is unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return validateDatasetPackageAndGraders(profileRef, pkg, evaluatorRegistry);
  }

  return descriptor;
}

const STANDARD_EVAL_PROFILE_CATALOG = createPackEvalProfileCatalog();

export function createStandardEvalProfileCatalog(): PackEvalProfileCatalog {
  return STANDARD_EVAL_PROFILE_CATALOG;
}

export interface EvaluatePackRunResult {
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly allMatched: boolean;
  readonly run: EvalDatasetRun;
}

/**
 * Runs evaluation for an activated pack run against the canonical Evaluation Runtime.
 */
export async function evaluatePackRun(options: {
  readonly profileRef: string;
  readonly evidenceKey: string;
  readonly evidenceMap: ReadonlyMap<string, EvalEvidenceBundle>;
  readonly evalProfileCatalog?: PackEvalProfileCatalog;
}): Promise<EvaluatePackRunResult> {
  const catalog = options.evalProfileCatalog ?? STANDARD_EVAL_PROFILE_CATALOG;
  verifyEvalProfileRegistration(catalog, options.profileRef);
  const { dataset, definitions } = catalog.buildDataset(options.profileRef, options.evidenceKey);
  const registry = DEFAULT_EVALUATOR_REGISTRY;
  const evidenceResolver = {
    resolve: (ref: string) => options.evidenceMap.get(ref),
  };

  const outcome = await runEvalDataset({
    dataset,
    definitions,
    registry,
    evidenceResolver,
  });

  if (!outcome.ok) {
    throw new Error(`Eval dataset execution failed: ${outcome.code} (${JSON.stringify(outcome.issues)})`);
  }

  const cases = outcome.run.cases;
  const passedCases = cases.filter((c) => c.result.status === "passed").length;
  const failedCases = cases.filter((c) => c.result.status !== "passed").length;
  const allMatched = cases.every((c) => c.matchesExpectation === true);

  return {
    totalCases: cases.length,
    passedCases,
    failedCases,
    allMatched,
    run: outcome.run,
  };
}
