import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { PrincipalSchema, RunIdSchema, type Principal } from "@aao/contracts";
import { z } from "zod";

/**
 * Trusted host identity and immutable Run binding (ADR-034).
 *
 * The host authenticates a person or service (outside AAO) and mints an
 * `AttestedActor`. AAO accepts only actors minted by the host's attestor:
 * membership is checked by object identity, never by shape, so request
 * data, model output or a deserialized object can never become an actor.
 * A Run ID is only an identifier: the actor is bound to it once, before any
 * Workflow execution, and every later identity lookup reads that binding.
 */

declare const attestedActorBrand: unique symbol;
/** Opaque host-minted actor. Its only meaning is the attestor that minted it. */
export interface AttestedActor {
  readonly [attestedActorBrand]: true;
}

export interface TrustedHostIdentity {
  /** Called by trusted host code after its own authentication. Validates the principal shape. */
  attest(principal: Principal): AttestedActor;
  /** The attested principal, or `undefined` for anything this attestor did not mint. */
  resolve(actor: unknown): Principal | undefined;
}

export function createTrustedHostIdentity(): TrustedHostIdentity {
  const minted = new WeakMap<object, Principal>();
  return Object.freeze({
    attest(principal: Principal): AttestedActor {
      const parsed = PrincipalSchema.parse(principal);
      const actor = Object.freeze({}) as AttestedActor;
      minted.set(actor, Object.freeze({ id: parsed.id, type: parsed.type }));
      return actor;
    },
    resolve(actor: unknown): Principal | undefined {
      return typeof actor === "object" && actor !== null ? minted.get(actor) : undefined;
    },
  });
}

const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/);

export const TrustedRunBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: RunIdSchema,
    companyId: z.string().min(1).max(128),
    principal: PrincipalSchema,
    proofRef: z.enum(["company_research", "document_intelligence", "operational_request"]),
    configurationFingerprint: sha256Hex,
    workflowFingerprint: sha256Hex,
    createdAt: z.string().datetime(),
  })
  .strict();
export type TrustedRunBinding = z.infer<typeof TrustedRunBindingSchema>;

export type RunBindingFailureCode = "RUN_BINDING_CONFLICT" | "RUN_BINDING_INVALID" | "RUN_WAITPOINT_CONFLICT";

/**
 * Write-once Run ownership records. Holds no credentials, tokens or Run
 * state: identifiers and fingerprints only. Synchronous by contract, so a
 * claim is one uninterrupted check-and-set in this process.
 */
export interface RunBindingStore {
  /** Binds a new Run, or returns the existing binding when every field but `createdAt` is identical. */
  claim(binding: TrustedRunBinding): { ok: true; binding: TrustedRunBinding } | { ok: false; code: RunBindingFailureCode };
  get(runId: string): TrustedRunBinding | undefined;
  /** Write-once digest of the exact execution that reached `approvalId`'s wait. */
  recordWaitpoint(runId: string, approvalId: string, executionDigest: string): { ok: true } | { ok: false; code: RunBindingFailureCode };
  getWaitpoint(runId: string, approvalId: string): string | undefined;
}

function sameOwnership(a: TrustedRunBinding, b: TrustedRunBinding): boolean {
  return (
    a.runId === b.runId &&
    a.companyId === b.companyId &&
    a.principal.id === b.principal.id &&
    a.principal.type === b.principal.type &&
    a.proofRef === b.proofRef &&
    a.configurationFingerprint === b.configurationFingerprint &&
    a.workflowFingerprint === b.workflowFingerprint
  );
}

function parseBinding(input: unknown): TrustedRunBinding | undefined {
  const parsed = TrustedRunBindingSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export function createInMemoryRunBindingStore(): RunBindingStore {
  const bindings = new Map<string, TrustedRunBinding>();
  const waitpoints = new Map<string, string>();
  return Object.freeze({
    claim(input: TrustedRunBinding) {
      const binding = parseBinding(input);
      if (!binding) return { ok: false as const, code: "RUN_BINDING_INVALID" as const };
      const existing = bindings.get(binding.runId);
      if (existing) return sameOwnership(existing, binding) ? { ok: true as const, binding: existing } : { ok: false as const, code: "RUN_BINDING_CONFLICT" as const };
      const frozen = Object.freeze({ ...binding, principal: Object.freeze({ ...binding.principal }) });
      bindings.set(binding.runId, frozen);
      return { ok: true as const, binding: frozen };
    },
    get: (runId: string) => bindings.get(runId),
    recordWaitpoint(runId: string, approvalId: string, digest: string) {
      const key = `${runId}\u0000${approvalId}`;
      const existing = waitpoints.get(key);
      if (existing !== undefined && existing !== digest) return { ok: false as const, code: "RUN_WAITPOINT_CONFLICT" as const };
      waitpoints.set(key, digest);
      return { ok: true as const };
    },
    getWaitpoint: (runId: string, approvalId: string) => waitpoints.get(`${runId}\u0000${approvalId}`),
  });
}

/**
 * File-backed binding store for local restart and recovery. Each record is
 * written to a temp file, fsynced, then hard-linked into place: `link` never
 * overwrites, so exactly one claimant wins even across processes sharing
 * `root`. File names are SHA-256 of the identifiers (no caller-controlled paths).
 * shortcut: no directory fsync or file locking beyond link(2); a networked/replicated store needs a real CAS backend.
 */
export function createFileRunBindingStore(options: { root: string }): RunBindingStore {
  mkdirSync(options.root, { recursive: true, mode: 0o700 });
  const pathFor = (...parts: string[]) => join(options.root, `${createHash("sha256").update(parts.join("\u0000")).digest("hex")}.json`);

  const writeOnce = (path: string, content: string): boolean => {
    const temp = join(options.root, `.tmp-${randomUUID()}`);
    const fd = openSync(temp, "wx", 0o600);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    } finally {
      unlinkSync(temp);
    }
  };
  const read = (path: string): unknown => {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return null; // unreadable or corrupt: never a valid record
    }
  };

  return Object.freeze({
    claim(input: TrustedRunBinding) {
      const binding = parseBinding(input);
      if (!binding) return { ok: false as const, code: "RUN_BINDING_INVALID" as const };
      const path = pathFor("binding", binding.runId);
      if (writeOnce(path, JSON.stringify(binding))) return { ok: true as const, binding };
      const existing = parseBinding(read(path));
      if (!existing) return { ok: false as const, code: "RUN_BINDING_INVALID" as const };
      return sameOwnership(existing, binding) ? { ok: true as const, binding: existing } : { ok: false as const, code: "RUN_BINDING_CONFLICT" as const };
    },
    get(runId: string) {
      const raw = read(pathFor("binding", runId));
      const binding = parseBinding(raw);
      return binding && binding.runId === runId ? binding : undefined;
    },
    recordWaitpoint(runId: string, approvalId: string, digest: string) {
      const path = pathFor("waitpoint", runId, approvalId);
      if (writeOnce(path, JSON.stringify({ digest }))) return { ok: true as const };
      const existing = read(path) as { digest?: unknown } | null | undefined;
      return existing?.digest === digest ? { ok: true as const } : { ok: false as const, code: "RUN_WAITPOINT_CONFLICT" as const };
    },
    getWaitpoint(runId: string, approvalId: string) {
      const existing = read(pathFor("waitpoint", runId, approvalId)) as { digest?: unknown } | null | undefined;
      return typeof existing?.digest === "string" ? existing.digest : undefined;
    },
  });
}
