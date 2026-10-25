import process from "node:process";
import {
  createCanonicalDemoInspectionSource,
  createOperatorInspectionService,
  formatCompaniesText,
  formatEvaluationsText,
  formatOverviewText,
  formatPacksText,
  formatRunInspectionText,
  formatRunsText,
  formatWorkflowsText,
} from "@aao/operator-inspection";

async function main(): Promise<void> {
  process.stdout.write("=== Sprint 27: Operator Inspection Demo (offline, read-only, fixture evidence) ===\n\n");
  const service = createOperatorInspectionService(await createCanonicalDemoInspectionSource());
  process.stdout.write(formatOverviewText(await service.getOverview()) + "\n");
  process.stdout.write(formatCompaniesText(await service.listCompanies()) + "\n");
  process.stdout.write(formatPacksText(await service.listCapabilityPacks()) + "\n");
  process.stdout.write(formatWorkflowsText(await service.listWorkflows()) + "\n");
  process.stdout.write(formatRunsText(await service.listKnownRuns()) + "\n");
  process.stdout.write(formatRunInspectionText(await service.getRunInspection("run.arbor.cr.incomplete")) + "\n");
  process.stdout.write(formatEvaluationsText(await service.listKnownEvaluationResults()) + "\n");
  process.stdout.write("Demo completed successfully (no execution, approval, or write occurred).\n");
}

main().catch((err) => {
  process.stderr.write(`Demo failed: ${String(err)}\n`);
  process.exit(1);
});
