import { sanitizeUrlForLog } from '../../utils/fetch-with-timeout.js';
/**
 * Host trust tier classification.
 *
 * Classifies outbound HTTP request targets into one of four tiers before
 * the request is sent. Blocked hosts are denied pre-request with an
 * `SSRF_DENY` telemetry event. The one exception is a private-network
 * address the caller wrote itself (writtenPrivateHostAllowed): reachable when
 * the owner lists it in fetch.allowedPrivateHosts, or, for an IP address
 * written as the host, when the call runs in YOLO or was admitted. Metadata
 * and link-local addresses and every redirect target stay refused.
 * Localhost/loopback targets (dev servers) are their own tier: they ask once
 * and the approval is saved in the user's settings (fetch.allowLocalhost). Unknown hosts
 * receive `safe-text` sanitization. Trusted hosts may opt into `none`
 * sanitization via config.
 *
 * Trust tiers:
 *   - `trusted`  , Host is explicitly allowlisted. Sanitization may be relaxed.
 *   - `unknown`  , Host is not in any list; apply `safe-text` sanitization.
 *   - `localhost`, Loopback/dev-server target; requires the localhost
 *                   approval (fetch.allowLocalhost) before the request is sent.
 *   - `blocked`  , Host matches an internal address, metadata endpoint, or
 *                   explicit blocklist entry. Request is denied pre-flight.
 *
 * SSRF protections detect (blocked in every mode, except a written private
 * address as above):
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
import { classifyResolvedAddress } from '../../runtime/network/destination.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Trust classification for an outbound request host.
 *
 * - `trusted`  , Explicitly allowlisted; sanitization may be relaxed.
 * - `unknown`  , Not in any list; standard `safe-text` sanitization applied.
 * - `localhost`, Loopback dev-server target; needs the localhost approval.
 * - `blocked`  , Sensitive host; request denied pre-request.
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
      reason: `host "${host}" is a loopback address, needs the localhost approval (fetch.allowLocalhost in your own settings)`,
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

/** The owner's setting that names private hosts the fetch tool may reach. */
export const ALLOWED_PRIVATE_HOSTS_SETTING = 'fetch.allowedPrivateHosts';

/**
 * Whether the host the caller wrote may be reached at a private address
 * ({@link isCallerReachablePrivateAddress}): any host the owner lists in
 * fetch.allowedPrivateHosts (patterns as in fetch.trustedHosts), or an IP
 * address written as the host when the call runs in YOLO or was admitted. A
 * name that merely resolves to a private address needs the owner's list, and a
 * redirect target is the server's choice, so it is never asked about here.
 */
export function writtenPrivateHostAllowed(
  host: string,
  options: { readonly callerAdmitted: boolean; readonly allowedPrivateHosts: readonly string[] },
): boolean {
  const normalized = normalizeHost(host);
  if (options.allowedPrivateHosts.some((pattern) => hostMatchesGlob(normalized, pattern))) return true;
  return options.callerAdmitted && ipLiteral(normalized) !== null;
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
