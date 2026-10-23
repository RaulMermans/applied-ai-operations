import {
  createCapabilityPackCatalog,
  CANONICAL_CAPABILITY_PACKS,
  type CapabilityPackCatalog,
} from "@aao/capability-packs";

/**
 * Creates the standard AAO Capability Pack Catalog containing all 3 canonical packs:
 * - aao.company-research@1.0.0
 * - aao.document-intelligence@1.0.0
 * - aao.operational-request@1.0.0
 */
export function createStandardPackCatalog(): CapabilityPackCatalog {
  return createCapabilityPackCatalog(CANONICAL_CAPABILITY_PACKS);
}
