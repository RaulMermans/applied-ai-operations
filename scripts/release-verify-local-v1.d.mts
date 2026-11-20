export const DECISIONS: { READY: string; BLOCKED: string; NOT_VERIFIED: string };

export function reportPath(root: string): string;

export function runVerify(options?: Record<string, unknown>): {
  decision: string;
  exitCode: number;
  writeFailed?: boolean;
  report: { afterCoreIgnored?: boolean; sourceCommit?: string | null };
};
