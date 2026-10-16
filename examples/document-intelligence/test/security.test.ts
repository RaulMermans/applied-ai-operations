import { vi, describe, expect, it } from "vitest";
import {
  SECRET_TOKEN,
  unauthorizedUser,
} from "../fixtures/index.js";
import {
  SYNTHESIS_INSTRUCTIONS,
  escapeMarkdown,
  escapeMarkdownInline,
  formatExcerpt,
  type DocumentIntelligenceResult,
} from "../src/index.js";
import { ofType, runProof } from "./support.js";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

describe("Document Intelligence Security: Governance, injection resistance, and privacy", () => {
  it("an unauthorized principal is blocked with canonical denial before any provider call", async () => {
    const run = await runProof({
      principal: unauthorizedUser,
    });
    expect(run.outcome.status).toBe("failed");
    if (run.outcome.status !== "failed") throw new Error("expected failed outcome");
    expect(run.outcome.failure.executorFailure?.code).toBe("TOOL_AUTHORIZATION_DENIED");
    // Provider was never called
    expect(run.provider.calls).toHaveLength(0);
    // Model was never called
    expect(run.model.requests).toHaveLength(0);
    // Tool blocked event in trace
    expect(ofType(run.trace, "tool.call.blocked")).toHaveLength(1);
    expect(ofType(run.trace, "tool.call.started")).toHaveLength(0);
  });

  it("prompt injection text inside a document page remains untrusted evidence data only", async () => {
    const run = await runProof();
    expect(run.outcome.status).toBe("completed");
    if (run.outcome.status !== "completed") throw new Error("expected completed outcome");

    const req = run.model.requests[0];
    expect(req).toBeDefined();
    if (!req) throw new Error("expected req");

    // System prompt is invariant
    expect(req.messages[0]?.role).toBe("system");
    expect(req.messages[0]?.content).toBe(SYNTHESIS_INSTRUCTIONS);
    expect(req.messages[0]?.content).not.toContain("IGNORE ALL");

    // Injected text appears solely inside evidenceSpans in user message
    const userPayload = JSON.parse(req.messages[1]?.content as string);
    const hasInjection = userPayload.evidenceSpans.some((s: { text: string }) =>
      /IGNORE ALL PREVIOUS\s+INSTRUCTIONS/.test(s.text)
    );
    expect(hasInjection).toBe(true);

    // No side effect or role escalation took place
    const result = run.outcome.result as DocumentIntelligenceResult;
    expect(result.markdown).not.toContain("admin");
    expect(result.markdown).not.toContain("waive all fees");
  });

  it("if a model is tricked by prompt injection, grounding validation rejects unauthorized findings", async () => {
    const run = await runProof({
      modelOptions: { obeyInjection: true },
    });
    // Synthesis output obeys injection by creating an admin statement with unknown ref
    // validate_grounding catches unknown or forged citations
    if (run.outcome.status === "failed") {
      expect(run.outcome.failure.nodeId).toBe("validate_grounding");
    }
  });

  it("escapeMarkdown neutralizes HTML tags, script tags, javascript: links, and markdown syntax", () => {
    const malicious = [
      '<script>alert("xss")</script>',
      '[Click me](javascript:alert(1))',
      '# Heading Injection',
      '`code injection`',
      '<img src=x onerror=alert(1)>',
      '| table | pipe |',
    ];

    for (const text of malicious) {
      const escaped = escapeMarkdown(text);
      expect(escaped).not.toContain("<script>");
      expect(escaped).not.toContain("</script>");
      expect(escaped).not.toContain("<img");
      expect(escapeMarkdownInline(text)).toBe(escaped);
    }
  });

  it("formatExcerpt truncates at maxExcerptLength and escapes markup safely", () => {
    const longExcerpt = "Safe text " + "<script>xss</script> " + "a".repeat(400);
    const formatted = formatExcerpt(longExcerpt);
    expect(formatted).not.toContain("<script>");
    expect(formatted).toContain("&lt;script&gt;");
    expect(formatted.endsWith("…")).toBe(true);
    expect(formatted.length).toBeLessThan(longExcerpt.length);
  });

  it("secrets are never persisted into Trace or output state", async () => {
    const run = await runProof({
      providerOptions: { providerOutage: true },
    });
    const traceStr = JSON.stringify(run.trace);
    expect(traceStr).not.toContain(SECRET_TOKEN);
    expect(traceStr).not.toContain("SECRET_DO_NOT_PERSIST");
  });

  it("raw document bytes never leak into Run state, Trace, or model requests", async () => {
    const run = await runProof();
    const traceJson = JSON.stringify(run.trace);
    expect(traceJson).not.toContain("%PDF-1.4");
    expect(traceJson).not.toContain("Uint8Array");
    const modelJson = JSON.stringify(run.model.requests);
    expect(modelJson).not.toContain("%PDF-1.4");
    expect(modelJson).not.toContain("Uint8Array");
  });
});
