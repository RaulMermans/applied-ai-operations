/**
 * Framework errors cover *preparation and composition* only: an invalid
 * definition, a Workflow that does not compile, an invalid host
 * configuration, a missing identity boundary, or a node kind the stable
 * surface does not execute yet. Once execution begins, the canonical
 * `WorkflowExecutionResult` is the result — Runtime, Tool, Authorization,
 * and Approval failures are never rewrapped here.
 */
export type AAOFrameworkErrorCode =
  | "FRAMEWORK_INVALID_DEFINITION"
  | "FRAMEWORK_WORKFLOW_COMPILE_FAILED"
  | "FRAMEWORK_INVALID_CONFIGURATION"
  | "FRAMEWORK_PRINCIPAL_UNAVAILABLE"
  | "FRAMEWORK_FEATURE_NOT_AVAILABLE";

/**
 * A bounded, JSON-safe diagnostic. Workflow compile failures carry the
 * compiler's canonical `WorkflowDiagnostic`s unchanged (same `code`,
 * `path`, `nodeId`, `edgeIndex`); other definitions report their canonical
 * schema issues the same way.
 */
export interface AAOFrameworkDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edgeIndex?: number;
}

const MAX_DIAGNOSTICS = 50;
const MAX_TEXT = 300;
const bound = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text);

export class AAOFrameworkError extends Error {
  readonly code: AAOFrameworkErrorCode;
  readonly diagnostics: readonly AAOFrameworkDiagnostic[];

  constructor(code: AAOFrameworkErrorCode, message: string, diagnostics: readonly AAOFrameworkDiagnostic[] = []) {
    super(`${code}: ${bound(message)}`);
    this.name = "AAOFrameworkError";
    this.code = code;
    this.diagnostics = Object.freeze(
      diagnostics.slice(0, MAX_DIAGNOSTICS).map((diagnostic) =>
        Object.freeze({
          code: diagnostic.code,
          message: bound(diagnostic.message),
          ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
          ...(diagnostic.nodeId !== undefined ? { nodeId: diagnostic.nodeId } : {}),
          ...(diagnostic.edgeIndex !== undefined ? { edgeIndex: diagnostic.edgeIndex } : {}),
        }),
      ),
    );
  }
}
