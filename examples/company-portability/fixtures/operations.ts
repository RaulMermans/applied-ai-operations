import {
  createInMemoryDraftRepository,
  type OperationalDraftRepository,
  type OperationalRequestInput,
} from "@aao/example-operational-request";

export const NORTHSTAR_OPERATIONAL_REQUEST: OperationalRequestInput = Object.freeze({
  schemaVersion: 1,
  requestId: "req-northstar-001",
  instruction:
    "Prepare an update to change the display name of account NS-COMMERCE-001 from Northstar Storefront to Northstar Global Retail. Submit the proposed change for management approval.",
  accountContext: {
    accountId: "NS-COMMERCE-001",
    currentDisplayName: "Northstar Storefront",
  },
});

export const ARBOR_OPERATIONAL_REQUEST: OperationalRequestInput = Object.freeze({
  schemaVersion: 1,
  requestId: "req-arbor-002",
  instruction:
    "Prepare an update to change the display name of account ARB-CLIENT-202 from Arbor Advisory Group to Arbor Strategic Partners. Submit the proposed change for management approval.",
  accountContext: {
    accountId: "ARB-CLIENT-202",
    currentDisplayName: "Arbor Advisory Group",
  },
});

export function createNorthstarDraftRepository(): OperationalDraftRepository {
  return createInMemoryDraftRepository();
}

export function createArborDraftRepository(): OperationalDraftRepository {
  return createInMemoryDraftRepository();
}
