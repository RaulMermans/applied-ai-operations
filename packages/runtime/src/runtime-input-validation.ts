import { RunIdSchema, RunStateSchema } from "@aao/contracts";
import { CompiledWorkflowPlanSchema } from "@aao/workflow-dsl";
import type { ExecuteWorkflowRequest, RuntimeFailure } from "./types.js";

/**
 * Defensive validation of the Runtime's own request boundary — separate from
 * (and running before) `preflight.ts`, which validates that an
 * already-well-formed plan is *runtime-compatible*. This module only asks
 * "is this a well-formed request at all": a valid `runId`, a `RunState` that
 * matches the canonical schema and whose `runId` agrees with the request's
 * `runId`, a `CompiledWorkflowPlan` that matches its schema, a registry that
 * looks like a `NodeRegistry`, and sane options. A mismatched identity is
 * never silently rewritten — it is rejected.
 */
export function validateRuntimeInput(request: ExecuteWorkflowRequest): RuntimeFailure | undefined {
  const runIdResult = RunIdSchema.safeParse(request.runId);
  if (!runIdResult.success) {
    return { code: "INVALID_RUNTIME_INPUT", message: "request.runId must be a valid AAO identifier." };
  }

  const planResult = CompiledWorkflowPlanSchema.safeParse(request.plan);
  if (!planResult.success) {
    return {
      code: "INVALID_RUNTIME_INPUT",
      message: "request.plan is not a valid CompiledWorkflowPlan.",
      details: { issues: planResult.error.issues.map((issue) => issue.message) },
    };
  }

  const stateResult = RunStateSchema.safeParse(request.initialState);
  if (!stateResult.success) {
    return {
      code: "INVALID_RUNTIME_INPUT",
      message: "request.initialState is not a valid RunState.",
      details: { issues: stateResult.error.issues.map((issue) => issue.message) },
    };
  }

  if (stateResult.data.runId !== runIdResult.data) {
    return {
      code: "INVALID_RUNTIME_INPUT",
      message: `request.initialState.runId ("${stateResult.data.runId}") does not match request.runId ("${runIdResult.data}").`,
    };
  }

  if (!isNodeRegistryShaped(request.registry)) {
    return { code: "INVALID_RUNTIME_INPUT", message: "request.registry must implement register/has/get." };
  }

  if (request.options?.maxSteps !== undefined) {
    const maxSteps = request.options.maxSteps;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      return { code: "INVALID_RUNTIME_INPUT", message: "request.options.maxSteps must be a positive integer." };
    }
  }

  return undefined;
}

function isNodeRegistryShaped(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.register === "function" && typeof candidate.has === "function" && typeof candidate.get === "function";
}
