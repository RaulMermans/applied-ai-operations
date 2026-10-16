// `pnpm proof:document-intelligence`: the deterministic fixture demo. It runs
// the full Document Intelligence Workflow against the fixture document
// provider and scripted model, from compiled output. No credentials, no
// network, no external services.
import process from "node:process";
import { ACME_DOCUMENT_REF, SAMPLE_QUESTIONS, createFixtureProof } from "../fixtures/index.js";

const { proof, provider, model } = createFixtureProof();
const outcome = await proof.run({
  runId: "proof.document-intelligence",
  request: {
    documentRef: ACME_DOCUMENT_REF,
    questions: SAMPLE_QUESTIONS,
  },
});

if (outcome.status !== "completed") {
  process.stderr.write(`Document Intelligence proof failed: ${JSON.stringify(outcome.failure)}\n`);
  process.exit(1);
}

const { result } = outcome;
process.stdout.write(`${result.markdown}\n`);
process.stdout.write(
  `${JSON.stringify({
    workflow: `${proof.workflow.id}@${proof.workflow.version}`,
    planFingerprint: proof.planFingerprint.slice(0, 12),
    modelCalls: model.requests.length,
    providerCalls: provider.calls.length,
    coverage: result.coverage,
    extractionPartial: result.extraction.partial,
    mode: "fixture (deterministic, no network)",
  })}\n`
);
