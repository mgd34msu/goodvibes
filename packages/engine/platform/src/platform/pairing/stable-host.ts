/**
 * stable-host.ts, the one rule for the host another device dials: the host in
 * a printed link, a pairing QR, `web.publicBaseUrl`, and the URL an agent
 * reports. Every surface (daemon, TUI, Agent) resolves a wildcard bind here.
 *
 * Resolution ladder (highest preference first):
 *   1. Tailscale MagicDNS name, when tailscale is up. It resolves on and off
 *      the LAN and is never bound to a DHCP lease.
 *   2. mDNS `<hostname>.local`, only when the name was looked up and came back
 *      with one of this host's addresses. Many hosts do not advertise their
 *      `.local` name; a link built on it would open to a DNS error.
 *   3. The address of the interface that carries the default route.
 *   4. The first non-internal IPv4 the OS lists (can be a bridge or VPN).
 *   5. Loopback, nothing routable enumerated.
 * When a name wins (1 or 2), the routable address is returned beside it as
 * `alternateHost`, so a surface can print a working fallback under the QR.
 *
 * Every rung yields a host the transport and the web UI accept for plain http
 * (`isPrivateNetworkHost` admits tailnet names, and a 100.64/10 address only
 * when it is stated to be a Tailscale address: the Tailscale probe below states
 * the addresses Tailscale reports, or the owner lists them in
 * `GOODVIBES_TAILNET_ADDRESSES`).
 *
 * Probing: interfaces, the hostname and (on Linux) the default-route interface
 * from /proc/net/route are cheap synchronous reads taken on every call. The two
 * slow facts, the Tailscale state and the `.local` lookup, are gathered
 * asynchronously by `refreshStableHostInputs` and cached for the process. A
 * synchronous call never waits on them: before the first refresh it resolves
 * without them (a routable address), and once a process has refreshed, a call
 * that finds the cache older than a minute refreshes it in the background. A
 * one-shot command that wants the full ladder awaits `refreshStableHostInputs`
 * first; a long-lived one starts it when it starts serving.
 */
import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { hostname as osHostname, networkInterfaces } from 'node:os';
import { stateTailnetAddresses } from '@goodvibes-jev/engine/transport-http/paths';

export type StableHostKind =
  | 'tailscale-magicdns'
  | 'mdns-local'
  | 'gateway-interface'
  | 'first-interface'
  | 'bind-host'
  | 'public-url'
  | 'loopback';

export interface TailscaleState {
  /** BackendState === 'Running'. */
  readonly up: boolean;
  /** Self.DNSName from `tailscale status --json`, trailing dot stripped. */
  readonly magicDnsName?: string | undefined;
}

export interface StableHostInputs {
  /** os.hostname(), possibly an FQDN, the `.local` name derives from its first label. */
  readonly hostname: string;
  /** The routable IPv4 on the default-route interface, when known. */
  readonly gatewayInterfaceIp?: string | undefined;
  /** First non-internal IPv4 in enumeration order, the last-resort address. */
  readonly firstNonInternalIp?: string | undefined;
  /** Tailscale state, when the CLI is present and answered in time. */
  readonly tailscale?: TailscaleState | undefined;
  /** True only when `<hostname>.local` was looked up and resolved to one of this host's addresses. */
  readonly mdnsResolvesToThisHost?: boolean | undefined;
}

export interface ResolvedStableHost {
  readonly host: string;
  readonly kind: StableHostKind;
  /** True when `host` is a name that survives a DHCP lease change. */
  readonly stable: boolean;
  /** The routable address, present when `host` is a name: the fallback to print beside it. */
  readonly alternateHost?: string | undefined;
}

function stripTrailingDot(name: string): string {
  return name.replace(/\.+$/, '');
}

/** `<hostname>.local` from the first label of a hostname, or null when there is no usable label. */
export function mdnsLocalName(host: string): string | null {
  const label = (host ?? '').trim().split('.')[0]?.trim();
  if (!label || label.toLowerCase() === 'localhost') return null;
  // Already a `.local` name (hostname was set to the mDNS form): keep it as-is.
  if (host.trim().toLowerCase().endsWith('.local')) return stripTrailingDot(host.trim());
  return `${label}.local`;
}

/** Resolve the host from injected inputs. Pure, no I/O. */
export function resolveStableHost(inputs: StableHostInputs): ResolvedStableHost {
  const gateway = inputs.gatewayInterfaceIp?.trim();
  const first = inputs.firstNonInternalIp?.trim();
  const routable = gateway || first;
  const alternate = routable ? { alternateHost: routable } : {};

  const magic = inputs.tailscale?.up ? inputs.tailscale.magicDnsName?.trim() : undefined;
  if (magic) return { host: stripTrailingDot(magic), kind: 'tailscale-magicdns', stable: true, ...alternate };

  const local = inputs.mdnsResolvesToThisHost === true ? mdnsLocalName(inputs.hostname) : null;
  if (local) return { host: local, kind: 'mdns-local', stable: true, ...alternate };

  if (gateway) return { host: gateway, kind: 'gateway-interface', stable: false };
  if (first) return { host: first, kind: 'first-interface', stable: false };
  return { host: '127.0.0.1', kind: 'loopback', stable: false };
}

/** First non-internal IPv4 in enumeration order, the last-resort address. */
export function firstNonInternalIpv4(nets: ReturnType<typeof networkInterfaces>): string | undefined {
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] ?? []) {
      if (netInfo.family === 'IPv4' && !netInfo.internal) return netInfo.address;
    }
  }
  return undefined;
}

/**
 * The interface carrying the default IPv4 route, from Linux `/proc/net/route`
 * text: the destination-0/mask-0 row with the lowest metric.
 */
export function parseDefaultRouteInterface(table: string): string | undefined {
  let best: { iface: string; metric: number } | undefined;
  for (const line of table.split('\n').slice(1)) {
    const [iface, destination, , flags, , , metric, mask] = line.trim().split(/\s+/);
    if (!iface || destination !== '00000000' || mask !== '00000000') continue;
    // RTF_UP (0x1) must be set.
    if ((Number.parseInt(flags ?? '0', 16) & 0x1) === 0) continue;
    const value = Number(metric ?? 0);
    if (!best || value < best.metric) best = { iface, metric: value };
  }
  return best?.iface;
}

/** The non-internal IPv4 of the named interface. */
export function interfaceIpv4(nets: ReturnType<typeof networkInterfaces>, name: string): string | undefined {
  return (nets[name] ?? []).find((netInfo) => netInfo.family === 'IPv4' && !netInfo.internal)?.address;
}

/** The string entries of a `TailscaleIPs` field. */
function tailscaleIps(node: unknown): string[] {
  const ips = node !== null && typeof node === 'object' ? (node as { TailscaleIPs?: unknown }).TailscaleIPs : undefined;
  return Array.isArray(ips) ? ips.filter((ip): ip is string => typeof ip === 'string') : [];
}

/** Parse `Self.DNSName` + running state out of `tailscale status --json` output. */
export function parseTailscaleStatus(json: string): TailscaleState | undefined {
  try {
    const parsed = JSON.parse(json) as { BackendState?: unknown; Self?: { DNSName?: unknown } };
    const up = parsed.BackendState === 'Running';
    const dnsName = typeof parsed.Self?.DNSName === 'string' ? stripTrailingDot(parsed.Self.DNSName) : undefined;
    return { up, ...(dnsName ? { magicDnsName: dnsName } : {}) };
  } catch {
    return undefined;
  }
}

/** This machine's and its peers' addresses (`TailscaleIPs`) from a running Tailscale's `status --json` output. */
function runningTailnetAddresses(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { BackendState?: unknown; Self?: unknown; Peer?: unknown };
    if (parsed.BackendState !== 'Running') return [];
    const peers = parsed.Peer !== null && typeof parsed.Peer === 'object' ? Object.values(parsed.Peer as Record<string, unknown>) : [];
    return [...tailscaleIps(parsed.Self), ...peers.flatMap(tailscaleIps)];
  } catch {
    return [];
  }
}

/** This host's non-internal addresses, IPv6 zone ids dropped. */
function localAddresses(nets: ReturnType<typeof networkInterfaces>): Set<string> {
  const out = new Set<string>();
  for (const name of Object.keys(nets)) {
    for (const netInfo of nets[name] ?? []) {
      if (!netInfo.internal) out.add(netInfo.address.replace(/%.*$/, '').toLowerCase());
    }
  }
  return out;
}

/** True when any looked-up address is one of this host's own addresses. */
export function resolvesToThisHost(addresses: readonly string[], nets: ReturnType<typeof networkInterfaces>): boolean {
  const own = localAddresses(nets);
  return addresses.some((address) => own.has(address.replace(/%.*$/, '').toLowerCase()));
}

function safeHostname(): string {
  try {
    return osHostname();
  } catch {
    return '';
  }
}

function safeInterfaces(): ReturnType<typeof networkInterfaces> {
  try {
    return networkInterfaces();
  } catch {
    return {};
  }
}

function readDefaultRouteInterface(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try {
    return parseDefaultRouteInterface(readFileSync('/proc/net/route', 'utf8'));
  } catch {
    return undefined;
  }
}

const PROBE_TIMEOUT_MS = 1500;
const MDNS_LOOKUP_TIMEOUT_MS = 1000;
const SLOW_FACTS_TTL_MS = 60_000;

interface SlowFacts {
  readonly at: number;
  readonly hostname: string;
  readonly tailscale?: TailscaleState | undefined;
  readonly mdnsResolvesToThisHost: boolean;
}

let slowFacts: SlowFacts | undefined;
let refreshing: Promise<StableHostInputs> | undefined;

function probeTailscaleState(): Promise<TailscaleState | undefined> {
  return new Promise((resolve) => {
    try {
      const child = execFile('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        // Tailscale's own list is the fact that a 100.64/10 address is a tailnet address
        // (not carrier-grade NAT): the transport accepts plain http to exactly these.
        stateTailnetAddresses(runningTailnetAddresses(stdout));
        resolve(parseTailscaleStatus(stdout));
      });
      // A probe never holds a finishing process open.
      child.unref();
    } catch {
      resolve(undefined);
    }
  });
}

async function probeMdnsResolvesToThisHost(hostname: string): Promise<boolean> {
  const name = mdnsLocalName(hostname);
  if (!name) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MDNS_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const found = await Promise.race([lookup(name, { all: true }).catch(() => null), deadline]);
    return found !== null && resolvesToThisHost(found.map((entry) => entry.address), safeInterfaces());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cheapInputs(): StableHostInputs {
  const nets = safeInterfaces();
  const first = firstNonInternalIpv4(nets);
  const routeInterface = readDefaultRouteInterface();
  const gateway = routeInterface ? interfaceIpv4(nets, routeInterface) : undefined;
  return {
    hostname: safeHostname(),
    ...(gateway ? { gatewayInterfaceIp: gateway } : {}),
    ...(first ? { firstNonInternalIp: first } : {}),
  };
}

function withSlowFacts(inputs: StableHostInputs, facts: SlowFacts | undefined): StableHostInputs {
  if (!facts || facts.hostname !== inputs.hostname) return inputs;
  return {
    ...inputs,
    ...(facts.tailscale ? { tailscale: facts.tailscale } : {}),
    mdnsResolvesToThisHost: facts.mdnsResolvesToThisHost,
  };
}

/**
 * Gather every input, the slow facts included, without blocking the thread,
 * and cache the slow facts for later synchronous calls. Concurrent callers
 * share one probe. Never rejects.
 */
export function refreshStableHostInputs(): Promise<StableHostInputs> {
  refreshing ??= (async () => {
    const hostname = safeHostname();
    const [tailscale, mdnsResolves] = await Promise.all([
      probeTailscaleState(),
      probeMdnsResolvesToThisHost(hostname).catch(() => false),
    ]);
    slowFacts = { at: Date.now(), hostname, ...(tailscale ? { tailscale } : {}), mdnsResolvesToThisHost: mdnsResolves };
    return withSlowFacts(cheapInputs(), slowFacts);
  })().finally(() => { refreshing = undefined; });
  return refreshing;
}

/**
 * The inputs available right now, without waiting: the cheap facts plus the
 * cached slow facts. Before this process's first refresh the Tailscale and
 * `.local` rungs are skipped; a stale cache is refreshed in the background.
 */
export function probeStableHostInputs(): StableHostInputs {
  if (slowFacts && Date.now() - slowFacts.at > SLOW_FACTS_TTL_MS) void refreshStableHostInputs();
  return withSlowFacts(cheapInputs(), slowFacts);
}

/** True for the wildcard bind addresses, the only binds the ladder resolves. */
export function isWildcardBindHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

/**
 * The host for a printed/QR link given the endpoint's bind host. A wildcard
 * bind resolves through the ladder; an explicit bind host is honored as-is
 * (loopback stays loopback). `probe` is injectable for tests.
 */
export function stableUrlHostForBindHost(
  host: string,
  probe: () => StableHostInputs = probeStableHostInputs,
): ResolvedStableHost {
  if (isWildcardBindHost(host)) return resolveStableHost(probe());
  const bound = host || '127.0.0.1';
  return { host: bound, kind: bound === '127.0.0.1' ? 'loopback' : 'bind-host', stable: false };
}
