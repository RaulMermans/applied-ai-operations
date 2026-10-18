# Operational Request Proof (`@aao/example-operational-request`)

Sprint 24 proof application for **Applied AI Operations (AAO)**: governed action proposals, human approval, and safe draft execution.

## Invariant

```text
Model proposal
       ≠
Permission grant

Human approval
       ≠
Permission grant

Approved external action
       ≠
Executable external action in AAO V1
```

**No external business system is modified in this proof.**
The executable operation is the staging of a local operational change draft within the host-owned draft repository.

## Operational Scenario

An operator submits a request to update an account display name:
> "Prepare an update to change the display name of account ACME-001 from Acme Analytics to Acme Data Solutions. Submit the proposed change for management approval."

1. **Intake**: Normalizes request and bounds account context.
2. **Model Interpretation**: Single bounded model node (`operational_request.interpret`) infers business intent into a structured proposal.
3. **Deterministic Proposal Validation**: Enforces allowlist (`account.update_display_name`), target account identity matching, and rejects injected metadata or executable code.
4. **Approval Subject**: Sets `executionMode: "draft_only"` and computes exact canonical subject fingerprint.
5. **Human Approval Waitpoint**: Reaches `WAITING_FOR_APPROVAL`. Zero draft tool calls before approval.
6. **Separation of Duties**: Only an eligible human approver in role `operations.approver` may approve. Prohibits self-approval by requester.
7. **Governed Draft Tool**: Resumed execution revalidates authority and invokes `operations.create_change_draft@1.0.0` requiring `write_draft`.
8. **Draft Artifact & Final Result**: Staged locally; final result explicitly notes:
   *The draft was prepared. The external account was not modified.*

## Architecture

```text
Operational Request
        |
        v
Deterministic Intake
        |
        v
Bounded Model Interpretation
        |
        v
Strict Proposal Validation
        |
        v
Canonical Approval Subject
        |
        v
Human Approval Waitpoint
        |
   +----+----+
   |         |
Rejected   Approved
   |         |
   v         v
Terminate  Revalidate Authority
             |
             v
       Governed Draft Tool
             |
             v
       Local Draft Artifact
             |
             v
       Final Operational Result
```

## Running the Demo

```bash
pnpm proof:operational-request
```

## Running the Compiled Smoke

```bash
pnpm --filter @aao/example-operational-request run smoke:sprint24
```
