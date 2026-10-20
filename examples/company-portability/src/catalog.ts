import type {
  ModelAdapterDefinition,
  ModelBindingDefinition,
} from "@aao/framework";
import type { PublicWebProvider } from "@aao/integration-public-web";
import type { DocumentSourceProvider } from "@aao/integration-documents";
import type { OperationalDraftRepository } from "@aao/example-operational-request";

export interface HostCapabilityCatalog {
  getModelAdapter(ref: string): ModelAdapterDefinition | undefined;
  getModelBinding(ref: string): ModelBindingDefinition | undefined;
  getPublicWebProvider(ref: string): PublicWebProvider | undefined;
  getDocumentSourceProvider(ref: string): DocumentSourceProvider | undefined;
  getDraftRepository(ref: string): OperationalDraftRepository | undefined;
}

export interface CreateHostCapabilityCatalogOptions {
  modelAdapters?: Iterable<[string, ModelAdapterDefinition]> | Record<string, ModelAdapterDefinition>;
  modelBindings?: Iterable<[string, ModelBindingDefinition]> | Record<string, ModelBindingDefinition>;
  publicWebProviders?: Iterable<[string, PublicWebProvider]> | Record<string, PublicWebProvider>;
  documentSourceProviders?: Iterable<[string, DocumentSourceProvider]> | Record<string, DocumentSourceProvider>;
  draftRepositories?: Iterable<[string, OperationalDraftRepository]> | Record<string, OperationalDraftRepository>;
}

function toMap<T>(
  input?: Iterable<[string, T]> | Record<string, T>
): Map<string, T> {
  const entries = !input ? [] : Symbol.iterator in input
    ? input as Iterable<[string, T]>
    : Object.entries(input);
  const snapshot = new Map<string, T>();
  for (const [ref, capability] of entries) {
    if (snapshot.has(ref)) {
      throw new Error(`Duplicate host capability reference: '${ref}'`);
    }
    snapshot.set(ref, capability);
  }
  return snapshot;
}

/**
 * Creates an immutable host capability catalog containing explicitly registered
 * capabilities that company manifests may reference.
 *
 * The catalog is host-owned and verified at composition time:
 * - Manifests contain only declarative string references.
 * - Dynamic imports, eval, reflection, and remote code loading are prohibited.
 * - Missing or unregistered capability references fail closed before workflow execution.
 */
export function createHostCapabilityCatalog(
  options: CreateHostCapabilityCatalogOptions = {}
): HostCapabilityCatalog {
  const modelAdapters = toMap(options.modelAdapters);
  const modelBindings = toMap(options.modelBindings);
  const publicWebProviders = toMap(options.publicWebProviders);
  const documentSourceProviders = toMap(options.documentSourceProviders);
  const draftRepositories = toMap(options.draftRepositories);

  return Object.freeze({
    getModelAdapter(ref: string) {
      return modelAdapters.get(ref);
    },
    getModelBinding(ref: string) {
      return modelBindings.get(ref);
    },
    getPublicWebProvider(ref: string) {
      return publicWebProviders.get(ref);
    },
    getDocumentSourceProvider(ref: string) {
      return documentSourceProviders.get(ref);
    },
    getDraftRepository(ref: string) {
      return draftRepositories.get(ref);
    },
  });
}
