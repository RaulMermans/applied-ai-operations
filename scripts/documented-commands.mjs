import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_SCRIPTS = [
  "check",
  "build",
  "test",
  "lint",
  "typecheck",
  "eval:ci",
  "eval:adapters",
  "aao",
  "proof:company-research",
  "proof:document-intelligence",
  "proof:operational-request",
  "proof:company-portability",
  "proof:capability-packs",
  "proof:operator-inspection",
  "proof:security-hardening",
  "benchmark:local-v1",
  "release:verify:local-v1",
];

export const REQUIRED_HELP_FRAGMENTS = [
  "aao workflow validate",
  "aao workflow compile",
  "aao eval ci",
  "aao eval adapters",
  "aao inspect",
];

export function readDocumentedCommands(root = repositoryRoot) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const missing = REQUIRED_SCRIPTS.filter((name) => typeof pkg.scripts?.[name] !== "string");
  const docs = [
    "README.md",
    "docs/guides/getting-started-local-v1.md",
    "docs/engineering/local-development.md",
    "CONTRIBUTING.md",
  ].map((relative) => ({ relative, text: readFileSync(join(root, relative), "utf8") }));
  const undocumented = REQUIRED_SCRIPTS.filter((name) => !docs.some((doc) => doc.text.includes(`pnpm ${name}`) || doc.text.includes(`\`${name}\``) || (name.startsWith("proof:") && docs.some((d) => d.text.includes(name)))));
  return { scripts: Object.keys(pkg.scripts ?? {}), missing, undocumented };
}

export function assertDocumentedCommands(root = repositoryRoot) {
  const result = readDocumentedCommands(root);
  if (result.missing.length > 0) throw new Error(`package.json missing scripts: ${result.missing.join(", ")}`);
  if (result.undocumented.length > 0) throw new Error(`required scripts are undocumented: ${result.undocumented.join(", ")}`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${JSON.stringify(assertDocumentedCommands(), null, 2)}\n`);
}
