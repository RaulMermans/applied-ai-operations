export const PACK_LIMITS: { maxEntries: number; maxEntryBytes: number; maxScanBytes: number };

export type PackFinding = { rule: string; entry?: string | null; detail?: string | null };

export type PackInventoryReport = {
  name?: string;
  hasFilesField?: boolean;
  workspaceDependencies?: string[];
  files: string[];
  forbidden: string[];
  unexpected: string[];
  findings: PackFinding[];
  contentFindings: PackFinding[];
  missingMetadata: PackFinding[];
  oversized: PackFinding[];
  unsafe: PackFinding[];
  malformed: boolean;
  packedPrivate?: boolean | null;
};

export function inspectTarball(path: string): PackInventoryReport;
export function inspectPackedPackage(dir: string): PackInventoryReport;
export function inspectReleasePacks(root?: string): PackInventoryReport[];
export function assertPackInventory(reports: Array<Partial<PackInventoryReport> & { name?: string }>): PackInventoryReport[];
