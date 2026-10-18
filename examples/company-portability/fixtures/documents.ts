import type {
  DocumentSourceProvider,
  DocumentSourceProviderContext,
  DocumentSourceReadRequest,
  DocumentSourceReadResponse,
} from "@aao/integration-documents";

export const OVERLAPPING_DOC_REF = "fixture.contract-001";

export const NORTHSTAR_DOC_TEXT =
  "Northstar Commerce Master Supplier Agreement 2026.\n" +
  "1. Payment Terms: Supplier invoices are payable within 30 days of invoice receipt by Northstar Commerce.\n" +
  "2. Delivery SLA: The supplier guarantees a 99.9% on-time fulfillment rate across all distribution centers.\n" +
  "3. Liability Cap: Aggregate supplier liability under this agreement is strictly capped at annual fees paid.\n" +
  "4. Data Protection: Supplier maintains SOC 2 compliance and notifies Northstar within 48 hours of any security incident.";

export const ARBOR_DOC_TEXT =
  "Arbor Consulting Master Services Agreement 2026.\n" +
  "1. Consulting Fees: Client shall pay professional fees billed monthly at standard advisory rates, payable net 15 days.\n" +
  "2. Intellectual Property: All deliverables and work product become sole property of Client upon full fee payment.\n" +
  "3. Engagement Term: The initial engagement term is 12 months with mutual 30-day written termination notice.\n" +
  "4. Confidentiality: Both parties agree to protect proprietary engagement findings and board materials for 5 years.";

export interface FixtureDocumentSourceProvider extends DocumentSourceProvider {
  readonly calls: readonly { ref: string; signalPresent: boolean }[];
  clearCalls(): void;
}

export function createNorthstarDocumentProvider(): FixtureDocumentSourceProvider {
  const calls: { ref: string; signalPresent: boolean }[] = [];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(NORTHSTAR_DOC_TEXT);

  return {
    get calls() {
      return Object.freeze([...calls]);
    },
    clearCalls() {
      calls.length = 0;
    },
    async read(
      request: DocumentSourceReadRequest,
      context: DocumentSourceProviderContext
    ): Promise<DocumentSourceReadResponse> {
      calls.push({ ref: request.documentRef, signalPresent: Boolean(context.signal) });

      if (request.documentRef === OVERLAPPING_DOC_REF || request.documentRef === "doc://northstar/supplier-agreement.txt") {
        return {
          status: "succeeded",
          filename: "northstar-supplier-agreement.txt",
          mimeType: "text/plain",
          bytes: new Uint8Array(bytes),
        };
      }

      return { status: "failed", reason: "not_found" };
    },
  };
}

export function createArborDocumentProvider(): FixtureDocumentSourceProvider {
  const calls: { ref: string; signalPresent: boolean }[] = [];
  const encoder = new TextEncoder();
  const bytes = encoder.encode(ARBOR_DOC_TEXT);

  return {
    get calls() {
      return Object.freeze([...calls]);
    },
    clearCalls() {
      calls.length = 0;
    },
    async read(
      request: DocumentSourceReadRequest,
      context: DocumentSourceProviderContext
    ): Promise<DocumentSourceReadResponse> {
      calls.push({ ref: request.documentRef, signalPresent: Boolean(context.signal) });

      if (request.documentRef === OVERLAPPING_DOC_REF || request.documentRef === "doc://arbor/master-services.txt") {
        return {
          status: "succeeded",
          filename: "arbor-master-services.txt",
          mimeType: "text/plain",
          bytes: new Uint8Array(bytes),
        };
      }

      return { status: "failed", reason: "not_found" };
    },
  };
}
