import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { AgentSpecSchema } from "../src/agent.js";
import { ApprovalRecordSchema } from "../src/approval.js";
import { CapabilitySpecSchema } from "../src/capability.js";
import { CompanyConfigSchema } from "../src/deployment.js";
import { RunRecordSchema } from "../src/run.js";
import { CheckpointRecordSchema } from "../src/state.js";
import { ToolSpecSchema } from "../src/tool.js";
import { TraceEventSchema } from "../src/trace.js";
import { WorkflowSchema } from "../src/workflow.js";
import {
  agentSpecFixture,
  approvalRecordFixture,
  capabilitySpecFixture,
  companyConfigFixture,
  governedOperationalWorkflowFixture,
  minimalWorkflowFixture,
  runRecordFixture,
  toolSpecFixture,
} from "./fixtures.js";

const checkpointFixture = {
  schemaVersion: 1 as const,
  checkpointId: "checkpoint-0001",
  runId: "run-0001",
  stateRevision: 3,
  createdAt: "2026-09-23T12:00:00Z",
  stateSnapshot: {
    runId: "run-0001",
    revision: 3,
    values: { leadScore: 42, tags: ["hot", "enterprise"] },
    capturedAt: "2026-09-23T12:00:00Z",
  },
};

const traceEventFixture = {
  schemaVersion: 1 as const,
  eventId: "trace-event-0001",
  runId: "run-0001",
  sequence: 0,
  occurredAt: "2026-09-23T12:00:00Z",
  type: "run.status_changed",
  payload: { from: "CREATED", to: "VALIDATING" },
};

const cases: Array<[string, ZodType, unknown]> = [
  ["Workflow (minimal)", WorkflowSchema, minimalWorkflowFixture],
  ["Workflow (governed operational)", WorkflowSchema, governedOperationalWorkflowFixture],
  ["RunRecord", RunRecordSchema, runRecordFixture],
  ["CheckpointRecord", CheckpointRecordSchema, checkpointFixture],
  ["AgentSpec", AgentSpecSchema, agentSpecFixture],
  ["ToolSpec", ToolSpecSchema, toolSpecFixture],
  ["CapabilitySpec", CapabilitySpecSchema, capabilitySpecFixture],
  ["ApprovalRecord", ApprovalRecordSchema, approvalRecordFixture],
  ["TraceEvent", TraceEventSchema, traceEventFixture],
  ["CompanyConfig", CompanyConfigSchema, companyConfigFixture],
];

describe("serialization round-trip", () => {
  it.each(cases)("%s survives parse -> JSON.stringify -> JSON.parse -> parse without semantic loss", (_name, schema, fixture) => {
    const parsed = schema.parse(fixture);
    const roundTripped = JSON.parse(JSON.stringify(parsed));
    const reparsed = schema.parse(roundTripped);
    expect(reparsed).toEqual(parsed);
  });
});
