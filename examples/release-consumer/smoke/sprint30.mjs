import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runSecurityRegressionSuite, SECURITY_CASES } from "@aao/example-security-hardening";
import {
  demonstrateFrameworkApprovalRestartLimitation,
  runGoldenPath,
  runPackAdoptionJourney,
} from "../dist/src/index.js";
import { assertPackInventory, inspectReleasePacks } from "../../../scripts/pack-inventory.mjs";
import { REQUIRED_HELP_FRAGMENTS, assertDocumentedCommands } from "../../../scripts/documented-commands.mjs";

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const here = dirname(fileURLToPath(import.meta.url));
const exampleRoot = join(here, "..");
const repositoryRoot = join(exampleRoot, "..", "..");

process.stdout.write("Fresh Supported Installation → checking Node/pnpm engines\n");
const engines = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).engines.node;
assert(engines === ">=20.20.0 <21.0.0", `unexpected engines.node: ${engines}`);
const nodeMajor = Number(process.versions.node.split(".")[0]);
assert(nodeMajor === 20, `Local V1 requires Node 20, got ${process.version}`);
process.stdout.write("ok  Fresh Supported Installation → Success\n");

process.stdout.write("Public Framework Import → Success\n");
const framework = await import("@aao/framework");
assert(typeof framework.createAAO === "function" && framework.AAO_FRAMEWORK_API_VERSION === 1, "framework import failed");
process.stdout.write("ok  Public Framework Import → Success\n");

const golden = await runGoldenPath();
assert(golden.authorized.status === "COMPLETED" && golden.authorized.lookupCalls === 1, "authorized lookup failed");
process.stdout.write("ok  Authorized Read-Only Workflow → Completed\n");
assert(golden.denied.executorFailure === "TOOL_AUTHORIZATION_DENIED" && golden.denied.lookupCalls === 0, "unauthorized path leaked handler calls");
process.stdout.write("ok  Unauthorized Workflow → Refused → Zero Tool Handler Calls\n");
assert(
  golden.approval.waitingStatus === "WAITING_FOR_APPROVAL" &&
    golden.approval.draftCallsWhileWaiting === 0 &&
    golden.approval.completedStatus === "COMPLETED" &&
    golden.approval.draftCalls === 1,
  "approval-gated draft path failed",
);
process.stdout.write("ok  Approval-Gated Draft → Waits → Approved by Eligible Principal → Exactly One Draft\n");

const packs = await runPackAdoptionJourney();
assert(packs.packCount === 3 && packs.northstarCompatible && packs.arborCompatible && packs.executedStatus === "completed", "pack adoption failed");
assert(packs.demoUnverified && packs.missingEvidenceStatus === "NOT_VERIFIED" && packs.verifiedEvidenceStatus === "COMPATIBLE", "demo NOT_VERIFIED vs verified evidence distinction failed");
process.stdout.write("ok  Capability Pack Adoption → Verified Against Actual Registrations\n");

assert(golden.evidence.inspectionStatus === "COMPLETED" && golden.evidence.inspectionStatusSource === "authoritative_runtime", "run inspection missing canonical evidence");
assert(golden.evidence.missingStatus === "UNKNOWN", "missing evidence must stay UNKNOWN");
process.stdout.write("ok  Known Run Inspection → Canonical Evidence Displayed\n");

const evalCi = spawnSync(process.execPath, [join(repositoryRoot, "packages/framework/dist/cli/main.js"), "eval", "ci"], { cwd: repositoryRoot, encoding: "utf8" });
assert(evalCi.status === 0 && evalCi.stdout.trimEnd().endsWith("PASS"), `Foundation Eval gate failed: ${evalCi.stdout}${evalCi.stderr}`);
process.stdout.write("ok  Foundation Eval Gate → PASS\n");

assert(SECURITY_CASES.length >= 40, `security suite too small: ${SECURITY_CASES.length}`);
const security = await runSecurityRegressionSuite();
assert(security.every((result) => result.passed), `security regressions failed: ${security.filter((r) => !r.passed).map((r) => r.id).join(", ")}`);
process.stdout.write("ok  Security Regression Suite → PASS\n");

assertPackInventory(inspectReleasePacks(repositoryRoot));
process.stdout.write("ok  Packed Package Inventory → No Sensitive/Unexpected Files\n");

const documented = assertDocumentedCommands(repositoryRoot);
assert(documented.missing.length === 0, `missing scripts: ${documented.missing.join(", ")}`);
assert(documented.undocumented.length === 0, `undocumented scripts: ${documented.undocumented.join(", ")}`);
const help = spawnSync(process.execPath, [join(repositoryRoot, "packages/framework/dist/cli/main.js"), "--help"], { cwd: repositoryRoot, encoding: "utf8" });
for (const fragment of REQUIRED_HELP_FRAGMENTS) assert(help.stdout.includes(fragment), `CLI help missing ${fragment}`);
process.stdout.write("ok  Documented Commands → Match Real Commands\n");

const restart = await demonstrateFrameworkApprovalRestartLimitation();
assert(restart.restartedOk === false && restart.restartedFailure === "INVALID_APPROVAL_CONTEXT" && restart.draftCalls === 0, "approval restart limitation is not fail-closed");

const consumerDir = mkdtempSync(join(tmpdir(), "aao-release-consumer-"));
try {
  const frameworkEntry = join(repositoryRoot, "packages/framework/dist/index.js");
  writeFileSync(
    join(consumerDir, "app.mjs"),
    `import { createAAO, defineGovernance, defineTool, defineWorkflow } from ${JSON.stringify(pathToFileURL(frameworkEntry).href)};
const calls = { n: 0 };
const tool = defineTool({
  spec: { schemaVersion: 1, id: "ext.lookup", version: "1.0.0", name: "Lookup", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, outputSchema: { type: "object", properties: { matches: { type: "array" } }, required: ["matches"] }, permissionClasses: ["read_only"] },
  handler: { async execute({ input }) { calls.n += 1; return { ok: true, output: { matches: [input.query] } }; } },
});
const governance = defineGovernance({ actors: [{ id: "user.ext", type: "user" }], roles: [{ id: "analyst", version: "1.0.0", permissionClasses: ["read_only"] }], bindings: [{ id: "ext.analyst", actorId: "user.ext", roleId: "analyst", status: "active" }], policies: [] });
const app = createAAO({ governance, principalForRun: () => ({ id: "user.ext", type: "user" }), tools: [tool] });
const wf = defineWorkflow({ schemaVersion: 1, id: "ext.lookup", version: "1.0.0", name: "Lookup", entryNodeId: "search", nodes: [{ id: "search", kind: "tool", config: { toolRef: { id: "ext.lookup", version: "1.0.0" }, inputStateKey: "request", resultStateKey: "accounts" } }, { id: "done", kind: "final_output", config: {} }], edges: [{ sourceNodeId: "search", targetNodeId: "done" }] });
const result = await app.prepareWorkflow(wf).execute({ runId: "run.ext", initialState: { runId: "run.ext", revision: 0, values: { request: { query: "Acme" } } } });
if (!result.ok || result.execution.run.status !== "COMPLETED" || calls.n !== 1) throw new Error("external consumer failed");
process.stdout.write("EXTERNAL_CONSUMER_OK\\n");
`,
  );
  const external = spawnSync(process.execPath, [join(consumerDir, "app.mjs")], { encoding: "utf8", cwd: consumerDir });
  assert(external.status === 0 && external.stdout.includes("EXTERNAL_CONSUMER_OK"), `independent consumer failed: ${external.stdout}${external.stderr}`);
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
}

const packDir = mkdtempSync(join(tmpdir(), "aao-framework-pack-"));
let standaloneResolved;
try {
  execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: join(repositoryRoot, "packages/framework"), stdio: "pipe" });
  const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  execFileSync("tar", ["-xzf", tarball], { cwd: packDir });
  const isolated = spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./package/dist/index.js')"], { cwd: packDir, encoding: "utf8" });
  standaloneResolved = isolated.status === 0;
} catch {
  standaloneResolved = false;
} finally {
  rmSync(packDir, { recursive: true, force: true });
}
assert(standaloneResolved === false, "unexpected: packed @aao/framework resolved without workspace packages; update the Local V1 distribution contract");
process.stdout.write("ok  Packed standalone npm install is NOT supported (workspace:*); source-checkout consumer is the Local V1 path\n");

process.stdout.write("SPRINT_30_LOCAL_V1_RELEASE_SMOKE_OK\n");
