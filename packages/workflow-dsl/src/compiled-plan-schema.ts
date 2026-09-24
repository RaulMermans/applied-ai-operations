import { z } from "zod";
import { EdgeDefinitionSchema, NodeDefinitionSchema, NodeIdSchema, WorkflowSchema } from "@aao/contracts";

/**
 * A runtime-validatable schema for `CompiledWorkflowPlan`. `compileWorkflow`
 * itself never needs this — it builds a plan from an already-validated
 * `Workflow` and controls every field it writes. This schema exists for a
 * *consumer* (the future Runtime) that may receive a serialized or otherwise
 * externally-constructed plan and must not trust it is well-formed just
 * because it is typed as `CompiledWorkflowPlan` in TypeScript. The compiled
 * plan is owned by this package (the compiler produces it), so the schema
 * lives here rather than being duplicated downstream.
 */
export const CompiledWorkflowPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    workflow: WorkflowSchema,
    entryNodeId: NodeIdSchema,
    nodesById: z.record(NodeIdSchema, NodeDefinitionSchema),
    outgoingEdgesByNode: z.record(NodeIdSchema, z.array(EdgeDefinitionSchema)),
    incomingEdgesByNode: z.record(NodeIdSchema, z.array(EdgeDefinitionSchema)),
    terminalNodeIds: z.array(NodeIdSchema),
  })
  .strict();

export type CompiledWorkflowPlan = z.infer<typeof CompiledWorkflowPlanSchema>;
