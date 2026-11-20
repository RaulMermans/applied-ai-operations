import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const FORBIDDEN = /(?:^|\/)(?:\.env(?:\.[^/]+)?|credentials(?:\.[^/]+)?|\.npmrc|id_rsa)(?:\/|$)|(?:^|\/)secrets?\//i;

/** Packed paths that are legitimate for Local V1 inventory packages. Not a blanket dist/src/data allow. */
export const STRICT_ALLOW = /^package\/(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts))$/;
const ALLOWED_DIRECTORY = /^package\/(dist\/([^/]+\/)*)?$/;

export const PACKAGES = [
  "packages/framework",
  "packages/contracts",
  "packages/toolbox",
  "packages/adapters",
  "packages/capability-packs",
  "packages/operator-inspection",
  "packages/integration-public-web",
  "packages/integration-documents",
];

export const REQUIRED_PACKED_FILES = ["package/package.json", "package/README.md", "package/LICENSE"];

export const PACK_LIMITS = {
  maxEntries: 400,
  maxEntryBytes: 1_048_576,
  maxScanBytes: 8_388_608,
};

const CONTENT_PATTERNS = [
  { rule: "private-key-block", re: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
  { rule: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/ },
  { rule: "high-confidence-token", re: /\b(?:sk-live-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/ },
  { rule: "npm-auth-token", re: /_authToken\s*=/ },
  { rule: "env-secret-assignment", re: /(?:^|\n)(?:export\s+)?[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S+/ },
];

export const PACK_SCAN_LIMITATION =
  "Pack content scanning is a high-confidence regression gate (private-key blocks, known credential filenames, access-token patterns, .env/private config). It is not a guarantee that every secret or sensitive business value is detected.";

function finding(rule, entry = null, detail = null) {
  return { rule, entry, detail };
}

function parseTarListLine(line) {
  const match = line.match(/^([dhl-])[A-Za-z+.-]{9}\s+\S+\s+(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?\s+(.+)$/);
  if (!match) return null;
  const kindChar = match[1];
  const size = Number(match[2]);
  let name = match[3];
  let linkTarget = null;
  if (kindChar === "l") {
    const split = name.split(" -> ");
    name = split[0];
    linkTarget = split.slice(1).join(" -> ");
  }
  const kind = kindChar === "d" ? "directory" : kindChar === "l" ? "symlink" : kindChar === "h" ? "hardlink" : kindChar === "-" ? "file" : "other";
  return { kind, size, name, linkTarget };
}

function isUnsafePath(name) {
  if (name.startsWith("/") || name.includes("\\") || name.includes("\0")) return true;
  if (!name.startsWith("package/")) return true;
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const parts = trimmed.split("/");
  return parts.some((part) => part === ".." || part === "." || part === "");
}

function inspectPackedPackageJson(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { missingMetadata: [finding("malformed-package-json")], private: null, name: null, version: null };
  }
  const missingMetadata = [];
  if (typeof parsed.name !== "string" || parsed.name.length === 0) missingMetadata.push(finding("missing-package-name"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) missingMetadata.push(finding("missing-package-version"));
  if (parsed.private !== true) missingMetadata.push(finding("package-not-private"));
  return { missingMetadata, private: parsed.private === true, name: parsed.name ?? null, version: parsed.version ?? null };
}

export function inspectTarball(tarballPath, options = {}) {
  const limits = { ...PACK_LIMITS, ...options.limits };
  const findings = [];
  let listing;
  try {
    listing = execFileSync("tar", ["-tvzf", tarballPath], { encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch {
    return {
      files: [],
      forbidden: [],
      unexpected: [],
      unsafe: [finding("malformed-archive")],
      oversized: [],
      contentFindings: [],
      missingRequired: [...REQUIRED_PACKED_FILES],
      missingMetadata: [finding("malformed-archive")],
      malformed: true,
      empty: true,
      findings: [finding("malformed-archive")],
    };
  }

  const lines = listing.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    const emptyFinding = finding("empty-archive");
    return {
      files: [],
      forbidden: [],
      unexpected: [],
      unsafe: [],
      oversized: [],
      contentFindings: [],
      missingRequired: [...REQUIRED_PACKED_FILES],
      missingMetadata: [emptyFinding],
      malformed: false,
      empty: true,
      findings: [emptyFinding],
    };
  }

  const files = [];
  const forbidden = [];
  const unexpected = [];
  const unsafe = [];
  const oversized = [];
  const contentFindings = [];
  let scanBytes = 0;
  let packedManifestText = null;

  for (const line of lines) {
    const parsed = parseTarListLine(line);
    if (!parsed) {
      findings.push(finding("malformed-archive-metadata", null, "unparseable tar listing line"));
      continue;
    }
    files.push(parsed.name);
    if (parsed.kind === "symlink" || parsed.kind === "hardlink" || parsed.kind === "other") {
      unsafe.push(finding("unsafe-archive-entry", parsed.name, parsed.kind));
      continue;
    }
    if (isUnsafePath(parsed.name) || parsed.name.includes("\0")) {
      unsafe.push(finding("unsafe-archive-entry", parsed.name, "path"));
      continue;
    }
    if (parsed.kind === "directory") {
      if (!ALLOWED_DIRECTORY.test(parsed.name)) unexpected.push(parsed.name);
      continue;
    }
    if (FORBIDDEN.test(parsed.name)) forbidden.push(parsed.name);
    if (!STRICT_ALLOW.test(parsed.name)) unexpected.push(parsed.name);
    if (parsed.size > limits.maxEntryBytes) {
      oversized.push(finding("oversized-archive-entry", parsed.name));
      continue;
    }
    if (parsed.kind === "file" && (STRICT_ALLOW.test(parsed.name) || parsed.name === "package/package.json")) {
      if (scanBytes + parsed.size > limits.maxScanBytes) {
        oversized.push(finding("oversized-archive-scan", parsed.name));
        continue;
      }
      let content;
      try {
        content = execFileSync("tar", ["-xOf", tarballPath, parsed.name], {
          encoding: "utf8",
          maxBuffer: limits.maxEntryBytes,
        });
      } catch {
        findings.push(finding("unreadable-archive-entry", parsed.name));
        continue;
      }
      scanBytes += Buffer.byteLength(content, "utf8");
      if (parsed.name === "package/package.json") packedManifestText = content;
      for (const pattern of CONTENT_PATTERNS) {
        if (pattern.re.test(content)) contentFindings.push(finding(pattern.rule, parsed.name));
      }
    }
  }

  if (files.length > limits.maxEntries) findings.push(finding("too-many-archive-entries"));

  const missingRequired = REQUIRED_PACKED_FILES.filter((entry) => !files.includes(entry));
  const metadata = packedManifestText
    ? inspectPackedPackageJson(packedManifestText)
    : { missingMetadata: [finding("missing-package-json")], private: null, name: null, version: null };

  const all = [
    ...findings,
    ...forbidden.map((entry) => finding("forbidden-path", entry)),
    ...unexpected.map((entry) => finding("unexpected-path", entry)),
    ...unsafe,
    ...oversized,
    ...contentFindings,
    ...missingRequired.map((entry) => finding("missing-required-file", entry)),
    ...metadata.missingMetadata,
  ];

  return {
    files: files.sort(),
    forbidden,
    unexpected,
    unsafe,
    oversized,
    contentFindings,
    missingRequired,
    missingMetadata: metadata.missingMetadata,
    malformed: all.some((item) => item.rule.startsWith("malformed-archive")),
    empty: files.length === 0,
    packedName: metadata.name,
    packedVersion: metadata.version,
    packedPrivate: metadata.private,
    findings: all,
  };
}

export function inspectPackedPackage(packageDir) {
  const packDir = mkdtempSync(join(tmpdir(), "aao-pack-inventory-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", packDir], { cwd: packageDir, stdio: "pipe" });
    const tarball = readdirSync(packDir).find((file) => file.endsWith(".tgz"));
    if (!tarball) throw new Error(`pnpm pack produced no tarball in ${packageDir}`);
    const archive = inspectTarball(join(packDir, tarball));
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    const hasFilesField = Array.isArray(manifest.files);
    const findings = [...archive.findings];
    if (!hasFilesField) findings.push(finding("missing-inclusion-policy"));
    return {
      name: manifest.name,
      private: manifest.private === true,
      version: manifest.version,
      hasFilesField,
      workspaceDependencies: Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })
        .filter(([, spec]) => spec === "workspace:*")
        .map(([name]) => name),
      files: archive.files,
      forbidden: archive.forbidden,
      unexpected: archive.unexpected,
      unsafe: archive.unsafe,
      oversized: archive.oversized,
      contentFindings: archive.contentFindings,
      missingRequired: archive.missingRequired,
      missingMetadata: archive.missingMetadata,
      malformed: archive.malformed,
      empty: archive.empty,
      findings,
    };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

export function inspectReleasePacks(root = repositoryRoot) {
  return PACKAGES.map((relative) => inspectPackedPackage(join(root, relative)));
}

function formatFinding(packageName, item) {
  const entry = item.entry ?? "-";
  const detail = item.detail ? ` ${item.detail}` : "";
  return `${packageName} ${entry} ${item.rule}${detail}`;
}

export function assertPackInventory(reports) {
  const failures = [];
  for (const report of reports) {
    if (report.unexpected?.length && !report.findings?.some((item) => item.rule === "unexpected-path")) {
      for (const entry of report.unexpected) failures.push(formatFinding(report.name, finding("unexpected-path", entry)));
    }
    const items = report.findings ?? [];
    for (const item of items) failures.push(formatFinding(report.name, item));
  }
  if (failures.length > 0) throw new Error(`packed artifacts failed inventory: ${failures.join("; ")}`);
  return reports;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports = assertPackInventory(inspectReleasePacks());
  process.stdout.write(
    `${JSON.stringify({ packages: reports.map((report) => ({ name: report.name, private: report.private, files: report.files.length, workspaceDependencies: report.workspaceDependencies, hasFilesField: report.hasFilesField })), limitation: PACK_SCAN_LIMITATION }, null, 2)}\n`,
  );
}
