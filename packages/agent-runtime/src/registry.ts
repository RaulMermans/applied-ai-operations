import { RegisteredAgentSchema, type AgentRef, type RegisteredAgent } from "./types.js";

/**
 * Explicit, constructible, isolated Agent Registry. No global singleton, no
 * filesystem discovery, no dynamic imports: every instance starts empty and
 * is populated only by trusted calling code. Agents are keyed by their
 * canonical `AgentSpec` identity (`id` + `version`), so two versions of one
 * Agent may coexist, and lookup is version-exact.
 */
export interface AgentRegistry {
  /**
   * Registers a validated, defensively cloned Agent binding. Throws on a
   * malformed binding (non-canonical `AgentSpec`, missing/blank
   * instructions, out-of-bounds limits) or a duplicate `id@version` — both
   * are programming errors, not runtime failures. Registration does *not*
   * judge whether the Agent is executable in Sprint 7 (tools, skills, model
   * policy): that is checked, fail-closed, before every execution.
   */
  register(agent: RegisteredAgent): void;
  /** A defensive clone, so no caller can mutate a registered Agent's limits or instructions. */
  get(ref: AgentRef): RegisteredAgent | undefined;
}

export function createAgentRegistry(): AgentRegistry {
  const agents = new Map<string, RegisteredAgent>();
  return {
    register(agent: RegisteredAgent): void {
      const parsed = RegisteredAgentSchema.safeParse(agent);
      if (!parsed.success) {
        throw new Error("AgentRegistry: agent does not match RegisteredAgentSchema (canonical AgentSpec, non-blank instructions, bounded limits).");
      }
      const key = agentKey(parsed.data.spec);
      if (agents.has(key)) {
        throw new Error(`AgentRegistry: agent "${parsed.data.spec.id}" version "${parsed.data.spec.version}" is already registered.`);
      }
      agents.set(key, cloneAgent(parsed.data));
    },
    get(ref: AgentRef): RegisteredAgent | undefined {
      const agent = agents.get(agentKey(ref));
      return agent === undefined ? undefined : cloneAgent(agent);
    },
  };
}

function agentKey(ref: { id: string; version: string }): string {
  // JSON-encoded so no id/version pair can collide with another via a separator.
  return JSON.stringify([ref.id, ref.version]);
}

function cloneAgent(agent: RegisteredAgent): RegisteredAgent {
  return JSON.parse(JSON.stringify(agent)) as RegisteredAgent;
}
