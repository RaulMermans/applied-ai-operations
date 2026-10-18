import type {
  ModelAdapterDefinition,
  ModelBindingDefinition,
} from "@aao/framework";
import type { PublicWebProvider } from "@aao/integration-public-web";
import type { DocumentSourceProvider } from "@aao/integration-documents";
import type { OperationalDraftRepository } from "@aao/example-operational-request";

export interface HostCapabilityCatalog {
  readonly modelAdapters: ReadonlyMap<string, ModelAdapterDefinition>;
  readonly modelBindings: ReadonlyMap<string, ModelBindingDefinition>;
  readonly publicWebProviders: ReadonlyMap<string, PublicWebProvider>;
  readonly documentSourceProviders: ReadonlyMap<string, DocumentSourceProvider>;
  readonly draftRepositories: ReadonlyMap<string, OperationalDraftRepository>;

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
  if (!input) return new Map();
  if (Symbol.iterator in input) {
    return new Map(input as Iterable<[string, T]>);
  }
  return new Map(Object.entries(input));
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
  const modelAdapters = Object.freeze(toMap(options.modelAdapters));
  const modelBindings = Object.freeze(toMap(options.modelBindings));
  const publicWebProviders = Object.freeze(toMap(options.publicWebProviders));
  const documentSourceProviders = Object.freeze(toMap(options.documentSourceProviders));
  const draftRepositories = Object.freeze(toMap(options.draftRepositories));

  return Object.freeze({
    modelAdapters,
    modelBindings,
    publicWebProviders,
    documentSourceProviders,
    draftRepositories,

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
