import { z } from "zod";

/**
 * The adapter-kind taxonomy (ADR-025). A shared manifest envelope, but
 * kind-specific executable ports. There is no universal `Adapter.execute`.
 *
 * - `model`: provides canonical AAO model invocation (the Model Runtime's
 *   `ModelAdapter` port).
 * - `tool_provider`: supplies externally sourced Tool capabilities that a
 *   trusted host binds to canonical `ToolSpec`s. Execution still goes
 *   through the Tool Runtime, so the support gate, Authorization, and
 *   schemas run first. MCP is a `tool_provider` and nothing else.
 * - `agent_runtime`: an alternative substrate for *bounded* agent semantics.
 *   The native AAO Agent Runtime is the reference semantics. No adapter of
 *   this kind exists. LangGraph remains deferred.
 */
export const ADAPTER_KINDS = ["model", "tool_provider", "agent_runtime"] as const;
export const AdapterKindSchema = z.enum(ADAPTER_KINDS);
export type AdapterKind = z.infer<typeof AdapterKindSchema>;

/**
 * The canonical, versioned capability catalog (contract version 1). Names
 * describe AAO semantics, never a provider construct, and only behavior AAO
 * implements and conformance verifies is listed:
 *
 * model
 * - `model.text_generation`: returns a text `ModelAdapterResult`.
 * - `model.structured_output`: honors a structured-output JSON Schema
 *   request. AAO re-validates the result either way.
 * - `model.usage`: reports exact token usage.
 * - `model.cancellation`: propagates the invocation `AbortSignal` to the
 *   provider boundary, so an abandoned call actually stops.
 * - `model.tool_call_response`: can surface a provider tool-call response,
 *   which it always maps to the fail-closed `unsupported_response`. It
 *   never executes a Tool.
 *
 * tool_provider
 * - `tool.discovery`: lists remote Tool metadata for a trusted host to bind.
 *   The metadata is never authority.
 * - `tool.execution`: executes a host-bound Tool through a canonical Tool
 *   handler, with normalized failures.
 * - `tool.retryable_failure`: reports a transient remote failure as
 *   `retryable`, so the Runtime may retry a Tool the *host* declared
 *   retry-safe. It never makes a Tool retry-safe.
 *
 * agent_runtime
 * - none yet. Capabilities are added only with a conformance-complete
 *   implementation.
 */
export const ADAPTER_CAPABILITY_CATALOG = Object.freeze({
  model: Object.freeze(["model.text_generation", "model.structured_output", "model.usage", "model.cancellation", "model.tool_call_response"] as const),
  tool_provider: Object.freeze(["tool.discovery", "tool.execution", "tool.retryable_failure"] as const),
  agent_runtime: Object.freeze([] as const),
});

export type ModelAdapterCapability = (typeof ADAPTER_CAPABILITY_CATALOG.model)[number];
export type ToolProviderAdapterCapability = (typeof ADAPTER_CAPABILITY_CATALOG.tool_provider)[number];
export type AdapterCapability = ModelAdapterCapability | ToolProviderAdapterCapability;

export const ADAPTER_CAPABILITIES: readonly AdapterCapability[] = Object.freeze([...ADAPTER_CAPABILITY_CATALOG.model, ...ADAPTER_CAPABILITY_CATALOG.tool_provider]);
export const AdapterCapabilitySchema = z.enum(ADAPTER_CAPABILITIES as unknown as [AdapterCapability, ...AdapterCapability[]]);

/** The catalog for one kind, in canonical order. */
export function capabilitiesForKind(kind: AdapterKind): readonly AdapterCapability[] {
  return ADAPTER_CAPABILITY_CATALOG[kind];
}

/** A declaration is binary and closed: free-form prose never determines behavior. */
export const CAPABILITY_SUPPORT = ["supported", "unsupported"] as const;
export const CapabilitySupportSchema = z.enum(CAPABILITY_SUPPORT);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;
