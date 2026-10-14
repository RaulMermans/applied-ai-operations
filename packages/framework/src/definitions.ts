import {
  AgentSpecSchema,
  EvalDefinitionSchema,
  GovernanceConfigurationSchema,
  ModelPolicySpecSchema,
  ToolSpecSchema,
  type AgentSpec,
  type EvalDefinition,
  type GovernanceConfiguration,
  type ModelPolicySpec,
  type RetrySafety,
  type ToolIdempotency,
  type ToolSpec,
  type Workflow,
} from "@aao/contracts";
import { createGovernanceRegistry } from "@aao/governance";
import { isJsonSafe } from "@aao/runtime";
import { createToolRegistry, type ToolHandler } from "@aao/tool-runtime";
import { parseWorkflowSource } from "@aao/workflow-dsl";
import { AAOFrameworkError } from "./errors.js";
import { canonicalDefinition, deepFreeze, registrationFailure } from "./internal.js";

// Every helper here validates against the canonical AAO contract that owns
// the concept and returns that contract's type — a detached, deep-frozen
// copy. None compiles, registers, executes, reads the filesystem, or reads
// the environment. There is no Framework-specific schema.

/**
 * Validates a canonical `Workflow` (WorkflowSchema, through the Workflow
 * DSL's own parser so diagnostics are the canonical `WorkflowDiagnostic`s).
 * Graph semantics are the compiler's job: `app.prepareWorkflow` compiles.
 */
export function defineWorkflow(input: Workflow): Workflow {
  if (!isJsonSafe(input)) throw new AAOFrameworkError("FRAMEWORK_INVALID_DEFINITION", "workflow must be a JSON-safe value");
  const parsed = parseWorkflowSource(JSON.stringify(input), "json");
  if (!parsed.ok) throw new AAOFrameworkError("FRAMEWORK_INVALID_DEFINITION", "workflow does not satisfy the canonical Workflow schema", parsed.diagnostics);
  return deepFreeze(parsed.workflow);
}

/**
 * Validates canonical Governance configuration (GovernanceConfigurationSchema
 * plus the Governance registry's referential checks: unique ids, known
 * actor/role references). Returns the configuration, not a registry:
 * enforcement stays with `createGovernanceRegistry` / `resolveAuthority` /
 * `authorize`, which `createAAO` composes.
 */
export function defineGovernance(input: GovernanceConfiguration): GovernanceConfiguration {
  const configuration = canonicalDefinition(GovernanceConfigurationSchema, input, "governance");
  try {
    createGovernanceRegistry(configuration);
  } catch (error) {
    throw registrationFailure("FRAMEWORK_INVALID_DEFINITION", "governance", error);
  }
  return configuration;
}

/** A canonical Eval definition (EvalDefinitionSchema). Data only: it selects a trusted grader by id + version and can never load code. */
export function defineEval(input: EvalDefinition): EvalDefinition {
  return canonicalDefinition(EvalDefinitionSchema, input, "eval definition");
}

/**
 * A declarative canonical `AgentSpec` (AgentSpecSchema). Framework V1 does
 * not execute `agent` nodes: model/agent execution needs the model adapter
 * contract that Sprint 20 owns, so this helper is validation only.
 */
export function defineAgent(input: AgentSpec): AgentSpec {
  return canonicalDefinition(AgentSpecSchema, input, "agent definition");
}

/** A declarative, provider-neutral canonical `ModelPolicySpec` (ModelPolicySpecSchema). Validation only in Framework V1. */
export function defineModelPolicy(input: ModelPolicySpec): ModelPolicySpec {
  return canonicalDefinition(ModelPolicySpecSchema, input, "model policy");
}

/**
 * Input to `defineTool`: exactly the Tool Runtime's `RegisteredTool` — the
 * canonical, serializable `ToolSpec` plus the trusted executable `handler`
 * and its trusted registration metadata. The handler never enters the
 * `ToolSpec`.
 */
export interface ToolDefinitionInput {
  spec: ToolSpec;
  handler: ToolHandler;
  /** Tool Runtime semantics, unchanged: defaults to "unsafe"; "safe" only when every permission class is read_only. */
  retrySafety?: RetrySafety;
  /** Tool Runtime semantics, unchanged: defaults to "none". */
  idempotency?: ToolIdempotency;
}

/** A validated Tool definition: still a `RegisteredTool`, with a frozen spec and a captured handler. */
export type ToolDefinition = Readonly<{
  spec: Readonly<ToolSpec>;
  handler: Readonly<ToolHandler>;
  retrySafety?: RetrySafety;
  idempotency?: ToolIdempotency;
}>;

/**
 * Validates a Tool by registering it into a throwaway canonical Tool
 * Registry — the same checks `createAAO` will apply (ToolSpecSchema, strict
 * input/output JSON Schema compilation, retry-safety and idempotency
 * rules, a callable handler) — and returns a frozen definition. Defining a
 * Tool grants nothing: the permission support gate and Authorization run
 * on every execution.
 */
export function defineTool(input: ToolDefinitionInput): ToolDefinition {
  if (input === null || typeof input !== "object") throw new AAOFrameworkError("FRAMEWORK_INVALID_DEFINITION", "tool definition must be an object");
  const spec = canonicalDefinition(ToolSpecSchema, input.spec, "tool spec");
  const source = input.handler;
  const execute = source?.execute;
  if (typeof execute !== "function") throw new AAOFrameworkError("FRAMEWORK_INVALID_DEFINITION", `tool "${spec.id}" version "${spec.version}" has no handler.execute function`);
  // Captured once: replacing the caller's handler.execute later cannot change the defined Tool.
  const handler: ToolHandler = Object.freeze({ execute: (context: Parameters<ToolHandler["execute"]>[0]) => execute.call(source, context) });
  const definition = {
    spec,
    handler,
    ...(input.retrySafety !== undefined ? { retrySafety: input.retrySafety } : {}),
    ...(input.idempotency !== undefined ? { idempotency: input.idempotency } : {}),
  };
  try {
    createToolRegistry().register({ ...definition, spec: { ...spec } });
  } catch (error) {
    throw registrationFailure("FRAMEWORK_INVALID_DEFINITION", "tool", error);
  }
  return Object.freeze(definition);
}
