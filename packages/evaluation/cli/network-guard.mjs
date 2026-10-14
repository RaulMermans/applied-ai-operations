// Offline guard for the default Eval CI commands (Sprint 18, ADR-023).
// The mandatory gate needs no API key, OAuth, external service, MCP remote
// server, or Internet. Any attempt to open a network connection from this
// process is refused and recorded; local child processes over stdio (the
// MCP test server) are not network access and are unaffected.
import dns from 'node:dns';
import net from 'node:net';

export function installNetworkGuard() {
  const attempts = [];
  const deny = (what) => function denied() {
    attempts.push(what);
    throw new Error(`AAO_EVAL_NETWORK_FORBIDDEN: ${what}`);
  };
  const restore = [
    [globalThis, 'fetch', globalThis.fetch],
    [net.Socket.prototype, 'connect', net.Socket.prototype.connect],
    [dns, 'lookup', dns.lookup],
  ];
  globalThis.fetch = deny('fetch');
  net.Socket.prototype.connect = deny('net.Socket.connect');
  dns.lookup = deny('dns.lookup');
  return {
    attempts: () => [...attempts],
    uninstall: () => { for (const [target, key, original] of restore) target[key] = original; },
  };
}
