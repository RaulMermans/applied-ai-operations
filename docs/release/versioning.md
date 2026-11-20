# Local V1 versioning policy

AAO distinguishes several version identities. They are not interchangeable.

| Identity | What it versions | Compatibility rule |
| --- | --- | --- |
| Repository Local V1 label | The source release candidate | Documented in [release notes](./local-v1-release-notes.md). Not an npm version. |
| npm `package.json` `version` | Unused while packages are `private: true` at `0.0.0` | Do not increment to imply publication. |
| `AAO_FRAMEWORK_API_VERSION` | Public `@aao/framework` value exports | Integer. Adding/removing a root export is deliberate; a breaking change needs an ADR or migration note. |
| `AAO_ADAPTER_CONTRACT_VERSION` | Adapter envelope | Integer. Independent of npm. |
| Tool `id@version` | Exact Tool refs | No `latest`. A spec change is a new version. |
| Capability Pack `id@version` | Pack manifests | Exact SemVer. Workflow `planFingerprint` is pinned. |
| Workflow plan fingerprint | SHA-256 of the compiled plan | Silent graph changes change the fingerprint. |
| Company Manifest `schemaVersion` | `CompanyManifestV1` | Integer schema, not a marketing version. |
| Adapter conformance version | Conformance suite | Reports that are not complete cannot PASS. |
| Eval dataset / baseline versions | Foundation gate | Baselines are human-reviewed and never auto-updated. |

There is no monorepo release-management platform. Changing a public Framework export, a Tool spec, a Pack pin, or an Eval baseline is a reviewed source change in this repository.
