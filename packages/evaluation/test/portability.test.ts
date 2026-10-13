import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalResult } from "@aao/contracts";
import type { EvalEvidenceBundle } from "../src/index.js";
import { definition, evalsRoot, loadFixture } from "./support/evals.js";
import { def, grade } from "./support/inline.js";

/**
 * Portable verification (ADR-022): an Eval Definition attaches to AAO
 * contracts and execution semantics, not to the model provider, Tool
 * implementation, or orchestration framework underneath. Semantically
 * equivalent canonical evidence must receive the same verdict.
 */
const semantic = (result: EvalResult) => ({ status: result.status, errorCode: result.errorCode, assertions: result.assertions.map(({ id, status, reasonCode, score }) => ({ id, status, reasonCode, score })) });

const portableDefinitions = () => [
  definition("trajectory.model-then-tool"),
  definition("tool.lookup-required"),
  definition("tool.no-external-send"),
  definition("run.completed"),
  def("aao.tool-usage", "tool_use", { callLimits: [{ count: "physical", max: 1 }, { count: "logical", max: 1 }] }),
  def("aao.trace-contract", "run", { requireTerminal: true }),
];

describe("same EvalDefinition, equivalent canonical evidence, different provider / integration origin → same verdict", () => {
  it("provider-a/model-a via one binding vs provider-b/model-b via another, different Run, workflow, and Tool execution ids", async () => {
    const a = loadFixture("portability-provider-a");
    const b = loadFixture("portability-provider-b");
    const identityOf = (bundle: EvalEvidenceBundle) => (bundle.trace as Array<{ type: string; workflowId: string; payload: { modelIdentity?: { provider: string }; modelBindingId?: string } }>).find((event) => event.type === "model.call.completed")!;
    expect([identityOf(a).payload.modelIdentity?.provider, identityOf(a).payload.modelBindingId, identityOf(a).workflowId]).toEqual(["provider-a", "binding.ai-sdk", "portability.native"]);
    expect([identityOf(b).payload.modelIdentity?.provider, identityOf(b).payload.modelBindingId, identityOf(b).workflowId]).toEqual(["provider-b", "binding.local-llm", "portability.adapter"]);
    for (const candidate of portableDefinitions()) {
      const resultA = await grade(candidate, a);
      const resultB = await grade(candidate, b);
      expect(resultA.status, candidate.id).toBe("passed");
      expect(semantic(resultB), candidate.id).toEqual(semantic(resultA));
      // Different Runs are different evidence: fingerprints and result ids differ by design.
      expect(resultA.resultId).not.toBe(resultB.resultId);
    }
  });

  it("the same Run re-attributed to another provider: identical verdict and evidence refs; only the fingerprint/result id change, because provider metadata is part of the evidence", async () => {
    const a = loadFixture("portability-provider-a");
    const swapped = JSON.parse(JSON.stringify(a).replaceAll("provider-a", "provider-z").replaceAll("model-a", "model-z").replaceAll("binding.ai-sdk", "binding.vendor-x")) as EvalEvidenceBundle;
    for (const candidate of portableDefinitions()) {
      const original = await grade(candidate, a);
      const other = await grade(candidate, swapped);
      expect(other.assertions).toEqual(original.assertions);
      expect(other.status).toBe(original.status);
      expect(other.evidenceFingerprint).not.toBe(original.evidenceFingerprint);
    }
  });

  it("a negative verdict is portable too: the forbidden-Tool failure does not depend on how the Tool was implemented", async () => {
    const forbidden = loadFixture("negative-forbidden-tool");
    const viaAdapter = JSON.parse(JSON.stringify(forbidden).replaceAll("tex.forbidden.notify", "tex.adapter-session.notify").replaceAll("eval.synthetic", "adapter.workflow")) as EvalEvidenceBundle;
    const original = await grade(definition("tool.no-external-send"), forbidden);
    const other = await grade(definition("tool.no-external-send"), viaAdapter);
    expect(semantic(other)).toEqual(semantic(original));
    expect(original.status).toBe("failed");
  });
});

describe("Eval definitions encode canonical AAO semantics only", () => {
  it("the committed definitions name no framework, provider, or protocol construct", () => {
    const source = readFileSync(join(evalsRoot, "definitions", "runtime-foundation.v1.yaml"), "utf8").replace(/^\s*#.*$/gm, "");
    expect(source).not.toMatch(/langgraph|langchain|vercel|generateText|streamText|json-?rpc|tool_calls|tool_use_id|functionCall|openai|anthropic|claude|gpt-|gemini|modelcontextprotocol|\bmcp\b|stategraph|interrupt/i);
  });
});
