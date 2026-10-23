import { describe, expect, it } from "vitest";
import {
  createCapabilityPackCatalog,
  CapabilityPackError,
  COMPANY_RESEARCH_PACK,
  DOCUMENT_INTELLIGENCE_PACK,
  OPERATIONAL_REQUEST_PACK,
  CANONICAL_CAPABILITY_PACKS,
} from "../src/index.js";

describe("Capability Pack Catalog", () => {
  it("registers packs and supports exact lookups by object ref or string", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);

    const pack1 = catalog.getCapabilityPack({ id: "aao.company-research", version: "1.0.0" });
    expect(pack1).toBeDefined();
    expect(pack1?.identity).toBe("aao.company-research@1.0.0");

    const pack2 = catalog.getCapabilityPack("aao.document-intelligence@1.0.0");
    expect(pack2).toBeDefined();
    expect(pack2?.identity).toBe("aao.document-intelligence@1.0.0");

    const pack3 = catalog.getCapabilityPack("aao.operational-request@1.0.0");
    expect(pack3).toBeDefined();
    expect(pack3?.identity).toBe("aao.operational-request@1.0.0");
  });

  it("returns undefined for unknown pack references", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);
    expect(catalog.getCapabilityPack("aao.unknown-pack@1.0.0")).toBeUndefined();
    expect(catalog.getCapabilityPack({ id: "aao.unknown-pack", version: "1.0.0" })).toBeUndefined();
  });

  it("describes registered packs with full descriptive metadata", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);
    const desc = catalog.describeCapabilityPack("aao.operational-request@1.0.0");

    expect(desc.identity).toBe("aao.operational-request@1.0.0");
    expect(desc.executionOutcomeClass).toBe("draft_only");
    expect(desc.approvalRequired).toBe(true);
    expect(desc.toolRefs).toHaveLength(1);
    expect(desc.toolRefs[0]?.id).toBe("operations.create_change_draft");
    expect(desc.workflow.planFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(desc.limitations.length).toBeGreaterThan(0);
    expect(Object.isFrozen(desc)).toBe(true);
  });

  it("throws PACK_NOT_FOUND when describing an unregistered pack", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);
    expect(() => catalog.describeCapabilityPack("aao.nonexistent@1.0.0")).toThrow(CapabilityPackError);
    expect(() => catalog.describeCapabilityPack("aao.nonexistent@1.0.0")).toThrow(/not found in catalog/);
  });

  it("rejects duplicate pack registrations", () => {
    expect(() =>
      createCapabilityPackCatalog([COMPANY_RESEARCH_PACK, COMPANY_RESEARCH_PACK])
    ).toThrow(CapabilityPackError);
    expect(() =>
      createCapabilityPackCatalog([COMPANY_RESEARCH_PACK, COMPANY_RESEARCH_PACK])
    ).toThrow(/already registered in the catalog/);
  });

  it("lists packs in deterministic sorted order", () => {
    // Register in reverse order
    const catalog = createCapabilityPackCatalog([
      OPERATIONAL_REQUEST_PACK,
      DOCUMENT_INTELLIGENCE_PACK,
      COMPANY_RESEARCH_PACK,
    ]);

    const list = catalog.listCapabilityPacks();
    expect(list.map((p) => p.identity)).toEqual([
      "aao.company-research@1.0.0",
      "aao.document-intelligence@1.0.0",
      "aao.operational-request@1.0.0",
    ]);
  });

  it("performs deterministic lexical search across id, name, description, category, and tags", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);

    const searchDoc = catalog.searchCapabilityPacks("document");
    expect(searchDoc).toHaveLength(1);
    expect(searchDoc[0]?.identity).toBe("aao.document-intelligence@1.0.0");

    const searchApproval = catalog.searchCapabilityPacks("approval");
    expect(searchApproval).toHaveLength(1);
    expect(searchApproval[0]?.identity).toBe("aao.operational-request@1.0.0");

    const searchReadOnly = catalog.searchCapabilityPacks("read-only");
    expect(searchReadOnly).toHaveLength(2);
    expect(searchReadOnly.map((p) => p.identity)).toEqual([
      "aao.company-research@1.0.0",
      "aao.document-intelligence@1.0.0",
    ]);

    const searchNone = catalog.searchCapabilityPacks("completely-irrelevant-query");
    expect(searchNone).toHaveLength(0);
  });

  it("protects catalog from mutation: defensive copying and deepFreeze", () => {
    const catalog = createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);
    const list = catalog.listCapabilityPacks();
    expect(Object.isFrozen(list)).toBe(true);
    expect(() => {
      // @ts-expect-error mutating frozen array
      list.push(COMPANY_RESEARCH_PACK);
    }).toThrow();
  });
});
