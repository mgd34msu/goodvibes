/**
 * destination.ts, the one owner of where an outbound request may go.
 *
 * A network destination is a value whose rule travels with it. Every caller
 * that sends a request to a URL it did not write itself (the fetch tool, the
 * browser, voice audio by URL, a delivery to an owner-configured webhook)
 * names its purpose; the purpose's rule says which schemes are allowed,
 * whether private-network and loopback answers may be reached and how, and
 * whether redirects are followed. `checkDestination` resolves the host (every
 * A and AAAA answer) and checks each answer by address arithmetic
 * (`classifyResolvedAddress`); only it makes a `CheckedDestination`, and
 * `egress` connects only to an address it checked (the written name kept for
 * the Host header, TLS SNI and the certificate check), rechecks every
 * redirect hop under the same purpose, and never sends loopback through a
 * proxy. Which host is loopback is answered only by `isLoopbackHost`
 * (transport-http/src/private-network.ts).
 *
 * Cost: one DNS lookup per checked host (none for an address literal); the
 * fetch tool already paid it. A browser context resolves each host once.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import { exemptLoopbackFromProxy, isLoopbackHost } from '@goodvibes/engine/transport-http/paths';
import { currentExecutionMode } from '../../gate/execution-context.js';
import { assertDeliveryCurrent, runDeliveryPublication, type DeliveryLifetime } from '../../utils/delivery-lifetime.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';

// ── Addresses ─────────────────────────────────────────────────────────────

/** One DNS answer. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Resolves a host name to every A and AAAA answer. */
export type HostResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** The system resolver: every answer, in the order the resolver gives them. */
export const systemResolver: HostResolver = async (hostname) => lookup(hostname, { all: true, verbatim: true });

/** A hop's host as the URL grammar gives it, without IPv6 brackets. */
const bareHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');



/** What a resolved address is, when it is one a fetch must not reach by a name. */
export type ResolvedAddressRange = 'loopback' | 'private' | 'link-local' | 'metadata' | 'unspecified' | 'unique-local' | 'multicast' | 'shared' | 'reserved';

const ipv4Octets = (address: string): number[] | null => {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
};

/** The IPv4 address an IPv4-mapped IPv6 address (::ffff:a.b.c.d or ::ffff:hhhh:hhhh) carries. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith('::ffff:')) return null;
  const rest = lower.slice(7);
  if (ipv4Octets(rest)) return rest;
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
  if (!hex) return null;
  const high = parseInt(hex[1]!, 16);
  const low = parseInt(hex[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** The eight 16-bit groups of an IPv6 address (with `::` and a trailing dotted IPv4 expanded), or null. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = ipv4Octets(dotted[2]!);
    if (!octets) return null;
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function classifyIpv4(octets: readonly number[]): ResolvedAddressRange | null {
  const [a, b, c, d] = octets as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) return c === 169 && d === 254 ? 'metadata' : 'link-local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'shared';
  if ((a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0 && c === 0)) return 'reserved';
  if (a >= 224) return 'multicast';
  return null;
}

/**
 * The declared range a resolved address falls in, or null for an address a
 * fetch may reach. The ranges are the address assignments themselves: IPv4
 * 0.0.0.0/8 (this host), 127.0.0.0/8 (loopback), 10.0.0.0/8, 172.16.0.0/12 and
 * 192.168.0.0/16 (private), 169.254.0.0/16 (link-local, where 169.254.169.254
 * is the cloud metadata endpoint), 100.64.0.0/10 (carrier-grade NAT, where some
 * clouds put their metadata endpoint), 198.18.0.0/15 and 192.0.0.0/24
 * (reserved), 224.0.0.0/3 (multicast and reserved);
 * IPv6 :: and ::1, fe80::/10 (link-local), fec0::/10 (site-local), fc00::/7
 * (unique-local), ff00::/8 (multicast), and addresses that carry an IPv4
 * (IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16) by the IPv4
 * they carry. Comparing an address with these ranges is arithmetic on the
 * address.
 */
export function classifyResolvedAddress(address: string): ResolvedAddressRange | null {
  const v4 = ipv4Octets(address) ?? (() => { const mapped = mappedIpv4(address); return mapped ? ipv4Octets(mapped) : null; })();
  if (v4) return classifyIpv4(v4);
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  const groups = ipv6Groups(lower);
  if (groups) {
    const embedded = (high: number, low: number): number[] => [high >> 8, high & 255, low >> 8, low & 255];
    if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) {
      const range = classifyIpv4(embedded(groups[6]!, groups[7]!));
      if (range !== null) return range;
    }
    if (groups[0] === 0x2002) {
      const range = classifyIpv4(embedded(groups[1]!, groups[2]!));
      if (range !== null) return range;
    }
  }
  if (lower === '::' ) return 'unspecified';
  if (lower === '::1') return 'loopback';
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if ((first & 0xffc0) === 0xfec0) return 'reserved';
  if ((first & 0xfe00) === 0xfc00) return 'unique-local';
  if ((first & 0xff00) === 0xff00) return 'multicast';
  return null;
}


/**
 * Whether an address is in a range the caller may reach when it wrote the host
 * itself: private networks (10/8, 172.16/12, 192.168/16, where LAN devices and
 * containers live), IPv6 unique-local, and plain IPv4 carrier-grade NAT
 * (100.64/10, where VPN overlays put their peers) except the cloud metadata
 * endpoint 100.100.100.200. Loopback has its own approval; link-local (the
 * metadata range), reserved, multicast and unspecified addresses never are.
 */
export function isCallerReachablePrivateAddress(address: string): boolean {
  const range = classifyResolvedAddress(address);
  if (range === 'private' || range === 'unique-local') return true;
  return range === 'shared' && ipv4Octets(address) !== null && address !== '100.100.100.200';
}


/**
 * Sends the request to a checked address, trying the next one when a
 * connection cannot be made (an HTTP response of any status is final). A
 * request that is not GET, HEAD or OPTIONS is tried on the next address only
 * after a refused or unreachable connection, never after a reset. The URL carries the address; the
 * Host header carries the written host and port; for https the TLS server name
 * and the certificate check use the written host, so the certificate must be
 * valid for the name the caller asked for.
 */
export async function pinnedFetch(
  url: string,
  init: RequestInit,
  addresses: readonly ResolvedAddress[],
  diagnosticMode: 'default' | 'opaque-url' = 'default',
  assertCurrent?: () => void,
  withPublication?: DeliveryLifetime['withPublication'],
): Promise<Response> {
  const host = bareHost(new URL(url));
  const lifetime = { signal: init.signal ?? undefined, assertCurrent: () => {
    currentExecutionMode();
    assertCurrent?.();
  }, withPublication };
  assertDeliveryCurrent(lifetime);
  if (isIP(host)) {
    exemptLoopbackFromProxy(host);
    return runDeliveryPublication(lifetime, () => instrumentedFetch(url, init, diagnosticMode));
  }
  let lastError: unknown;
  for (const address of addresses) {
    assertDeliveryCurrent(lifetime);
    try {
      return await runDeliveryPublication(lifetime, () => fetchAddress(url, init, host, address, diagnosticMode));
    } catch (error) {
      if (init.signal?.aborted) throw error;
      // A request with side effects is repeated against another address only
      // when the failed attempt provably never reached a server: after the
      // body is sent a reset says nothing about whether it was processed.
      if (!isRepeatable(init.method) && !isConnectRefusal(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

const REPEATABLE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const isRepeatable = (method: string | undefined): boolean => REPEATABLE_METHODS.has((method ?? 'GET').toUpperCase());

const CONNECT_REFUSAL_CODES = new Set(['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ConnectionRefused', 'FailedToOpenSocket']);
function isConnectRefusal(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CONNECT_REFUSAL_CODES.has(code);
}

async function fetchAddress(url: string, init: RequestInit, host: string, address: ResolvedAddress, diagnosticMode: 'default' | 'opaque-url'): Promise<Response> {
  const parsed = new URL(url);
  const pinned = new URL(url);
  pinned.hostname = address.family === 6 ? `[${address.address}]` : address.address;
  const headers = new Headers(init.headers);
  headers.set('host', parsed.host);
  const tls = parsed.protocol === 'https:'
    ? { tls: { serverName: host, checkServerIdentity: (_name: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert) } }
    : {};
  // A checked loopback address is this machine: never sent through a proxy.
  exemptLoopbackFromProxy(pinned.hostname);
  return instrumentedFetch(pinned.toString(), { ...init, headers, ...tls } as RequestInit, diagnosticMode);
}

// ── Purposes and their rules ───────────────────────────────────────────────

export type DestinationPurpose = 'fetch-tool' | 'browser-page' | 'voice-audio' | 'owner-webhook' | 'image-render' | 'artifact-fetch';

export interface DestinationRule {
  readonly schemes: readonly ('https:' | 'http:')[];
  /** `approved-hosts`: a private-network answer only for a host the owner approved (the setting, or the list the caller passes). */
  readonly privateNetwork: 'refuse' | 'approved-hosts';
  readonly approvedHostsSetting?: string | undefined;
  /** `approved-written-host`: a loopback answer only when the written host is itself loopback and was approved. */
  readonly loopback: 'refuse' | 'approved-written-host';
  readonly redirects: 'refuse' | 'recheck-each-hop';
}

/** The setting that lists hosts on the owner's own network that owner-configured deliveries may reach. */
export const PRIVATE_DELIVERY_HOSTS_SETTING = 'network.privateDeliveryHosts';

export const DESTINATION_RULES: { readonly [P in DestinationPurpose]: DestinationRule } = Object.freeze({
  'fetch-tool': { schemes: ['https:', 'http:'], privateNetwork: 'approved-hosts', approvedHostsSetting: 'fetch.allowedPrivateHosts', loopback: 'approved-written-host', redirects: 'recheck-each-hop' },
  // The browser is the agent's web access as the fetch tool is: the same owner's list of private hosts.
  'browser-page': { schemes: ['https:', 'http:'], privateNetwork: 'approved-hosts', approvedHostsSetting: 'fetch.allowedPrivateHosts', loopback: 'approved-written-host', redirects: 'recheck-each-hop' },
  'voice-audio': { schemes: ['https:'], privateNetwork: 'refuse', loopback: 'refuse', redirects: 'refuse' },
  'owner-webhook': { schemes: ['https:', 'http:'], privateNetwork: 'approved-hosts', approvedHostsSetting: PRIVATE_DELIVERY_HOSTS_SETTING, loopback: 'approved-written-host', redirects: 'refuse' },
  'image-render': { schemes: ['https:'], privateNetwork: 'refuse', loopback: 'refuse', redirects: 'refuse' },
  // A remote artifact or knowledge source in public-only mode: public addresses only, each redirect hop checked again.
  'artifact-fetch': { schemes: ['https:', 'http:'], privateNetwork: 'refuse', loopback: 'refuse', redirects: 'recheck-each-hop' },
});

/** Ranges an approved private host may resolve to; a cloud metadata, unspecified, multicast or reserved address never is reachable. */
const APPROVED_PRIVATE_RANGES: ReadonlySet<ResolvedAddressRange> = new Set(['private', 'link-local', 'unique-local', 'shared']);

declare const checkedBrand: unique symbol;

/** A destination `checkDestination` resolved and checked; `egress` connects only to these addresses. */
export interface CheckedDestination {
  readonly url: URL;
  readonly purpose: DestinationPurpose;
  /** The answers that passed, in resolver order. */
  readonly addresses: readonly ResolvedAddress[];
  readonly [checkedBrand]: true;
}

export class DestinationRefusedError extends Error {
  readonly code = 'DESTINATION_REFUSED';
  readonly host: string;
  readonly range: ResolvedAddressRange | 'scheme' | 'unresolved';
  readonly next: string;
  constructor(host: string, range: ResolvedAddressRange | 'scheme' | 'unresolved', reason: string, next: string) {
    super(`Request blocked: ${reason}`);
    this.name = 'DestinationRefusedError';
    this.host = host;
    this.range = range;
    this.next = next;
  }
}

/** Reads one setting; a destination reads only the approved-hosts list its rule names. */
export interface ConfigReader {
  get(key: string): unknown;
}

export interface CheckDestinationOptions {
  readonly config?: ConfigReader | undefined;
  /** The approved hosts, when the caller holds them (an owner-configured target); otherwise the rule's setting is read from `config`. */
  readonly approvedHosts?: readonly string[] | undefined;
  /** The written host is loopback and the caller approved reaching it (the owner's own machine). */
  readonly loopbackApproved?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly resolver?: HostResolver | undefined;
}

function normalizeHostEntry(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** The setting's value (a comma-separated string or a list) as normalized host entries. */
export function parseApprovedHosts(value: unknown): readonly string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return entries.filter((entry): entry is string => typeof entry === 'string').map(normalizeHostEntry).filter((entry) => entry.length > 0);
}

/** Exact host or address, or `*.example.lan` for any name under it. */
export function hostIsApproved(hostname: string, approved: readonly string[]): boolean {
  const host = normalizeHostEntry(hostname);
  if (!host) return false;
  return approved.some((entry) => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))));
}

function approvedHostsFor(rule: DestinationRule, options: CheckDestinationOptions): readonly string[] {
  if (rule.privateNetwork !== 'approved-hosts') return [];
  if (options.approvedHosts !== undefined) return options.approvedHosts;
  return rule.approvedHostsSetting !== undefined && options.config !== undefined ? parseApprovedHosts(options.config.get(rule.approvedHostsSetting)) : [];
}

/**
 * Resolve `url`'s host and check every answer under `purpose`'s rule.
 * Resolves with the checked destination; rejects with
 * `DestinationRefusedError` naming the host, the range and the next step.
 */
export async function checkDestination(url: string | URL, purpose: DestinationPurpose, options: CheckDestinationOptions = {}): Promise<CheckedDestination> {
  const rule = DESTINATION_RULES[purpose];
  let parsed: URL;
  try { parsed = new URL(String(url)); }
  catch { throw new DestinationRefusedError(String(url), 'scheme', 'not a valid URL', 'Pass an absolute https URL.'); }
  const host = bareHost(parsed);
  if (!(rule.schemes as readonly string[]).includes(parsed.protocol)) {
    throw new DestinationRefusedError(host, 'scheme', `the ${parsed.protocol} scheme is not allowed for ${purpose}`, `Use ${rule.schemes.join(' or ')}.`);
  }
  if (parsed.username || parsed.password) {
    throw new DestinationRefusedError(host, 'scheme', 'the URL carries credentials', 'Remove the user name and password from the URL.');
  }
  options.signal?.throwIfAborted();
  let answers: readonly ResolvedAddress[];
  if (isIP(host)) answers = [{ address: host, family: isIP(host) }];
  else {
    try { answers = await (options.resolver ?? systemResolver)(host); }
    catch (error) {
      throw new DestinationRefusedError(host, 'unresolved', `host "${host}" did not resolve, so its address could not be checked (${error instanceof Error ? error.message : String(error)})`, 'Check the name, or use a host that resolves.');
    }
  }
  if (answers.length === 0) throw new DestinationRefusedError(host, 'unresolved', `host "${host}" resolved to no address`, 'Check the name.');
  const approved = approvedHostsFor(rule, options);
  const writtenApproved = hostIsApproved(host, approved);
  const writtenLoopback = isLoopbackHost(host);
  for (const answer of answers) {
    const range = classifyResolvedAddress(answer.address);
    if (range === null) continue;
    // Loopback: a written loopback host the caller approved, or a host the owner approved by name.
    if (range === 'loopback' && rule.loopback === 'approved-written-host' && ((writtenLoopback && options.loopbackApproved === true) || writtenApproved)) continue;
    if (range !== 'loopback' && writtenApproved && APPROVED_PRIVATE_RANGES.has(range)) continue;
    const next = rule.privateNetwork === 'approved-hosts' && rule.approvedHostsSetting !== undefined && (APPROVED_PRIVATE_RANGES.has(range) || range === 'loopback')
      ? `To reach it, the owner adds "${normalizeHostEntry(host)}" to ${rule.approvedHostsSetting}.`
      : `A ${range} address is never reachable for ${purpose}.`;
    throw new DestinationRefusedError(host, range, `host "${host}" resolves to ${answer.address}, a ${range} address`, next);
  }
  return Object.freeze({ url: parsed, purpose, addresses: Object.freeze([...answers]) }) as CheckedDestination;
}

const MAX_REDIRECTS = 10;

/**
 * Connects only to a checked address. A redirect is returned as it is for a
 * purpose that refuses redirects; otherwise each hop is checked under the same
 * purpose (with no approval carried over: a redirect target is the server's
 * choice) and connected the same way. Loopback is never proxied.
 */
export async function egress(destination: CheckedDestination, init: RequestInit = {},
  options: Pick<CheckDestinationOptions, 'config' | 'resolver'> = {}): Promise<Response> {
  const rule = DESTINATION_RULES[destination.purpose];
  let current = destination;
  for (let hop = 0; ; hop += 1) {
    const response = await pinnedFetch(current.url.toString(), { ...init, redirect: 'manual' }, current.addresses);
    const location = response.headers.get('location');
    if (rule.redirects === 'refuse' || location === null || response.status < 300 || response.status > 399) return response;
    if (hop >= MAX_REDIRECTS) throw new DestinationRefusedError(bareHost(current.url), 'unresolved', `more than ${MAX_REDIRECTS} redirects`, 'Use the final address directly.');
    await response.body?.cancel().catch(() => undefined);
    current = await checkDestination(new URL(location, current.url), destination.purpose, { ...options, ...(init.signal ? { signal: init.signal } : {}) });
  }
}

/**
 * For request interception (the browser): one resolution per host for the
 * life of the returned function, every later request to that host answered
 * from it.
 */
export function createHostAdmission(purpose: DestinationPurpose, config: ConfigReader,
  options: Pick<CheckDestinationOptions, 'resolver' | 'loopbackApproved'> = {}): (host: string) => Promise<'allowed' | DestinationRefusedError> {
  const decided = new Map<string, Promise<'allowed' | DestinationRefusedError>>();
  const scheme = DESTINATION_RULES[purpose].schemes[0]!;
  return (host) => {
    const key = normalizeHostEntry(host);
    let answer = decided.get(key);
    if (answer === undefined) {
      const literal = key.includes(':') ? `[${key}]` : key;
      answer = checkDestination(`${scheme}//${literal}/`, purpose, { config, ...options }).then(
        () => 'allowed' as const,
        (error: unknown) => error instanceof DestinationRefusedError ? error : new DestinationRefusedError(key, 'unresolved', error instanceof Error ? error.message : String(error), 'Check the host.'),
      );
      decided.set(key, answer);
    }
    return answer;
  };
}
