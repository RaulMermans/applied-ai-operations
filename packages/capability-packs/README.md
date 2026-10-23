# @aao/capability-packs

Declarative, versioned contracts and non-authoritative catalog for Applied AI Operations (AAO) Capability Packs and reusable business templates.

## Principles

1. **Deterministic composition**: A Capability Pack is a versioned metadata and dependency specification for an existing executable capability.
2. **Zero new execution engine**: Capability Packs execute strictly through existing AAO Framework and Tool Runtime infrastructure.
3. **Metadata is not authority**: Declaring a permission or approval requirement in a pack manifest does not authorize execution; canonical Governance, Tool Runtime Authorization, and Approval Engine remain authoritative.
4. **Exact identity**: All pack IDs, versions, tool refs, model policies, and workflow plan fingerprints are pinned to exact SemVer and SHA-256 hashes.
