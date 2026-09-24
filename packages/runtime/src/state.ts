import type { JsonObject, RunState } from "@aao/contracts";
import { cloneJsonValue } from "./json-safety.js";

/**
 * Runtime V1 state semantics (documented in full in
 * `docs/architecture/runtime-v1.md`):
 *
 * A `statePatch` performs a **shallow top-level merge** into `RunState.values`.
 * Each top-level key present in the patch fully replaces that key's prior
 * value (nested objects are replaced, never recursively merged); every key
 * absent from the patch is preserved unchanged. There is no reducer
 * registry, no deep merge, no delete operator, and no conflict resolution —
 * those are deliberately deferred.
 *
 * `revision` increments by exactly one for every accepted state-changing
 * result. A node that returns no patch does **not** increment revision: an
 * unchanged state is not a new state.
 *
 * The returned `RunState` is a new object built from deep-cloned values, so
 * neither the input `state` nor any earlier snapshot derived from it is ever
 * mutated — safe to hand a prior snapshot to a test assertion after later
 * patches have been applied.
 */
export function applyStatePatch(state: RunState, patch: JsonObject | undefined): RunState {
  if (patch === undefined) return state;

  return {
    runId: state.runId,
    revision: state.revision + 1,
    values: { ...cloneJsonValue(state.values), ...cloneJsonValue(patch) },
  };
}

/** A defensive deep clone of a `RunState`, used before handing state to an executor so it cannot corrupt authoritative state through a shared reference. */
export function cloneRunState(state: RunState): RunState {
  return { runId: state.runId, revision: state.revision, values: cloneJsonValue(state.values) };
}
