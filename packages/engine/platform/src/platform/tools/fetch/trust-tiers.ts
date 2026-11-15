import { sanitizeUrlForLog } from '../../utils/fetch-with-timeout.js';
/**
 * Host trust tier classification.
 *
 * Classifies outbound HTTP request targets into one of four tiers before
 * the request is sent. Blocked hosts are denied pre-request with an
 * `SSRF_DENY` telemetry event, absolutely, regardless of configuration.
 * Localhost/loopback targets (dev servers) are their own tier: they ask once
 * and can be allowed per project (fetch.allowLocalhost). Unknown hosts
 * receive `safe-text` sanitization. Trusted hosts may opt into `none`
 * sanitization via config.
 *
 * Trust tiers:
 *   - `trusted`  , Host is explicitly allowlisted. Sanitization may be relaxed.
 *   - `unknown`  , Host is not in any list; apply `safe-text` sanitization.
 *   - `localhost`, Loopback/dev-server target; requires the per-project
 *                   approval (fetch.allowLocalhost) before the request is sent.
 *   - `blocked`  , Host matches an internal address, metadata endpoint, or
 *                   explicit blocklist entry. Request is denied pre-flight.
 *
 * SSRF protections detect (always blocked, in every mode):
 *   - An IP address written as the host that falls in a non-public range
 *     (classifyResolvedAddress: private, link-local and metadata, shared,
 *     reserved, multicast, unspecified, and mapped forms of these). A name is
 *     never read as an address; it is checked by the addresses it resolves to
 *     (pinned-request.ts).
 *   - An IPv4 address spelled in another notation (hex, octal, a bare number).
 *
 * Hosts and list entries are compared in one form (host-utils.ts
 * normalizeHost), so `a.example.com.` matches a pattern for `a.example.com`.
 */

import { isIP } from 'node:net';
import { logger } from '../../utils/logger.js';
import { hostMatchesGlob, normalizeHost } from './host-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an outbound request host.
 *
 * - `trusted`  , Explicitly allowlisted; sanitization may be relaxed.
 * - `unknown`  , Not in any list; standard `safe-text` sanitization applied.
 * - `localhost`, Loopback dev-server target; needs the per-project approval.
 * - `blocked`  , Sensitive host; request denied pre-request, absolutely.
 */
export type HostTrustTier = 'trusted' | 'unknown' | 'localhost' | 'blocked';

/**
 * Result of classifying a host's trust tier.
 */
export interface TrustTierResult {
  /** The classified trust tier. */
  tier: HostTrustTier;
  /** Human-readable reason for the classification. */
  reason: string;
  /** True when the host matched an SSRF pattern specifically. */
  isSsrf: boolean;
}

/**
 * Configuration for host trust tier classification.
 */
export interface TrustTierConfig {
  /**
   * Hostnames or glob patterns that are explicitly trusted.
   * Trusted hosts may opt out of sanitization via fetch config.
   * Example: `['api.anthropic.com', '*.internal.example.com']`
   */
  trustedHosts?: string[] | undefined;
  /**
   * Hostnames or glob patterns that are explicitly blocked.
   * Blocked hosts are denied pre-request regardless of other config.
   */
  blockedHosts?: string[] | undefined;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/** Known localhost aliases. */
const LOCALHOST_ALIASES: ReadonlySet<string> = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

/**
 * Returns true if the host is a localhost alias. RFC 6761 reserves `localhost`
 * and every name under `.localhost` for loopback.
 */
function isLocalhostAlias(host: string): boolean {
  return LOCALHOST_ALIASES.has(host) || host.endsWith('.localhost');
}

/** The address a host names when it is written as an IP literal (brackets removed), or null for a name. */
function ipLiteral(host: string): string | null {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return isIP(bare) === 0 ? null : bare;
}

/**
 * The dotted IPv4 address a host spells in another notation (hex, octal, a
 * single decimal number, fewer than four parts), as the URL parser reads it,
 * or null when the host is a name or already a dotted address. The URL parser
 * decides, so this agrees with where the request would go.
 */
function encodedIpv4(host: string): string | null {
  if (ipLiteral(host) !== null) return null;
  // Only digits, dots and hex letters with an x can spell an address; any other name is a name.
  if (!/^[0-9a-fx.]+$/.test(host)) return null;
  try {
    const parsed = new URL(`http://${host}/`).hostname;
    return isIP(parsed) === 4 && parsed !== host ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Telemetry event names emitted by the trust tier classifier.
 * These are the canonical runtime contract strings for host trust classification.
 */
export const TRUST_TIER_EVENTS = {
  /** Emitted when a host trust tier has been classified (all tiers). */
  HOST_TRUST_TIER: 'HOST_TRUST_TIER',
  /** Emitted when a request is denied due to SSRF detection. */
  SSRF_DENY: 'SSRF_DENY',
} as const;

/**
 * Classify the trust tier of an outbound request host.
 *
 * Classification order (first match wins):
 *   1. Explicit blocklist → `blocked`
 *   2. Plain loopback targets (localhost, 127.x, ::1) → `localhost`
 *   3. SSRF patterns (private IPs, metadata endpoints) → `blocked`
 *   4. Encoded IP bypass attempts (including encoded loopback) → `blocked`
 *   5. Explicit trustlist → `trusted`
 *   6. Default → `unknown`
 *
 * @param host   - Hostname or IP to classify (without port).
 * @param config - Trust tier configuration with optional allow/deny lists.
 * @returns      `TrustTierResult` with tier, reason, and SSRF flag.
 */
export function classifyHostTrustTier(
  host: string,
  config: TrustTierConfig = {},
): TrustTierResult {
  const normalizedHost = normalizeHost(host);

  // 1. Explicit blocklist
  const blockedEntry = (config.blockedHosts ?? []).find((pattern) =>
    hostMatchesGlob(normalizedHost, pattern),
  );
  if (blockedEntry !== undefined) {
    return {
      tier: 'blocked',
      reason: `host "${host}" matched explicit blocklist pattern "${blockedEntry}"`,
      isSsrf: false,
    };
  }

  // 2. Plain loopback dev-server targets, their own tier, gated by the
  // per-project approval rather than blocked outright.
  const literal = ipLiteral(normalizedHost);
  if (isLocalhostAlias(normalizedHost) || (literal !== null && isPlainLoopbackAddress(literal))) {
    return {
      tier: 'localhost',
      reason: `host "${host}" is a loopback address, needs the per-project localhost approval (fetch.allowLocalhost)`,
      isSsrf: false,
    };
  }

  // 3. An address written as the host is checked by its range, the same
  // arithmetic the resolved-address check uses. A name is never read as an
  // address: 10.example.com is a name.
  if (literal !== null) {
    const range = classifyResolvedAddress(literal);
    if (range === 'metadata' || (range === 'link-local' && isIP(literal) === 4)) {
      return {
        tier: 'blocked',
        reason: `host "${host}" is a cloud metadata endpoint (the 169.254.0.0/16 link-local range), SSRF risk`,
        isSsrf: true,
      };
    }
    if (range !== null) {
      return {
        tier: 'blocked',
        reason: `host "${host}" is a ${range} ${isIP(literal) === 6 ? 'IPv6' : 'IPv4'} address, SSRF risk`,
        isSsrf: true,
      };
    }
  }

  // 4. An IPv4 address spelled in another notation (0x7f000001, 0177.0.0.1,
  // 2130706433) is a filter-bypass signal, refused even for a loopback target.
  // A plain decimal number that spells a public address stays a host.
  const encoded = encodedIpv4(normalizedHost);
  if (encoded !== null && (!/^\d+$/.test(normalizedHost) || classifyResolvedAddress(encoded) !== null)) {
    return {
      tier: 'blocked',
      reason: `host "${host}" uses encoded IP representation, DNS rebinding / SSRF bypass risk`,
      isSsrf: true,
    };
  }

  // 5. Explicit trustlist
  const trustedEntry = (config.trustedHosts ?? []).find((pattern) =>
    hostMatchesGlob(normalizedHost, pattern),
  );
  if (trustedEntry !== undefined) {
    return {
      tier: 'trusted',
      reason: `host "${host}" matched trusted host pattern "${trustedEntry}"`,
      isSsrf: false,
    };
  }

  // 6. Default, unknown
  return {
    tier: 'unknown',
    reason: `host "${host}" is not in any trust list`,
    isSsrf: false,
  };
}

/** A plainly written loopback address: 127.0.0.0/8 or ::1, not a mapped or embedded form. */
function isPlainLoopbackAddress(address: string): boolean {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'));
}

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
 * Emit SSRF deny telemetry to the logger as a structured event.
 *
 * Emits a log entry with event name `SSRF_DENY` that can be consumed by
 * the telemetry pipeline. This fulfils the runtime contract for the
 * `SSRF_DENY` telemetry event in fetch sanitization.
 *
 * @param host     - The host that was denied.
 * @param url      - The full URL that was attempted.
 * @param reason   - Human-readable reason for the denial.
 */
export function emitSsrfDeny(host: string, url: string, reason: string): void {
  logger.warn('SSRF_DENY', {
    event: TRUST_TIER_EVENTS.SSRF_DENY,
    host,
    url: sanitizeUrlForLog(url),
    reason,
    timestamp: Date.now(),
  });
}

/**
 * Emit host trust tier telemetry to the logger as a structured event.
 *
 * Emits a log entry with event name `HOST_TRUST_TIER` that can be consumed
 * by the telemetry pipeline. This fulfils the runtime contract for the
 * `HOST_TRUST_TIER` telemetry event in fetch sanitization.
 *
 * @param host   - The classified host.
 * @param url    - The full URL being fetched.
 * @param result - The trust tier classification result.
 */
export function emitHostTrustTier(
  host: string,
  url: string,
  result: TrustTierResult,
): void {
  logger.debug('HOST_TRUST_TIER', {
    event: TRUST_TIER_EVENTS.HOST_TRUST_TIER,
    host,
    url: sanitizeUrlForLog(url),
    tier: result.tier,
    reason: result.reason,
    isSsrf: result.isSsrf,
    timestamp: Date.now(),
  });
}

/**
 * Extract the hostname from a URL string for trust tier classification.
 *
 * Returns `null` if the URL cannot be parsed.
 *
 * @param url - Full URL string (e.g. `https://example.com/path`).
 * @returns   Hostname string (without port), or `null` on parse failure.
 */
export function extractHostname(url: string): string | null {
  // The URL's own parse decides the host, so a scheme like file:// cannot make
  // this classify a different host than the one the request is sent to.
  try {
    const host = new URL(url).hostname;
    if (host !== '') return host;
  } catch { /* A bare host such as example.com:8080/x is parsed below. */ }
  try {
    return new URL(`https://${url}`).hostname;
  } catch {
    return null;
  }
}
