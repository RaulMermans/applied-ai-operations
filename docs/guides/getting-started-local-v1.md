# Getting started with AAO Local V1

This is the first-time path for a developer who has not worked on Applied AI Operations (AAO). It is simulated and offline: no API keys, hosted models, MCP servers, databases, Docker, or identity providers.

## What AAO is

AAO is a TypeScript runtime for **governed business workflows**. Workflows own the operation. Models may propose. Deterministic AAO code owns validation, permissions, human Approval, state transitions, and whether any Tool runs.

> Workflows control the operation. Agents handle uncertainty. Tools perform capabilities. Policies control authority.

## Who should use it

Teams that need AI inside an operation **without** giving a model the authority to act. If you want an autonomous agent loop with unrestricted tools, AAO is the wrong product.

## What problem it solves

A model SDK will call a provider. An agent framework will loop until the model stops. Neither, by itself, proves that:

- the acting principal was attested by the host;
- the Tool was authorized before its handler ran;
- a human approved the **exact** proposal;
- an unauthorized caller caused **zero** handler executions;
- the evidence you inspect is canonical Runtime/Trace/Audit data, not a reconstructed story.

## What the Framework is responsible for

`@aao/framework` validates canonical contracts (`defineWorkflow`, `defineTool`, `defineGovernance`, …), compiles Workflows, and executes them through existing AAO Core (Runtime, Tool Runtime, Governance, Authorization, Approval). Identity comes only from the host's `principalForRun` (or, for company proofs, the hardened `trustedIdentity` path).

## What remains with the host

- Authentication and session mapping (`principalForRun` or minted `AttestedActor`s).
- Registering Tools, model adapters, and integration providers.
- Durable storage roots, if you use `@aao/durability`.
- Any real network, CRM, or ERP system. Local V1 draft Tools write local drafts only.

Base `createAAO()` is **not** an authentication provider. The Sprint 29 company-host hardening does not automatically apply to every `createAAO()` app.

## Supported versions

- Node.js `>=20.20.0 <21.0.0` (see `.nvmrc`)
- pnpm `10.26.0` (`packageManager` in the root `package.json`)

## Installation (source distribution)

Local V1 is **source-distributable**, not published to npm.

```sh
git clone https://github.com/RaulMermans/applied-ai-operations.git
cd applied-ai-operations
nvm use   # Node 20
pnpm install --frozen-lockfile
pnpm build
```

Verify the repository:

```sh
pnpm check
```

That runs typecheck, lint, tests, the Foundation Eval gate, and adapter conformance.

## First Workflow (golden path)

The golden path lives in `examples/release-consumer` and uses deterministic local fixtures:

```text
Developer Request
       │
       ▼
Define Workflow
       │
       ▼
Register Capabilities
       │
       ▼
Configure Governance
       │
       ▼
Prepare Workflow
       │
       ▼
Run
       │
       ▼
Inspect Evidence
       │
       ▼
Evaluate
```

Run it:

```sh
pnpm --filter @aao/example-release-consumer proof
```

Or copy the Framework-only example in [docs/framework/quickstart.md](../framework/quickstart.md). The first example is **offline/simulated**.

### Tool registration and Governance

Register Tools with `defineTool` and pass them to `createAAO({ tools })`. Governance is `defineGovernance` (actors, roles, bindings, deny policies). Authorization is evaluated inside `executeTool`. An unauthorized principal produces `TOOL_AUTHORIZATION_DENIED` and **zero** handler calls.

### Model integration

Optional. Register `defineModelAdapter` plus a binding and a model policy. Local V1 examples use in-process fake adapters. Do not treat those latencies as provider inference.

### Human Approval

An `approval` node waits. Only an eligible human principal may `approve`. Self-approval is refused. Continuation of a waiting Framework Run after a full process restart fails closed because Framework Approvals are in memory. See [limitations](../release/local-v1-limitations.md).

### Evaluation

```sh
pnpm eval:ci
pnpm eval:adapters
```

Both are offline. `pnpm eval:ci` is the Foundation gate against the approved baseline.

### Control Center inspection

```sh
pnpm proof:operator-inspection
pnpm aao inspect overview
```

The local Control Center is GET-only and loopback-restricted. Default data is demo data (`NOT_VERIFIED` pack bindings are expected until the host supplies trusted registration evidence).

## Capability Packs

See [Using Capability Packs](./use-capability-packs.md). The adoption path is: choose company → choose pack → inspect requirements → configure trusted capabilities → verify compatibility against **actual registrations** → execute the existing Workflow → inspect → evaluate. No Workflow forks.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `pnpm` refuses the Node version | Use Node 20 (`nvm use`); engines are `>=20.20.0 <21.0.0` |
| `@aao/framework` cannot be installed from npm | Expected. Local V1 is a source checkout; packages stay `private` with `workspace:*` |
| Control Center pack shows `NOT_VERIFIED` | Demo source has no trusted proof-registration evidence. That is not a Runtime failure |
| Approval continuation fails after restart | Documented limitation of `createAAO()` in-memory Approvals |
| Handler ran on a denied principal | File a security report; that would be a product defect |

## Security limitations

Read [SECURITY.md](../../SECURITY.md) and [Local V1 limitations](../release/local-v1-limitations.md). Local V1 does not protect against a compromised host, remote Control Center access, or exactly-once external effects.

## Other commands

```sh
pnpm proof:company-research
pnpm proof:document-intelligence
pnpm proof:operational-request
pnpm proof:company-portability
pnpm proof:capability-packs
pnpm proof:security-hardening
pnpm benchmark:local-v1
pnpm release:verify:local-v1
```
