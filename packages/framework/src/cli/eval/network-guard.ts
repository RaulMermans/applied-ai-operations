// Offline guard for the Eval commands (Sprint 18 semantics, ADR-023; moved
// into the canonical CLI in Sprint 19). The default gate needs no API key,
// OAuth, external service, remote MCP server, or Internet. Any attempt to
// open a network connection from this process is refused and recorded;
// local child processes over stdio (the MCP test server) are not network
// access and are unaffected.
import dns from "node:dns";
import net from "node:net";

export interface NetworkGuard {
  attempts(): string[];
  uninstall(): void;
}

export function installNetworkGuard(): NetworkGuard {
  const attempts: string[] = [];
  const deny = (what: string) =>
    function denied(): never {
      attempts.push(what);
      throw new Error(`AAO_EVAL_NETWORK_FORBIDDEN: ${what}`);
    };
  const originalFetch = globalThis.fetch;
  const originalConnect = net.Socket.prototype.connect;
  const originalLookup = dns.lookup;
  globalThis.fetch = deny("fetch") as unknown as typeof fetch;
  net.Socket.prototype.connect = deny("net.Socket.connect") as unknown as typeof net.Socket.prototype.connect;
  (dns as { lookup: unknown }).lookup = deny("dns.lookup");
  return {
    attempts: () => [...attempts],
    uninstall: () => {
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      (dns as { lookup: unknown }).lookup = originalLookup;
    },
  };
}
