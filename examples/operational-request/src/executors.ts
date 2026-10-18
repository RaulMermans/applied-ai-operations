import {
  approvalIdForFingerprint,
  fingerprintApprovalSubject,
} from "@aao/approval";
import type {
  DeterministicExecutor,
  DeterministicExecutorContext,
  DeterministicExecutorResult,
  JsonObject,
  JsonValue,
} from "@aao/framework";
import {
  isRecord,
  validateOperationalRequest,
  type OperationalActionProposal,
  type OperationalApprovalSubject,
  type OperationalRequest,
  type OperationalRequestResult,
} from "./contracts.js";
import { buildInterpretModelRequest } from "./model-requests.js";
import { renderOperationalMarkdown } from "./render.js";
import type { CreateChangeDraftToolInput, CreateChangeDraftToolOutput } from "./tool.js";
import { validateOperationalProposal } from "./validation.js";

export const EXECUTOR_VERSION = "1.0.0";

/** Canonical state keys in workflow order. */
export const STATE_KEYS = Object.freeze({
  request: "request",
  normalizedRequest: "normalizedRequest",
  interpretModelRequest: "interpretModelRequest",
  interpretResult: "interpretResult",
  validatedProposal: "validatedProposal",
  approvalSubject: "approvalSubject",
  approvalBinding: "approvalBinding",
  draftToolInput: "draftToolInput",
  draftToolResult: "draftToolResult",
  finalResult: "finalResult",
});

const ok = (statePatch: Record<string, unknown>): DeterministicExecutorResult => ({
  ok: true,
  statePatch: statePatch as JsonObject,
});

const fail = (code: string): DeterministicExecutorResult => ({
  ok: false,
  code,
});

type Values = DeterministicExecutorContext["state"]["values"];

const outputOf = (values: Values, key: string): Record<string, unknown> | undefined => {
  const stored = values[key];
  return isRecord(stored) && isRecord(stored.output) ? stored.output : undefined;
};

function executor(
  id: string,
  execute: (context: DeterministicExecutorContext) => DeterministicExecutorResult | Promise<DeterministicExecutorResult>
): DeterministicExecutor {
  return Object.freeze({
    id,
    version: EXECUTOR_VERSION,
    execute: async (context: DeterministicExecutorContext) => execute(context),
  });
}

/**
 * Node 1: intake
 * Deterministically validates the user's operational request and prepares
 * structured input for the bounded model interpretation node.
 */
export const intake = executor("operational_request.intake", (context) => {
  const checked = validateOperationalRequest(context.state.values[STATE_KEYS.request]);
  if (!checked.ok) {
    return fail(checked.code);
  }

  const normalized = checked.value;
  const modelRequest = buildInterpretModelRequest(context.runId, normalized);

  return ok({
    [STATE_KEYS.normalizedRequest]: normalized as unknown as JsonValue,
    [STATE_KEYS.interpretModelRequest]: modelRequest as unknown as JsonValue,
  });
});

/**
 * Node 3: validate_proposal
 * Deterministically validates the model's action proposal against the
 * operation allowlist, intake context, and security invariants.
 */
export const validateProposal = executor("operational_request.validate_proposal", (context) => {
  const values = context.state.values;
  const normalized = values[STATE_KEYS.normalizedRequest] as unknown as OperationalRequest | undefined;
  if (!normalized) {
    return fail("MISSING_INTAKE_CONTEXT");
  }

  const modelResult = values[STATE_KEYS.interpretResult];
  if (!isRecord(modelResult) || !isRecord(modelResult.output)) {
    return fail("INVALID_MODEL_OUTPUT");
  }

  const rawProposal = modelResult.output;
  const result = validateOperationalProposal(rawProposal, normalized);
  if (!result.ok) {
    return fail(result.code);
  }

  return ok({
    [STATE_KEYS.validatedProposal]: result.proposal as unknown as JsonValue,
  });
});

/**
 * Node 4: build_approval_subject
 * Constructs the canonical `OperationalApprovalSubject`.
 * Trusted deterministic code strictly injects `executionMode: "draft_only"`.
 */
export const buildApprovalSubject = executor("operational_request.build_approval_subject", (context) => {
  const values = context.state.values;
  const normalized = values[STATE_KEYS.normalizedRequest] as unknown as OperationalRequest | undefined;
  const validated = values[STATE_KEYS.validatedProposal] as unknown as OperationalActionProposal | undefined;

  if (!normalized || !validated) {
    return fail("MISSING_PROPOSAL_CONTEXT");
  }

  const subject: OperationalApprovalSubject = {
    schemaVersion: 1,
    requestId: normalized.requestId,
    operation: "account.update_display_name",
    accountId: normalized.accountContext.accountId,
    proposedChanges: {
      displayName: validated.changes.displayName,
    },
    executionMode: "draft_only",
  };

  return ok({
    [STATE_KEYS.approvalSubject]: subject as unknown as JsonValue,
  });
});

/**
 * Node 6: prepare_draft
 * Runs immediately following human approval continuation.
 * Verifies approved subject binding and prepares Tool input for local draft creation.
 */
export const prepareDraft = executor("operational_request.prepare_draft", (context) => {
  const values = context.state.values;
  const normalized = values[STATE_KEYS.normalizedRequest] as unknown as OperationalRequest | undefined;
  const subject = values[STATE_KEYS.approvalSubject] as unknown as OperationalApprovalSubject | undefined;

  if (!normalized || !subject) {
    return fail("MISSING_APPROVAL_SUBJECT");
  }

  // Canonical fingerprint and approval reference computation
  const requestFingerprint = fingerprintApprovalSubject(
    context.runId,
    "require_approval",
    context.state.revision,
    subject
  );
  const approvalId = approvalIdForFingerprint(
    context.runId,
    "require_approval",
    requestFingerprint
  );

  const draftInput: CreateChangeDraftToolInput = {
    requestId: normalized.requestId,
    accountId: subject.accountId,
    operation: subject.operation,
    proposedChanges: {
      displayName: subject.proposedChanges.displayName,
    },
    approvalBinding: {
      approvalId,
      requestFingerprint,
    },
  };

  return ok({
    [STATE_KEYS.approvalBinding]: { approvalId, requestFingerprint } as unknown as JsonValue,
    [STATE_KEYS.draftToolInput]: draftInput as unknown as JsonValue,
  });
});

/**
 * Node 8: render_result
 * Deterministically constructs the final operational result and user-facing Markdown.
 * Explicitly includes the notice that the draft was prepared and no external update occurred.
 */
export const renderResult = executor("operational_request.render_result", (context) => {
  const values = context.state.values;
  const normalized = values[STATE_KEYS.normalizedRequest] as unknown as OperationalRequest | undefined;
  const subject = values[STATE_KEYS.approvalSubject] as unknown as OperationalApprovalSubject | undefined;
  const binding = values[STATE_KEYS.approvalBinding] as unknown as { approvalId: string; requestFingerprint: string } | undefined;
  const toolOutput = outputOf(values, STATE_KEYS.draftToolResult) as unknown as CreateChangeDraftToolOutput | undefined;

  if (!normalized || !subject || !binding || !toolOutput) {
    return fail("MISSING_RESULT_CONTEXT");
  }

  const renderedMarkdown = renderOperationalMarkdown({
    requestId: normalized.requestId,
    operation: subject.operation,
    accountId: subject.accountId,
    displayName: subject.proposedChanges.displayName,
    draftId: toolOutput.draftId,
    approvalId: binding.approvalId,
    draftStatus: toolOutput.status,
    externalExecution: toolOutput.externalExecution,
  });

  const finalResult: OperationalRequestResult = {
    schemaVersion: 1,
    requestId: normalized.requestId,
    operation: subject.operation,
    accountId: subject.accountId,
    draftId: toolOutput.draftId,
    approvalId: binding.approvalId,
    draftStatus: toolOutput.status,
    externalExecution: toolOutput.externalExecution,
    outcome: "completed",
    renderedMarkdown,
  };

  return ok({
    [STATE_KEYS.finalResult]: finalResult as unknown as JsonValue,
  });
});

export const OPERATIONAL_REQUEST_EXECUTORS: readonly DeterministicExecutor[] = Object.freeze([
  intake,
  validateProposal,
  buildApprovalSubject,
  prepareDraft,
  renderResult,
]);
