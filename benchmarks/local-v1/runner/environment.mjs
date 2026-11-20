import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";

function git(command, root) {
  try {
    return execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function captureEnvironment(root) {
  const cpu = os.cpus()[0];
  return {
    sourceCommit: git(["rev-parse", "HEAD"], root),
    branch: git(["branch", "--show-current"], root),
    node: process.version,
    pnpm: (() => {
      try {
        return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: cpu?.model ?? null,
    totalmemBytes: os.totalmem(),
    packageManager: JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")).packageManager,
  };
}
