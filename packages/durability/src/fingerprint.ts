import { createHash } from "node:crypto";
import { canonicalJsonStringify, type JsonValue } from "@aao/contracts";
import { CompiledWorkflowPlanSchema, type CompiledWorkflowPlan } from "@aao/workflow-dsl";

const PLAN_FINGERPRINT_DOMAIN = "aao.compiled-plan.v1";

/**
 * Deterministic identity of the exact compiled plan a durable Run is bound
 * to: SHA-256 over canonical JSON (sorted object keys, array order kept —
 * edge order is routing semantics) of the behaviorally relevant plan. Only
 * the human-facing `workflow.name` and `workflow.description` are excluded.
 * A resume against any other fingerprint is refused even when the workflow
 * version is unchanged: version metadata helps humans, the fingerprint
 * establishes compatibility.
 */
export function planFingerprint(plan: CompiledWorkflowPlan): string {
  const parsed = CompiledWorkflowPlanSchema.parse(plan);
  const { name: _name, description: _description, ...workflow } = parsed.workflow;
  const material = { domain: PLAN_FINGERPRINT_DOMAIN, plan: { ...parsed, workflow } } as unknown as JsonValue;
  return createHash("sha256").update(canonicalJsonStringify(material)).digest("hex");
}
