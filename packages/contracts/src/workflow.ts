import { z } from "zod";
import {
  CapabilityIdSchema,
  JsonObjectSchema,
  NodeIdSchema,
  WorkflowIdSchema,
  entityVersionSchema,
  schemaVersionSchema,
} from "./common.js";

/**
 * The stable set of node kinds AAO Core is expected to eventually support.
 * Listing them here does not implement them — the Node Registry and per-kind
 * validation are deferred to a later sprint (see `NodeDefinition.config`
 * below). No speculative kinds beyond this list are added.
 */
export const NodeKindSchema = z.enum([
  "deterministic",
  "model",
  "agent",
  "tool",
  "approval",
  "evaluator",
  "final_output",
]);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * A node's `config` is a deliberately opaque JSON-safe boundary. Node-specific
 * validation belongs to the future Node Registry / node-type contract, not to
 * a monolithic union on the core Workflow schema before node implementations
 * exist.
 */
export const NodeDefinitionSchema = z
  .object({
    id: NodeIdSchema,
    kind: NodeKindSchema,
    name: z.string().min(1).optional(),
    config: JsonObjectSchema,
  })
  .strict();
export type NodeDefinition = z.infer<typeof NodeDefinitionSchema>;

/**
 * An edge's `condition` is a deliberately opaque JSON-safe boundary reserved
 * for future conditional routing. This sprint does not implement expression
 * parsing, condition evaluation, or graph validation (cycles, reachability,
 * entry/exit consistency) — those belong to the Workflow DSL/compiler sprint.
 */
export const EdgeDefinitionSchema = z
  .object({
    sourceNodeId: NodeIdSchema,
    targetNodeId: NodeIdSchema,
    condition: JsonObjectSchema.optional(),
  })
  .strict();
export type EdgeDefinition = z.infer<typeof EdgeDefinitionSchema>;

/**
 * The normalized workflow domain model a future DSL/compiler can produce.
 * This is not the Workflow DSL itself (no YAML authoring, no compiler) and it
 * performs no graph-level semantic validation — see the field-level schemas
 * above for exactly what is and is not checked in this sprint.
 */
export const WorkflowSchema = z
  .object({
    schemaVersion: schemaVersionSchema(1),
    id: WorkflowIdSchema,
    version: entityVersionSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    entryNodeId: NodeIdSchema,
    nodes: z.array(NodeDefinitionSchema).min(1),
    edges: z.array(EdgeDefinitionSchema),
    requiredCapabilities: z.array(CapabilityIdSchema).optional(),
  })
  .strict();
export type Workflow = z.infer<typeof WorkflowSchema>;
