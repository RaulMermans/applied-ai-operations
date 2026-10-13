import { z } from "zod";
import { NodeIdSchema, TraceEventTypeSchema, type TraceEvent } from "@aao/contracts";
import { assertion, judged, zodConfig, type EvalGrader } from "../grader.js";
import { payload, readTrace, refs, uniqueBy } from "../trace-view.js";

const EventPatternSchema = z.object({ type: TraceEventTypeSchema, nodeId: NodeIdSchema.optional() }).strict();
type EventPattern = z.infer<typeof EventPatternSchema>;

const ConfigSchema = z
  .object({
    /**
     * The executed Node trajectory: one entry per executed step, in step
     * order (retries and recovery replays of a step do not repeat it).
     * `exact`: the trajectory equals `nodes`. `ordered_subsequence`: `nodes`
     * appear in this order, other Nodes may occur in between.
     */
    nodeSequence: z.object({ mode: z.enum(["exact", "ordered_subsequence"]), nodes: z.array(NodeIdSchema).min(1).max(128) }).strict().optional(),
    /** Canonical Trace event patterns that must occur in this order (gaps allowed). Matched on type and optional Node — never regex over JSON. */
    eventSequence: z.object({ mode: z.literal("ordered_subsequence"), events: z.array(EventPatternSchema).min(1).max(128) }).strict().optional(),
    forbiddenNodes: z.array(NodeIdSchema).min(1).max(64).optional(),
    forbiddenEvents: z.array(EventPatternSchema).min(1).max(64).optional(),
    /** Forbidden-behavior checks need the whole Run. Default true. */
    requireTerminal: z.boolean().default(true),
  })
  .strict()
  .refine((config) => config.nodeSequence || config.eventSequence || config.forbiddenNodes || config.forbiddenEvents, "at least one criterion")
  .refine((config) => !config.forbiddenNodes || uniqueBy(config.forbiddenNodes, (node) => node), "forbidden nodes must be unique")
  .refine((config) => !config.forbiddenEvents || uniqueBy(config.forbiddenEvents, (event) => `${event.type}@${event.nodeId ?? ""}`), "forbidden events must be unique");
type Config = z.infer<typeof ConfigSchema>;

const matches = (event: TraceEvent, pattern: EventPattern) => event.type === pattern.type && (pattern.nodeId === undefined || event.nodeId === pattern.nodeId);

/** Ordered-subsequence match; returns the matched events, or undefined. */
function subsequence<T, P>(items: readonly T[], patterns: readonly P[], test: (item: T, pattern: P) => boolean): T[] | undefined {
  const found: T[] = [];
  let index = 0;
  for (const item of items) {
    if (index < patterns.length && test(item, patterns[index]!)) {
      found.push(item);
      index += 1;
    }
  }
  return index === patterns.length ? found : undefined;
}

/**
 * `aao.trajectory` — the canonical AAO execution trajectory: Node order,
 * ordered event subsequences, forbidden Nodes, forbidden events. Sequence
 * semantics are explicit in config (`exact` vs `ordered_subsequence`).
 */
export function createTrajectoryGrader(): EvalGrader<Config> {
  return {
    id: "aao.trajectory",
    version: "1.0.0",
    supportedModes: ["OFFLINE", "RUNTIME"],
    supportedTargetTypes: ["trajectory", "node", "run"],
    validateConfig: zodConfig(ConfigSchema),
    evaluate({ config, evidence }) {
      const read = readTrace(evidence, { requireTerminal: config.requireTerminal });
      if (!read.ok) return read.outcome;
      const events = read.view.events;
      const steps = new Set<number>();
      const nodeStarts = events.filter((event) => {
        if (event.type !== "node.started") return false;
        const step = payload(event).step as number;
        if (steps.has(step)) return false;
        steps.add(step);
        return true;
      });
      const assertions = [];

      if (config.nodeSequence) {
        const { mode, nodes } = config.nodeSequence;
        const actual = nodeStarts.map((event) => event.nodeId!);
        const matched = mode === "exact" ? (actual.length === nodes.length && actual.every((node, index) => node === nodes[index]) ? nodeStarts : undefined) : subsequence(nodeStarts, nodes, (event, node) => event.nodeId === node);
        assertions.push(assertion("trajectory.node-sequence", matched !== undefined, { reasonCode: "TRAJECTORY_NODE_SEQUENCE_MISMATCH", evidenceRefs: refs(matched ?? nodeStarts) }));
      }
      if (config.eventSequence) {
        const matched = subsequence(events, config.eventSequence.events, matches);
        assertions.push(assertion("trajectory.event-sequence", matched !== undefined, { reasonCode: "TRAJECTORY_EVENT_SEQUENCE_MISMATCH", evidenceRefs: refs(matched ?? []) }));
      }
      for (const node of config.forbiddenNodes ?? []) {
        const offending = nodeStarts.filter((event) => event.nodeId === node);
        assertions.push(assertion(`trajectory.forbidden-node:${node}`, offending.length === 0, { reasonCode: "TRAJECTORY_FORBIDDEN_NODE", evidenceRefs: refs(offending) }));
      }
      (config.forbiddenEvents ?? []).forEach((pattern, index) => {
        const offending = events.filter((event) => matches(event, pattern));
        assertions.push(assertion(`trajectory.forbidden-event:${index + 1}`, offending.length === 0, { reasonCode: "TRAJECTORY_FORBIDDEN_EVENT", evidenceRefs: refs(offending) }));
      });
      return judged(assertions);
    },
  };
}
