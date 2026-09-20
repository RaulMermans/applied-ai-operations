# ADR-005: Local-first TypeScript architecture

Status: accepted

## Context

AAO needs rapid, evidence-led engineering without prematurely selecting a deployment or cloud operating model.

## Decision

AAO uses TypeScript as its current baseline and remains local-first. The development shape is Local Control Center → Local Control Plane → Local AAO Runtime / Worker → Local persistence, with external models, APIs, and MCP used only when intentionally exercised. No deployment target has been selected.

## Consequences

Do not configure Vercel, introduce serverless assumptions, provision cloud infrastructure, or adopt hosted dependencies merely for convenience. Infrastructure is introduced only after a demonstrated requirement, while contracts remain portable enough to support a later deployment decision.
