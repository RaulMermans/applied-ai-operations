// `pnpm proof:company-research`: the deterministic fixture demo. It runs
// the full Company Research Workflow against the fixture public-web
// provider and the scripted model, from compiled output. No credentials, no
// network, no provider or plugin loading.
import process from "node:process";
import { ACME_REQUEST, createFixtureProof } from "../fixtures/index.js";

const { proof, provider, model } = createFixtureProof();
const outcome = await proof.run({ runId: "proof.company-research", request: ACME_REQUEST });
if (outcome.status !== "completed") {
  process.stderr.write(`Company Research proof failed: ${JSON.stringify(outcome.failure)}\n`);
  process.exit(1);
}
const { result } = outcome;
process.stdout.write(`${result.markdown}\n`);
process.stdout.write(
  `${JSON.stringify({
    workflow: `${proof.workflow.id}@${proof.workflow.version}`,
    planFingerprint: proof.planFingerprint.slice(0, 12),
    modelCalls: model.requests.length,
    providerCalls: { search: provider.calls.search.length, fetch: provider.calls.fetch.length },
    coverage: result.coverage,
    evidencePartial: result.evidence.partial,
    mode: "fixture (deterministic, no network)",
  })}\n`,
);
