import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalDataset, EvalDefinition } from "@aao/contracts";
import { createEvaluatorRegistry, createStaticEvidenceResolver, deterministicGraders, parseEvalDataset, parseEvalDefinitions, type EvalEvidenceBundle } from "../../src/index.js";

/**
 * Host-side loading for tests. The Evaluation Runtime never reads files:
 * this *host* code maps `fixture://<name>` to `evals/fixtures/<name>.json`
 * explicitly and hands the evaluator an in-memory resolver.
 */
export const evalsRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "evals");

export function loadDefinitions(): EvalDefinition[] {
  const parsed = parseEvalDefinitions(readFileSync(join(evalsRoot, "definitions", "runtime-foundation.v1.yaml"), "utf8"), "yaml");
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

export function loadDataset(): EvalDataset {
  const parsed = parseEvalDataset(readFileSync(join(evalsRoot, "datasets", "runtime-foundation.v1.yaml"), "utf8"), "yaml");
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.value;
}

export function loadFixture(name: string): EvalEvidenceBundle {
  return JSON.parse(readFileSync(join(evalsRoot, "fixtures", `${name}.json`), "utf8")) as EvalEvidenceBundle;
}

export function fixtureResolver() {
  const names = readdirSync(join(evalsRoot, "fixtures")).filter((file) => file.endsWith(".json")).map((file) => file.slice(0, -5));
  return createStaticEvidenceResolver(names.map((name) => [`fixture://${name}`, loadFixture(name)] as const));
}

export function definition(id: string): EvalDefinition {
  const found = loadDefinitions().find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no definition ${id}`);
  return found;
}

export const registry = () => createEvaluatorRegistry(deterministicGraders());
