import {
  demonstrateFrameworkApprovalRestartLimitation,
  runGoldenPath,
  runPackAdoptionJourney,
} from "../src/index.js";

const golden = await runGoldenPath();
const packs = await runPackAdoptionJourney();
const restart = await demonstrateFrameworkApprovalRestartLimitation();

process.stdout.write("AAO Local V1 golden path (simulated / offline fixtures)\n");
process.stdout.write(`${JSON.stringify({ golden, packs, restart }, null, 2)}\n`);
if (
  golden.authorized.status !== "COMPLETED" ||
  golden.denied.executorFailure !== "TOOL_AUTHORIZATION_DENIED" ||
  golden.denied.lookupCalls !== 0 ||
  golden.approval.completedStatus !== "COMPLETED" ||
  golden.approval.draftCalls !== 1 ||
  !golden.evaluation.ok ||
  packs.packCount !== 3 ||
  packs.executedStatus !== "completed" ||
  !packs.demoUnverified ||
  restart.restartedOk ||
  restart.draftCalls !== 0
) {
  throw new Error("release-consumer demo did not satisfy Local V1 golden-path assertions");
}
process.stdout.write("SPRINT_30_GOLDEN_PATH_OK\n");
