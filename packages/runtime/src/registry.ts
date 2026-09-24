import type { NodeKind } from "@aao/contracts";
import type { NodeExecutor, NodeRegistry } from "./types.js";

/**
 * Builds a fresh, isolated Node Registry. There is no module-level state
 * here — every call returns its own `Map`, so two registries (e.g. two
 * concurrent test cases, or a real registry vs. a test double) never share
 * registrations, and nothing is a global/singleton a distant part of the
 * codebase could silently mutate.
 */
export function createNodeRegistry(): NodeRegistry {
  const executors = new Map<NodeKind, NodeExecutor>();

  return {
    register(executor: NodeExecutor): void {
      if (executors.has(executor.kind)) {
        throw new Error(`NodeRegistry: an executor for node kind "${executor.kind}" is already registered`);
      }
      executors.set(executor.kind, executor);
    },
    has(kind: NodeKind): boolean {
      return executors.has(kind);
    },
    get(kind: NodeKind): NodeExecutor | undefined {
      return executors.get(kind);
    },
  };
}
