/**
 * Requests to this machine never go through a proxy.
 *
 * Bun's fetch sends every request, `http://127.0.0.1` included, through
 * `HTTP_PROXY`/`HTTPS_PROXY` unless `NO_PROXY` names the host; a proxy would
 * then receive the daemon's operator token and a local model server's traffic.
 * Bun reads the proxy variables on every request, matches `NO_PROXY` entries as
 * plain host suffixes (no address ranges), and prefers `no_proxy` over
 * `NO_PROXY` when both are set. So while a proxy variable is set, both
 * spellings carry the owner's entries plus `localhost`, `127.0.0.1`, `[::1]`
 * and `::1` (the last for child programs such as curl), and any other loopback
 * host a request names (another 127/8 address, or the wildcard `0.0.0.0` or
 * `::`, which as a dial target reach this machine) is added the first
 * time a request goes to it. Child processes inherit the same list.
 *
 * Which host is loopback is decided by {@link isLoopbackHost} alone. Imports
 * nothing else, so a program can call it before anything loads; in a browser
 * (no `process.env`) it does nothing.
 */
import { isLoopbackHost } from './private-network.js';

const PROXY_VARIABLES = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy'] as const;
const STANDARD_LOOPBACK_ENTRIES = ['localhost', '127.0.0.1', '[::1]', '::1'] as const;

/** A request to this host reaches this machine: loopback, or a wildcard address used as a dial target. */
function reachesThisMachine(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return isLoopbackHost(host) || host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0';
}

/** Hosts already in both NO_PROXY spellings in this process, so a request checks one set. */
const exempted = new Set<string>();

function processEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }).process?.env;
}

function proxyConfigured(env: Record<string, string | undefined>): boolean {
  // Read by name: Bun materializes the standard proxy keys lazily, so they may not enumerate.
  return PROXY_VARIABLES.some((name) => (env[name] ?? '').trim().length > 0);
}

function entriesOf(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

/** The host as a NO_PROXY entry: Bun compares URL hostnames, which keep IPv6 brackets. */
function entryFor(hostname: string): string {
  const host = hostname.trim().toLowerCase();
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Exempts loopback from any proxy set for this process: the standard loopback
 * names always, and `hostname` too when it is a loopback host. Cheap enough for
 * every request: with no proxy variable set, or the host already exempted, it
 * reads a few environment entries and returns.
 */
export function exemptLoopbackFromProxy(hostname?: string): void {
  const env = processEnv();
  if (!env || !proxyConfigured(env)) return;
  const wanted: string[] = [];
  for (const entry of STANDARD_LOOPBACK_ENTRIES) if (!exempted.has(entry)) wanted.push(entry);
  if (hostname !== undefined && reachesThisMachine(hostname)) {
    const entry = entryFor(hostname);
    if (!exempted.has(entry)) wanted.push(entry);
  }
  if (wanted.length === 0) return;
  // Both spellings get the union of the owner's entries: Bun reads only
  // `no_proxy` when it is set, and a child program may read either.
  const current = [...entriesOf(env['no_proxy']), ...entriesOf(env['NO_PROXY'])];
  if (current.includes('*')) {
    for (const entry of wanted) exempted.add(entry);
    return;
  }
  const merged = [...new Set([...current, ...wanted])].join(',');
  env['no_proxy'] = merged;
  env['NO_PROXY'] = merged;
  for (const entry of wanted) exempted.add(entry);
}
