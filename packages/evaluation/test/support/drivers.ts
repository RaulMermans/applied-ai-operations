import { createAuditRecorder, createInMemoryAuditStore, createInMemoryTraceStore, createTraceRecorder } from "@aao/observability";
import { createMcpConnectorDriver } from "../../../mcp-connector/conformance/driver.mjs";
import { createNativeModelDriver } from "../../../model-runtime/conformance/native-driver.mjs";
import { createVercelAiDriver } from "../../../model-runtime/conformance/vercel-ai-driver.mjs";
import { createNativeToolDriver } from "../../../tool-runtime/conformance/driver.mjs";
import type { AdapterVerificationDriver } from "../../src/index.js";

/**
 * The verification host's side of adapter verification: it injects the
 * canonical evidence recorders into each substrate's own test driver (the
 * drivers live with their substrates and never depend on @aao/evaluation).
 * Driver evidence is untrusted input: the Evaluation Runtime validates it
 * against EvalEvidenceBundleSchema before any grader sees it, so the
 * structural driver types are adapted here at one seam.
 */
export const recorders = { createInMemoryTraceStore, createTraceRecorder, createInMemoryAuditStore, createAuditRecorder } as never;

export const asVerificationDriver = <T extends object>(driver: T) => driver as unknown as AdapterVerificationDriver & T;

export const nativeToolDriver = () => asVerificationDriver(createNativeToolDriver({ recorders }));
export const mcpDriver = () => asVerificationDriver(createMcpConnectorDriver({ recorders }));
export const nativeModelDriver = () => asVerificationDriver(createNativeModelDriver({ recorders }));
export const vercelAiDriver = () => asVerificationDriver(createVercelAiDriver({ recorders }));
