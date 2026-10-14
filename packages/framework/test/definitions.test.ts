import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSpecSchema, EvalDefinitionSchema, GovernanceConfigurationSchema, ModelPolicySpecSchema, ToolSpecSchema, WorkflowSchema, type AgentSpec, type ModelPolicySpec } from "@aao/contracts";
import { parseEvalDefinitions } from "@aao/evaluation";
import { compileWorkflow } from "@aao/workflow-dsl";
import { AAOFrameworkError, defineAgent, defineEval, defineGovernance, defineModelPolicy, defineTool, defineWorkflow } from "../src/index.js";
import { approvalWorkflowInput, countingTool, governanceInput, toolSpec } from "./support.js";

const repositoryRoot = join(__dirname, "..", "..", "..");

function frameworkError(run: () => unknown): AAOFrameworkError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AAOFrameworkError);
    return error as AAOFrameworkError;
  }
  throw new Error("expected an AAOFrameworkError");
}

const agentInput = (): AgentSpec => ({ schemaVersion: 1, id: "agent.researcher", version: "1.0.0", name: "Researcher", modelPolicyRef: "policy.structured", skillRefs: [], toolRefs: ["crm.lookup"], permissionClasses: ["read_only"] });
const modelPolicyInput = (): ModelPolicySpec => ({ schemaVersion: 1, id: "policy.structured", version: "1.0.0", name: "Structured output", requiredCapabilities: ["structured_output"] });

describe("defineWorkflow → canonical WorkflowSchema", () => {
  it("returns the canonical Workflow, deep-frozen, without compiling or registering anything", () => {
    const input = approvalWorkflowInput();
    const workflow = defineWorkflow(input);
    expect(workflow).toEqual(WorkflowSchema.parse(input));
    expect(Object.isFrozen(workflow) && Object.isFrozen(workflow.nodes) && Object.isFrozen(workflow.nodes[0]!.config)).toBe(true);
    expect(() => { (workflow.nodes as unknown[]).push({}); }).toThrow(TypeError);
  });

  it("is isolated from caller mutation of the input after definition", () => {
    const input = approvalWorkflowInput();
    const workflow = defineWorkflow(input);
    input.nodes[0]!.id = "hijacked";
    (input.nodes[1]!.config as { toolRef: { id: string } }).toolRef.id = "other.tool";
    input.edges.pop();
    expect(workflow).toEqual(WorkflowSchema.parse(approvalWorkflowInput()));
  });

  it("malformed input fails with the canonical schema diagnostics (no stack, node-anchored)", () => {
    const input = approvalWorkflowInput() as unknown as { nodes: Array<{ kind: string }> };
    input.nodes[1]!.kind = "teleport";
    const error = frameworkError(() => defineWorkflow(input as never));
    expect(error.code).toBe("FRAMEWORK_INVALID_DEFINITION");
    expect(error.diagnostics).toEqual([expect.objectContaining({ code: "SCHEMA_VALIDATION_ERROR", path: "nodes.1.kind", nodeId: "draft" })]);
    expect(JSON.stringify(error.diagnostics)).not.toMatch(/\bat\s+\S+\s+\(|node_modules/);
  });

  it("a non-JSON-safe value is refused rather than silently dropped by a copy", () => {
    const input = approvalWorkflowInput();
    (input.nodes[0]!.config as Record<string, unknown>).hook = () => "code";
    expect(frameworkError(() => defineWorkflow(input)).code).toBe("FRAMEWORK_INVALID_DEFINITION");
  });

  it("graph semantics stay with the compiler: an unreachable node defines fine and fails at preparation", () => {
    const input = approvalWorkflowInput();
    input.nodes.push({ id: "orphan", kind: "final_output", config: {} });
    expect(() => defineWorkflow(input)).not.toThrow();
    expect(compileWorkflow(defineWorkflow(input))).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: "UNREACHABLE_NODE" })] });
  });
});

describe("defineTool → canonical ToolSpecSchema + Tool Runtime registration rules", () => {
  it("returns a RegisteredTool-shaped definition: frozen canonical spec, captured handler, metadata unchanged", async () => {
    const input = countingTool("crm.lookup", ["read_only"]);
    const tool = defineTool({ ...input, retrySafety: "safe", idempotency: "execution_id" });
    expect(tool.spec).toEqual(ToolSpecSchema.parse(toolSpec("crm.lookup", ["read_only"])));
    expect(tool).toMatchObject({ retrySafety: "safe", idempotency: "execution_id" });
    expect(Object.isFrozen(tool) && Object.isFrozen(tool.spec) && Object.isFrozen(tool.spec.inputSchema)).toBe(true);
    expect(Object.keys(tool.spec)).not.toContain("handler");
    expect(JSON.stringify(tool.spec)).not.toContain("execute");
    await expect(tool.handler.execute({ toolExecutionId: "x", tool: { id: "crm.lookup", version: "1.0.0" }, input: { account: "a" } })).resolves.toEqual({ ok: true, output: { id: "crm.lookup:a" } });
  });

  it("is isolated from caller mutation of the spec and the handler after definition", async () => {
    const input = countingTool("crm.draft");
    const tool = defineTool(input);
    input.spec.permissionClasses.push("external_side_effect");
    (input.spec.inputSchema as Record<string, unknown>).type = "string";
    input.handler.execute = async () => ({ ok: true, output: { id: "hijacked" } });
    expect(tool.spec.permissionClasses).toEqual(["write_draft"]);
    expect(tool.spec.inputSchema).toMatchObject({ type: "object" });
    await expect(tool.handler.execute({ toolExecutionId: "x", tool: { id: "crm.draft", version: "1.0.0" }, input: { account: "a" } })).resolves.toEqual({ ok: true, output: { id: "crm.draft:a" } });
  });

  it("invalid specs and registration metadata fail exactly as Tool Runtime registration would", () => {
    const invalid = (mutate: (input: ReturnType<typeof countingTool>) => void) => {
      const input = countingTool("crm.draft");
      mutate(input);
      return frameworkError(() => defineTool(input));
    };
    expect(invalid((input) => { delete (input.spec as Partial<typeof input.spec>).name; }).diagnostics).toEqual([expect.objectContaining({ code: "SCHEMA_VALIDATION_ERROR", path: "name" })]);
    expect(invalid((input) => { (input.spec as unknown as Record<string, unknown>).apiKey = "sk-live-123"; }).code).toBe("FRAMEWORK_INVALID_DEFINITION");
    expect(invalid((input) => { (input as { retrySafety?: string }).retrySafety = "safe"; }).message).toMatch(/retrySafety "safe" only when every permission class is read_only/);
    expect(invalid((input) => { (input as { idempotency?: string }).idempotency = "magic"; }).message).toMatch(/invalid idempotency/);
    expect(invalid((input) => { input.spec.inputSchema = { type: "object", $ref: "#/elsewhere" }; }).message).toMatch(/unsupported inputSchema/);
    expect(invalid((input) => { (input as { handler?: unknown }).handler = { run: () => undefined }; }).message).toMatch(/handler\.execute/);
  });

  it("defining an unsupported-permission Tool is allowed (registered ≠ supported); execution still refuses it", () => {
    expect(() => defineTool(countingTool("mail.send", ["external_side_effect"]))).not.toThrow();
  });
});

describe("defineGovernance → canonical GovernanceConfigurationSchema + registry referential checks", () => {
  it("returns the canonical configuration, deep-frozen and isolated from the input", () => {
    const input = governanceInput();
    const governance = defineGovernance(input);
    expect(governance).toEqual(GovernanceConfigurationSchema.parse(governanceInput()));
    input.bindings[2]!.roleId = "operator";
    input.roles[2]!.permissionClasses.push("write_draft");
    expect(governance).toEqual(GovernanceConfigurationSchema.parse(governanceInput()));
    expect(Object.isFrozen(governance.roles[2]!.permissionClasses)).toBe(true);
  });

  it("schema and referential errors are bounded definition errors", () => {
    const badClass = governanceInput();
    (badClass.roles[0]!.permissionClasses as string[]).push("root");
    expect(frameworkError(() => defineGovernance(badClass)).diagnostics[0]).toMatchObject({ code: "SCHEMA_VALIDATION_ERROR", path: "roles.0.permissionClasses.5" });
    const unknownRole = governanceInput();
    unknownRole.bindings[0]!.roleId = "ghost";
    expect(frameworkError(() => defineGovernance(unknownRole)).message).toContain("INVALID_GOVERNANCE_CONFIGURATION: unknown binding reference");
    const duplicate = governanceInput();
    duplicate.actors.push({ ...duplicate.actors[0]! });
    expect(frameworkError(() => defineGovernance(duplicate)).message).toContain("duplicate actor ID");
  });
});

describe("defineEval → canonical EvalDefinitionSchema", () => {
  const definitions = parseEvalDefinitions(readFileSync(join(repositoryRoot, "evals", "definitions", "runtime-foundation.v1.yaml"), "utf8"), "yaml");
  if (!definitions.ok) throw new Error("fixture definitions are invalid");
  const sample = () => JSON.parse(JSON.stringify(definitions.value[0])) as (typeof definitions.value)[number];

  it("returns the canonical definition, deep-frozen and isolated", () => {
    const input = sample();
    const definition = defineEval(input);
    expect(definition).toEqual(EvalDefinitionSchema.parse(sample()));
    input.graderRef.version = "9.9.9";
    expect(definition.graderRef.version).toBe(sample().graderRef.version);
    expect(Object.isFrozen(definition.graderRef)).toBe(true);
  });

  it("rejects an invalid Eval definition", () => {
    const input = sample() as unknown as Record<string, unknown>;
    delete input.graderRef;
    expect(frameworkError(() => defineEval(input as never)).code).toBe("FRAMEWORK_INVALID_DEFINITION");
    expect(frameworkError(() => defineEval({ ...sample(), loader: "./plugin.js" } as never)).code).toBe("FRAMEWORK_INVALID_DEFINITION");
  });
});

describe("defineAgent / defineModelPolicy → canonical AgentSpecSchema / ModelPolicySpecSchema (declarative only)", () => {
  it("return canonical specs, deep-frozen and isolated", () => {
    const agent = agentInput();
    const policy = modelPolicyInput();
    const definedAgent = defineAgent(agent);
    const definedPolicy = defineModelPolicy(policy);
    expect(definedAgent).toEqual(AgentSpecSchema.parse(agentInput()));
    expect(definedPolicy).toEqual(ModelPolicySpecSchema.parse(modelPolicyInput()));
    agent.permissionClasses.push("destructive");
    policy.requiredCapabilities!.push("vision");
    expect(definedAgent.permissionClasses).toEqual(["read_only"]);
    expect(definedPolicy.requiredCapabilities).toEqual(["structured_output"]);
  });

  it("reject invalid specs and credential fields (strict canonical schemas)", () => {
    expect(frameworkError(() => defineAgent({ ...agentInput(), permissionClasses: [] })).code).toBe("FRAMEWORK_INVALID_DEFINITION");
    expect(frameworkError(() => defineAgent({ ...agentInput(), credentials: { token: "t" } } as never)).code).toBe("FRAMEWORK_INVALID_DEFINITION");
    expect(frameworkError(() => defineModelPolicy({ ...modelPolicyInput(), provider: "openai", apiKey: "sk-123" } as never)).code).toBe("FRAMEWORK_INVALID_DEFINITION");
  });
});
