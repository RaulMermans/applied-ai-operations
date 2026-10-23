import {
  packRefKey,
  type CapabilityPackOutcomeClass,
  type CapabilityPackRef,
  type ExactToolRef,
  type IntegrationSlotRequirement,
} from "./contract.js";
import { CapabilityPackError } from "./errors.js";
import { compareCodeUnits, deepFreeze } from "./json.js";
import type { CapabilityPack } from "./pack.js";

export interface CapabilityPackCatalogDescription {
  readonly ref: CapabilityPackRef;
  readonly identity: string;
  readonly fingerprint: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly workflow: {
    readonly id: string;
    readonly version: string;
    readonly planFingerprint: string;
  };
  readonly executionOutcomeClass: CapabilityPackOutcomeClass;
  readonly evalProfileRef: string;
  readonly toolRefs: readonly ExactToolRef[];
  readonly modelPolicyRefs: readonly string[];
  readonly modelCapabilities: readonly string[];
  readonly integrationSlots: readonly IntegrationSlotRequirement[];
  readonly preliminaryPermissions: readonly string[];
  readonly approvalRequired: boolean;
  readonly summary: string;
  readonly limitations: readonly string[];
}

export interface CapabilityPackCatalog {
  listCapabilityPacks(): readonly CapabilityPack[];
  getCapabilityPack(ref: CapabilityPackRef | string): CapabilityPack | undefined;
  describeCapabilityPack(ref: CapabilityPackRef | string): CapabilityPackCatalogDescription;
  searchCapabilityPacks(query: string): readonly CapabilityPack[];
}

function normalizeRefKey(ref: CapabilityPackRef | string): string {
  if (typeof ref === "string") {
    if (!ref.includes("@")) {
      throw new CapabilityPackError(
        "PACK_INVALID_MANIFEST",
        `Capability pack reference string must be in format 'packId@MAJOR.MINOR.PATCH', received '${ref}'`
      );
    }
    const [id, version] = ref.split("@");
    return `${id}@${version}`;
  }
  if (ref && typeof ref === "object" && typeof ref.id === "string" && typeof ref.version === "string") {
    return packRefKey(ref);
  }
  throw new CapabilityPackError(
    "PACK_INVALID_MANIFEST",
    "Invalid pack reference; expected { id, version } or 'id@version'"
  );
}

/**
 * Creates an immutable Capability Pack catalog.
 * Uses a private map and defensive copying to prevent post-creation mutation.
 */
export function createCapabilityPackCatalog(initialPacks?: readonly CapabilityPack[]): CapabilityPackCatalog {
  const packsMap = new Map<string, CapabilityPack>();

  if (initialPacks) {
    for (const pack of initialPacks) {
      const key = pack.identity;
      if (packsMap.has(key)) {
        throw new CapabilityPackError(
          "PACK_DUPLICATE_REF",
          `Capability pack '${key}' is already registered in the catalog`
        );
      }
      packsMap.set(key, pack);
    }
  }

  const catalog: CapabilityPackCatalog = {
    listCapabilityPacks(): readonly CapabilityPack[] {
      const list = Array.from(packsMap.values());
      list.sort((a, b) => compareCodeUnits(a.identity, b.identity));
      return deepFreeze(list);
    },

    getCapabilityPack(ref: CapabilityPackRef | string): CapabilityPack | undefined {
      const key = normalizeRefKey(ref);
      return packsMap.get(key);
    },

    describeCapabilityPack(ref: CapabilityPackRef | string): CapabilityPackCatalogDescription {
      const key = normalizeRefKey(ref);
      const pack = packsMap.get(key);
      if (!pack) {
        throw new CapabilityPackError("PACK_NOT_FOUND", `Capability pack '${key}' not found in catalog`);
      }

      const m = pack.manifest;
      const desc: CapabilityPackCatalogDescription = {
        ref: { id: m.id, version: m.version },
        identity: pack.identity,
        fingerprint: pack.fingerprint,
        name: m.name,
        description: m.description,
        category: m.category,
        tags: [...m.tags],
        workflow: { ...m.workflow },
        executionOutcomeClass: m.execution.outcomeClass,
        evalProfileRef: m.verification.evalProfileRef,
        toolRefs: m.requirements.toolRefs.map((t) => ({ ...t })),
        modelPolicyRefs: [...m.requirements.modelPolicyRefs],
        modelCapabilities: [...m.requirements.modelCapabilities],
        integrationSlots: m.requirements.integrationSlots.map((s) => ({ ...s })),
        preliminaryPermissions: [...m.requirements.preliminaryPermissions],
        approvalRequired: Boolean(m.requirements.approval?.required),
        summary: m.documentation.summary,
        limitations: [...m.documentation.limitations],
      };

      return deepFreeze(desc);
    },

    searchCapabilityPacks(query: string): readonly CapabilityPack[] {
      if (typeof query !== "string") return Object.freeze([]);
      const clean = query.trim().toLowerCase();
      if (!clean) return this.listCapabilityPacks();

      const matched: CapabilityPack[] = [];
      for (const pack of packsMap.values()) {
        const m = pack.manifest;
        const matches =
          m.id.toLowerCase().includes(clean) ||
          m.name.toLowerCase().includes(clean) ||
          m.description.toLowerCase().includes(clean) ||
          m.category.toLowerCase().includes(clean) ||
          m.tags.some((t) => t.toLowerCase().includes(clean));

        if (matches) {
          matched.push(pack);
        }
      }

      matched.sort((a, b) => compareCodeUnits(a.identity, b.identity));
      return deepFreeze(matched);
    },
  };

  return Object.freeze(catalog);
}
