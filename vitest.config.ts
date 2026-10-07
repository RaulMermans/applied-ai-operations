import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Workspace packages resolve each other via `package.json` "main" (pointing
 * at compiled `dist/` output) once installed — that's why CI builds before
 * testing. Vitest itself has no reason to depend on a prior build: aliasing
 * each `@aao/*` package straight to its TypeScript source lets the canonical
 * operator command (`pnpm install --frozen-lockfile && pnpm test`) succeed
 * on a clean checkout with no undocumented manual build step first, and it
 * always exercises current source rather than a possibly stale `dist/`.
 * `pnpm build` and every package's "main"/"types" fields are unaffected —
 * this alias applies only inside the Vitest/Vite module graph. `pnpm check`
 * remains the full verification path (typecheck, lint, build, test).
 */
function workspaceSourceAlias(packageName: string, relativeEntry: string) {
  return { find: packageName, replacement: fileURLToPath(new URL(relativeEntry, import.meta.url)) };
}

export default defineConfig({
  resolve: {
    alias: [
      workspaceSourceAlias("@aao/mcp-connector", "./packages/mcp-connector/src/index.ts"),
      workspaceSourceAlias("@aao/authorization", "./packages/authorization/src/index.ts"),
      workspaceSourceAlias("@aao/approval", "./packages/approval/src/index.ts"),
      workspaceSourceAlias("@aao/governance", "./packages/governance/src/index.ts"),
      workspaceSourceAlias("@aao/agent-runtime", "./packages/agent-runtime/src/index.ts"),
      workspaceSourceAlias("@aao/config", "./packages/config/src/index.ts"),
      workspaceSourceAlias("@aao/contracts", "./packages/contracts/src/index.ts"),
      // Subpath first: a string alias also matches "@aao/model-runtime/..." as a prefix.
      workspaceSourceAlias("@aao/model-runtime/vercel-ai", "./packages/model-runtime/src/adapters/vercel-ai.ts"),
      workspaceSourceAlias("@aao/model-runtime", "./packages/model-runtime/src/index.ts"),
      workspaceSourceAlias("@aao/runtime", "./packages/runtime/src/index.ts"),
      workspaceSourceAlias("@aao/tool-runtime", "./packages/tool-runtime/src/index.ts"),
      workspaceSourceAlias("@aao/substrate-contracts", "./packages/substrate-contracts/src/index.ts"),
      workspaceSourceAlias("@aao/workflow-dsl", "./packages/workflow-dsl/src/index.ts"),
    ],
  },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"],
  },
});
