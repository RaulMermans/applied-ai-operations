# Local V1 benchmark results

**These numbers are a labeled reference, not a universal performance claim.** Re-run `pnpm benchmark:local-v1` on your machine. CI does not fail on latency.

## Methodology

- Timer: `process.hrtime.bigint()` (monotonic)
- Default warmup: 2; samples: 12 (this reference used warmup 1 / samples 4 for a tight local capture; re-run with defaults for your report)
- Percentiles: nearest-rank on the sample set
- Fake in-process model adapter only
- Single OS process

## Reference run

| Field | Value |
| --- | --- |
| branch | `sprint-30-local-v1` |
| sourceCommit | recorded at qualification (`git rev-parse HEAD`) |
| node | v20.20.2 |
| pnpm | 10.26.0 |
| os / arch | Linux x64 |
| cpu | AMD RYZEN AI MAX+ 395 w/ Radeon 8060S (32 logical) |

Observed p50 (ms), same machine, warmup 1 / n=4:

| Scenario | p50 | Notes |
| --- | --- | --- |
| A validation | 0.06 | graph semantics |
| A compilation | 0.02 | valid lookup workflow |
| A invalid rejection | 0.007 | |
| B governed read-only Run | 1.86 | handler mean ~0.001 ms; AAO overhead dominates |
| B authorization denial | 1.12 | refusal correctness 1.0 |
| C fake-adapter model workflow | 13.99 | **not** provider inference |
| D approval wait + continue | 3.63 | excludes human time; duplicate continue did not succeed |
| D rejection | 2.83 | |
| E filesystem checkpoint + resume | 7.94 | one host |
| F trace + metrics + inspection | 5.09 | |
| G pack manifest / compatibility | 0.06 / 0.04 | missing tools refused |
| H concurrency 1/4/8 | ~374–386 runs/s | single process; not distributed scale |

Heap used moved from ~21 MiB to ~41 MiB over the suite (RSS ~109 MiB at end). Do not treat this as a capacity plan.

Interpretive limits: not provider inference; not distributed scale; Approval numbers exclude human think time; memory is `process.memoryUsage()` samples.
