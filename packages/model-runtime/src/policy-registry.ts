import { ModelPolicySpecSchema, type ModelPolicySpec } from "@aao/contracts";

/**
 * An explicit lookup boundary for canonical `ModelPolicySpec`s (from
 * `@aao/contracts` — never redefined here), keyed by stable policy id. Not a
 * generic policy engine. No global singleton.
 */
export interface ModelPolicyRegistry {
  /** Throws on a non-canonical spec or a duplicate id — programming errors, not runtime failures. */
  register(policy: ModelPolicySpec): void;
  get(id: string): ModelPolicySpec | undefined;
}

export function createModelPolicyRegistry(): ModelPolicyRegistry {
  const policies = new Map<string, ModelPolicySpec>();
  return {
    register(policy: ModelPolicySpec): void {
      const parsed = ModelPolicySpecSchema.safeParse(policy);
      if (!parsed.success) {
        throw new Error("ModelPolicyRegistry: policy does not match the canonical ModelPolicySpecSchema.");
      }
      if (policies.has(parsed.data.id)) {
        throw new Error(`ModelPolicyRegistry: a model policy with id "${parsed.data.id}" is already registered.`);
      }
      policies.set(parsed.data.id, clonePolicy(parsed.data));
    },
    get(id: string): ModelPolicySpec | undefined {
      const policy = policies.get(id);
      return policy === undefined ? undefined : clonePolicy(policy);
    },
  };
}

/**
 * `ModelPolicySpec.constraints` was left opaque by the canonical contract and
 * Model Runtime V1 defines no constraint semantics. Rather than silently
 * ignoring constraints it cannot enforce, V1 fails closed: only an absent or
 * empty `constraints` object is supported.
 */
export function hasUnsupportedConstraints(policy: ModelPolicySpec): boolean {
  return policy.constraints !== undefined && Object.keys(policy.constraints).length > 0;
}

function clonePolicy(policy: ModelPolicySpec): ModelPolicySpec {
  return JSON.parse(JSON.stringify(policy)) as ModelPolicySpec;
}
