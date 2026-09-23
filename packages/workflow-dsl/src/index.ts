// @aao/workflow-dsl — parses, schema-validates, semantically validates, and
// compiles AAO Workflow definitions authored as YAML or JSON. See
// docs/architecture/workflow-dsl.md and ADR-008 for the pipeline this
// package implements. Consumes @aao/contracts as the canonical schema
// source of truth; does not duplicate it, execute workflows, or depend on
// any runtime framework.

export type {
  WorkflowSourceFormat,
  WorkflowDiagnosticCode,
  WorkflowDiagnostic,
  WorkflowParseResult,
  WorkflowCompileResult,
  CompiledWorkflowPlan,
} from "./types.js";

export { WORKFLOW_DIAGNOSTIC_CODES } from "./diagnostics.js";
export { parseWorkflowSource } from "./parser.js";
export { validateWorkflowSemantics } from "./semantic-validator.js";
export { compileWorkflow, compileWorkflowSource } from "./compiler.js";
