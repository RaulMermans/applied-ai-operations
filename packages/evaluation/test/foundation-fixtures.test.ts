import { describe, expect, it } from "vitest";
import { validateTrace } from "@aao/observability";
import { EvalEvidenceBundleSchema } from "../src/index.js";
import { buildFoundationFixtures } from "./support/fixture-builders.js";
import { APPROVAL_SUBJECT_SECRET, TOOL_OUTPUT_SECRET } from "./support/world.js";

/**
 * The committed foundation evidence under `evals/fixtures/`, regenerated
 * deterministically on every run and compared with the committed files
 * (dataset definitions stay separate from evidence). Real Runs supply the
 * positive evidence; the recorder validates every synthetic negative.
 */
describe("foundation evidence fixtures", () => {
  it("are deterministic, schema-valid, sanitized where Trace/Audit are concerned, and match the committed files", async () => {
    const fixtures = await buildFoundationFixtures();
    expect(await buildFoundationFixtures()).toEqual(fixtures);
    for (const [name, bundle] of Object.entries(fixtures)) {
      expect(EvalEvidenceBundleSchema.safeParse(bundle).success, name).toBe(true);
      if (bundle.trace && name !== "corrupt-trace-gap") expect(validateTrace(bundle.trace), name).toEqual({ valid: true, issues: [] });
      // Trace and Audit are metadata-only: Tool output and the Approval subject never reach them.
      expect(JSON.stringify([bundle.trace ?? [], bundle.audit ?? [], bundle.metrics ?? null]), name).not.toMatch(new RegExp(`${TOOL_OUTPUT_SECRET}|${APPROVAL_SUBJECT_SECRET}`));
      await expect(`${JSON.stringify(bundle, null, 2)}\n`).toMatchFileSnapshot(`../../../evals/fixtures/${name}.json`);
    }
    expect(validateTrace(fixtures["corrupt-trace-gap"]!.trace!).valid).toBe(false);
  });
});
