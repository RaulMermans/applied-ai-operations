import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Docker-backed suite, deliberately outside the root `pnpm test` glob so AAO's
// release gate does not acquire a Docker dependency.
export default defineConfig({
  resolve: { alias: [{ find: "@aao/contracts", replacement: fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)) }] },
  test: { include: ["integration/**/*.test.ts"], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false },
});
