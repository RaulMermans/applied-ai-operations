import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN = /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials(?:\.[^/]+)?|\.npmrc|id_rsa)(?:\/|$)|(?:^|\/)secrets?\//i;
const SECRETISH = /(?:sk-live-|AKIA[0-9A-Z]{16}|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY)/;

const PACKAGES = [
  "packages/framework",
  "packages/contracts",
  "packages/toolbox",
  "packages/adapters",
  "packages/capability-packs",
  "packages/operator-inspection",
  "packages/integration-public-web",
  "packages/integration-documents",
];

const STRICT_ALLOW = /^package\/(package\.json|README\.md|LICENSE|dist\/.*\.(js|d\.ts)|src\/.*\.(ts|js)|data\/.*)$/;

export function inspectPackedPackage(packageDir) {
  const packDir = mkdtempSync(join(tmpdir(), "aao-pack-inventory-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: packageDir, stdio: "pipe" });
    const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`pnpm pack produced no tarball in ${packageDir}`);
    const entries = execFileSync("tar", ["-tzf", join(packDir, tarball)], { encoding: "utf8" }).trim().split("\n").sort();
    const forbidden = entries.filter((entry) => FORBIDDEN.test(entry) || SECRETISH.test(entry.split("/").pop() ?? ""));
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const hasFilesField = Array.isArray(manifest.files);
    const unexpected = hasFilesField ? entries.filter((entry) => !STRICT_ALLOW.test(entry)) : [];
    return {
      name: manifest.name,
      private: manifest.private === true,
      version: manifest.version,
      hasFilesField,
      workspaceDependencies: Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
        .filter(([, spec]) => spec === "workspace:*")
        .map(([name]) => name),
      files: entries,
      forbidden,
      unexpected,
    };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

export function inspectReleasePacks(root = repositoryRoot) {
  return PACKAGES.map((relative) => inspectPackedPackage(join(root, relative)));
}

export function assertPackInventory(reports) {
  const secrets = [];
  for (const report of reports) {
    if (report.forbidden.length > 0) secrets.push(`${report.name}: ${report.forbidden.join(", ")}`);
    for (const entry of report.files) {
      if (SECRETISH.test(entry)) secrets.push(`${report.name} name ${entry}`);
    }
  }
  if (secrets.length > 0) throw new Error(`packed artifacts contain forbidden paths: ${secrets.join("; ")}`);
  return reports;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = assertPackInventory(inspectReleasePacks());
  process.stdout.write(`${JSON.stringify({ packages: reports.map((report) => ({ name: report.name, private: report.private, files: report.files.length, workspaceDependencies: report.workspaceDependencies, hasFilesField: report.hasFilesField })) }, null, 2)}\n`);
}
