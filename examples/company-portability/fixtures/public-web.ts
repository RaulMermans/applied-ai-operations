import type {
  PublicWebFetchRequest,
  PublicWebFetchResponse,
  PublicWebProvider,
  PublicWebProviderContext,
  PublicWebSearchRequest,
  PublicWebSearchResponse,
} from "@aao/integration-public-web";

export interface FixtureWebProvider extends PublicWebProvider {
  readonly calls: { search: string[]; fetch: string[] };
  clearCalls(): void;
}

export const NORTHSTAR_CORPUS = {
  home: {
    url: "https://northstar.example/",
    title: "Northstar Commerce — Unified Retail Operations",
    text: "Northstar Commerce provides inventory synchronization and omnichannel checkout for retail brands. Serves 200+ retail brands across North America.",
  },
  customers: {
    url: "https://northstar.example/customers",
    title: "Northstar Customers — Enterprise Retail Brands",
    text: "Northstar Commerce is used by enterprise retail brands and high-growth direct-to-consumer merchants.",
  },
  differentiation: {
    url: "https://news.example/2026/northstar-launch",
    title: "Northstar Launches Real-Time Inventory Sync",
    text: "Northstar Commerce differentiates through sub-second POS inventory replication and zero-downtime catalog migrations.",
  },
};

export const ARBOR_CORPUS = {
  home: {
    url: "https://arbor.example/",
    title: "Arbor Consulting — Strategic Management Advisory",
    text: "Arbor Consulting delivers corporate transformation and digital strategy for Fortune 500 institutions. Focuses on financial services and healthcare sectors.",
  },
  clients: {
    url: "https://arbor.example/clients",
    title: "Clients | Arbor Consulting",
    text: "Arbor Consulting advises executive leadership teams and board committees across Europe and North America.",
  },
  differentiation: {
    url: "https://news.example/2026/arbor-insight",
    title: "Arbor Consulting Publishes Enterprise Strategy Study",
    text: "Arbor Consulting distinguishes its practice through evidence-anchored workflow audits and deterministic operating models.",
  },
};

export function createNorthstarWebProvider(): FixtureWebProvider {
  const calls = { search: [] as string[], fetch: [] as string[] };

  return {
    calls,
    clearCalls() {
      calls.search.length = 0;
      calls.fetch.length = 0;
    },
    async search(
      request: PublicWebSearchRequest,
      _context: PublicWebProviderContext
    ): Promise<PublicWebSearchResponse> {
      calls.search.push(request.query);
      const hits = [
        {
          url: NORTHSTAR_CORPUS.home.url,
          title: NORTHSTAR_CORPUS.home.title,
          snippet: NORTHSTAR_CORPUS.home.text,
        },
        {
          url: NORTHSTAR_CORPUS.customers.url,
          title: NORTHSTAR_CORPUS.customers.title,
          snippet: NORTHSTAR_CORPUS.customers.text,
        },
        {
          url: NORTHSTAR_CORPUS.differentiation.url,
          title: NORTHSTAR_CORPUS.differentiation.title,
          snippet: NORTHSTAR_CORPUS.differentiation.text,
        },
      ];
      return { status: "succeeded", hits };
    },
    async fetch(
      request: PublicWebFetchRequest,
      _context: PublicWebProviderContext
    ): Promise<PublicWebFetchResponse> {
      calls.fetch.push(request.url);
      const found = Object.values(NORTHSTAR_CORPUS).find((p) => p.url === request.url);
      if (!found) {
        return { status: "failed", reason: "not_found" };
      }
      return { status: "succeeded", title: found.title, text: found.text };
    },
  };
}

export function createArborWebProvider(): FixtureWebProvider {
  const calls = { search: [] as string[], fetch: [] as string[] };

  return {
    calls,
    clearCalls() {
      calls.search.length = 0;
      calls.fetch.length = 0;
    },
    async search(
      request: PublicWebSearchRequest,
      _context: PublicWebProviderContext
    ): Promise<PublicWebSearchResponse> {
      calls.search.push(request.query);
      const hits = [
        {
          url: ARBOR_CORPUS.home.url,
          title: ARBOR_CORPUS.home.title,
          snippet: ARBOR_CORPUS.home.text,
        },
        {
          url: ARBOR_CORPUS.clients.url,
          title: ARBOR_CORPUS.clients.title,
          snippet: ARBOR_CORPUS.clients.text,
        },
        {
          url: ARBOR_CORPUS.differentiation.url,
          title: ARBOR_CORPUS.differentiation.title,
          snippet: ARBOR_CORPUS.differentiation.text,
        },
      ];
      return { status: "succeeded", hits };
    },
    async fetch(
      request: PublicWebFetchRequest,
      _context: PublicWebProviderContext
    ): Promise<PublicWebFetchResponse> {
      calls.fetch.push(request.url);
      const found = Object.values(ARBOR_CORPUS).find((p) => p.url === request.url);
      if (!found) {
        return { status: "failed", reason: "not_found" };
      }
      return { status: "succeeded", title: found.title, text: found.text };
    },
  };
}
