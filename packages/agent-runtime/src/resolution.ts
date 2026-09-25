import type { PermissionClass } from "@aao/contracts";
import { hasUnsupportedConstraints, type ModelPolicyRegistry } from "@aao/model-runtime";
import type { AgentRegistry } from "./registry.js";
import type { AgentFailure, AgentRef, RegisteredAgent } from "./types.js";

/**
 * Permission classes a Sprint 7 Agent may declare. A bounded Agent only
 * reasons and proposes a result that the workflow Runtime applies as a
 * state patch, so `read_only` and `write_draft` describe it honestly.
 * `external_side_effect`, `destructive`, and `sensitive_data` require
 * governance, approval, and data-handling machinery that does not exist
 * yet; an Agent declaring them fails closed instead of running as if those
 * controls were honored. Permission metadata never *grants* anything.
 */
const SUPPORTED_PERMISSION_CLASSES: ReadonlySet<PermissionClass> = new Set<PermissionClass>(["read_only", "write_draft"]);

export interface AgentResolutionDependencies {
  agents: AgentRegistry;
  policies: ModelPolicyRegistry;
}

export type AgentResolution = { ok: true; agent: RegisteredAgent; modelPolicyRef: string } | { ok: false; failure: AgentFailure };

/**
 * Resolves an Agent reference to a binding the Sprint 7 Agent Runtime can
 * actually execute, failing closed on anything it cannot honor. Pure,
 * deterministic, and side-effect-free: it reads only the explicit
 * registries, never invokes a model, and is shared by Agent Node preflight
 * and `executeAgent` so both enforce exactly the same rules.
 *
 * Order: `AGENT_NOT_FOUND` → `UNSUPPORTED_AGENT_CONFIGURATION` (tools,
 * skills, missing model policy, unsupported permission classes) →
 * `AGENT_MODEL_POLICY_NOT_FOUND` → `UNSUPPORTED_AGENT_CONFIGURATION`
 * (model policy with constraints Model Runtime V1 cannot enforce).
 */
export function resolveExecutableAgent(ref: AgentRef, dependencies: AgentResolutionDependencies): AgentResolution {
  const agent = dependencies.agents.get(ref);
  if (agent === undefined) {
    return { ok: false, failure: { code: "AGENT_NOT_FOUND", message: `Agent "${ref.id}" version "${ref.version}" is not registered.`, agentRef: { ...ref } } };
  }

  const { spec } = agent;
  const issues: string[] = [];
  // No Tool Registry, authorization, or approval path exists yet, so a tool
  // reference must never silently become executable.
  if (spec.toolRefs.length > 0) issues.push("toolRefs: tools are not supported by the Sprint 7 Agent Runtime");
  // No Skill Runtime exists; declaring skills would pretend they are honored.
  if (spec.skillRefs.length > 0) issues.push("skillRefs: skills are not supported by the Sprint 7 Agent Runtime");
  if (spec.modelPolicyRef === undefined) issues.push("modelPolicyRef: an Agent must reference a registered model policy");
  const unsupportedClasses = spec.permissionClasses.filter((permissionClass) => !SUPPORTED_PERMISSION_CLASSES.has(permissionClass));
  if (unsupportedClasses.length > 0) issues.push(`permissionClasses: ${unsupportedClasses.join(", ")} not supported by the Sprint 7 Agent Runtime`);
  if (issues.length > 0 || spec.modelPolicyRef === undefined) {
    return { ok: false, failure: { code: "UNSUPPORTED_AGENT_CONFIGURATION", message: `Agent "${spec.id}" version "${spec.version}" has an unsupported configuration.`, agentRef: { ...ref }, issues } };
  }

  const policy = dependencies.policies.get(spec.modelPolicyRef);
  if (policy === undefined) {
    return {
      ok: false,
      failure: { code: "AGENT_MODEL_POLICY_NOT_FOUND", message: `Agent "${spec.id}" references model policy "${spec.modelPolicyRef}", which is not registered.`, agentRef: { ...ref } },
    };
  }
  if (hasUnsupportedConstraints(policy)) {
    return {
      ok: false,
      failure: {
        code: "UNSUPPORTED_AGENT_CONFIGURATION",
        message: `Agent "${spec.id}" version "${spec.version}" has an unsupported configuration.`,
        agentRef: { ...ref },
        issues: [`modelPolicyRef: model policy "${policy.id}" declares constraints Model Runtime V1 does not support`],
      },
    };
  }

  return { ok: true, agent, modelPolicyRef: spec.modelPolicyRef };
}
