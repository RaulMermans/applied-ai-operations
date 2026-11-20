import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureEnvironment } from "./environment.mjs";
import { runScenarios } from "../scenarios/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const warmup = Number(process.env.AAO_BENCH_WARMUP ?? 2);
const samples = Number(process.env.AAO_BENCH_SAMPLES ?? 12);

const started = new Date().toISOString();
const environment = captureEnvironment(root);
const heapAtStart = process.memoryUsage();
const scenarios = await runScenarios({ warmup, samples });
const heapAtEnd = process.memoryUsage();

const report = {
  schemaVersion: 1,
  benchmarkSuite: "aao.local-v1",
  sourceCommit: environment.sourceCommit,
  generatedAt: started,
  environment,
  methodology: {
    timer: "process.hrtime.bigint",
    warmup,
    samples,
    note: "Descriptive measurements on this machine. Not CI pass/fail thresholds. Fake model adapters only.",
  },
  memory: { heapUsedStart: heapAtStart.heapUsed, heapUsedEnd: heapAtEnd.heapUsed, rssEnd: heapAtEnd.rss },
  scenarios,
  limitations: [
    "Offline fixtures and in-process fake model adapters only.",
    "Single-process concurrency is not distributed scalability.",
    "Approval measurements exclude human decision time.",
    "Numbers are not a claim about OpenAI, Anthropic, or GPU inference latency.",
  ],
};

const outDir = join(root, "benchmarks/local-v1/out");
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `local-v1-${environment.sourceCommit?.slice(0, 12) ?? "unknown"}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`AAO_LOCAL_V1_BENCHMARK_OK ${outFile}\n`);
