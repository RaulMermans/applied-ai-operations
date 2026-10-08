import { ModelPricingProfileSchema, type ModelPricingProfile } from "@aao/contracts";

/**
 * Explicit, trusted model pricing (ADR-021). Profiles come only from host /
 * version-controlled configuration passed to the projection by the caller.
 * Matching is exact; nothing is guessed, fetched, or inferred from names.
 */

export type PricingValidation = { ok: true; profiles: ModelPricingProfile[]; currency: string | null } | { ok: false };

/** Strict validation of a pricing set: schema-valid profiles, one currency, and no two profiles for the same exact identity. */
export function validatePricingProfiles(raw: unknown): PricingValidation {
  if (raw === undefined) return { ok: true, profiles: [], currency: null };
  if (!Array.isArray(raw) || raw.length > 1024) return { ok: false };
  const profiles: ModelPricingProfile[] = [];
  const identities = new Set<string>();
  const currencies = new Set<string>();
  for (const candidate of raw) {
    const parsed = ModelPricingProfileSchema.safeParse(candidate);
    if (!parsed.success) return { ok: false };
    const identity = JSON.stringify([parsed.data.provider, parsed.data.model, parsed.data.revision ?? null]);
    if (identities.has(identity)) return { ok: false };
    identities.add(identity);
    currencies.add(parsed.data.currency);
    profiles.push(parsed.data);
  }
  if (currencies.size > 1) return { ok: false };
  return { ok: true, profiles, currency: [...currencies][0] ?? null };
}

/**
 * The profile for a registered model identity: an exact revision match
 * first, else a profile that names no revision for the same provider and
 * model. A profile that names a revision never matches a call with a
 * different or absent revision.
 */
export function matchPricingProfile(profiles: readonly ModelPricingProfile[], identity: { provider: string; model: string; revision?: string }): ModelPricingProfile | undefined {
  const candidates = profiles.filter((profile) => profile.provider === identity.provider && profile.model === identity.model);
  return candidates.find((profile) => profile.revision !== undefined && profile.revision === identity.revision) ?? candidates.find((profile) => profile.revision === undefined);
}

/**
 * Modelled cost of one call in integer nano-units: `(input × inPrice +
 * output × outPrice) / 1,000,000`, rounded half-up once, computed in BigInt
 * so no binary floating point is involved.
 */
export function modelCallCostNanos(profile: ModelPricingProfile, inputTokens: number, outputTokens: number): bigint {
  const scaled = BigInt(inputTokens) * BigInt(profile.inputNanosPerMillionTokens) + BigInt(outputTokens) * BigInt(profile.outputNanosPerMillionTokens);
  return (scaled + 500_000n) / 1_000_000n;
}
