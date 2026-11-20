/**
 * Resolve and check one fetch hop (the connection is pinned by
 * runtime/network/destination.ts `pinnedFetch`).
 *
 * The trust-tier check (trust-tiers.ts) sees only the host as written, so a
 * name whose DNS answer is a loopback, private, link-local or metadata address
 * passed it. Before every request, the first and each redirect hop, the host is
 * resolved (every A and AAAA answer), each answer is compared with the declared
 * address ranges (classifyResolvedAddress, arithmetic on the address), and the
 * request is sent to an address that was checked: the URL names that address,
 * while the Host header, TLS SNI and certificate check keep the written name.
 * A second lookup therefore cannot rebind the connection to another address.
 * When the first checked address refuses the connection, the next checked
 * answer is tried, as the system would across a name's answers.
 *
 * Loopback answers are allowed only for a hop whose written host is itself a
 * plain loopback target (localhost, 127.x, ::1) that was approved; a name that
 * merely resolves to loopback is refused. A host that does not resolve is
 * refused, since nothing was checked. The check runs in every mode: YOLO and an
 * admitted call skip a prompt, never this. The one widening is for the host the
 * caller wrote (never a redirect target): a private-network answer is accepted
 * when the caller's hop says so (writtenPrivateHostAllowed in trust-tiers.ts).
 */
import { isIP } from 'node:net';
import {
  classifyResolvedAddress,
  isCallerReachablePrivateAddress,
  systemResolver,
  type HostResolver,
  type ResolvedAddress,
} from '../../runtime/network/destination.js';
import {
  ALLOWED_PRIVATE_HOSTS_SETTING,
  classifyHostTrustTier,
  emitSsrfDeny,
  type TrustTierConfig,
} from './trust-tiers.js';

/** A hop's host as the URL grammar gives it, without IPv6 brackets. */
const bareHost = (url: URL): string => url.hostname.replace(/^\[|\]$/g, '');

/**
 * Throws `Request blocked: ...` for any URL that is not http: or https:. The
 * request is sent by a runtime that also opens file: URLs, ignoring the host,
 * so the scheme is checked on the parsed URL for the first request and for
 * every redirect target.
 */
export function assertHttpScheme(url: string): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error('Request blocked: not a valid URL. Nothing was sent; pass an absolute http(s) URL.');
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`Request blocked: the ${protocol} scheme is not fetchable. Nothing was sent; fetch only reads http(s) URLs (use the read tool for local files).`);
  }
}

/**
 * Resolves the URL's host and checks every answer. Returns the checked
 * addresses the request may use, in resolver order; throws
 * `Request blocked: ...` when any answer is in a refused range or the host
 * does not resolve.
 */
export async function resolveCheckedAddresses(
  url: string,
  options: {
    readonly trustTierConfig: TrustTierConfig;
    readonly localhostApproved: boolean;
    readonly resolveHost?: HostResolver | undefined;
    /** Diagnostic projection only; every address is still checked unchanged. */
    readonly diagnosticMode?: 'default' | 'opaque-url';
    /** The hop is the host the caller wrote, so a refusal of a private address names the owner's setting. */
    readonly callerWroteHost?: boolean;
    /** The caller's written host may be reached at a private-network address (writtenPrivateHostAllowed). */
    readonly privateAllowed?: boolean;
  },
): Promise<readonly ResolvedAddress[]> {
  assertHttpScheme(url);
  const parsed = new URL(url);
  const host = bareHost(parsed);
  const writtenTrust = classifyHostTrustTier(host, options.trustTierConfig);
  if (writtenTrust.tier === 'blocked' && !writtenTrust.isSsrf) throw new Error(`Request blocked: ${writtenTrust.reason}`);
  const writtenLoopback = writtenTrust.tier === 'localhost';
  let answers: readonly ResolvedAddress[];
  if (isIP(host)) {
    answers = [{ address: host, family: isIP(host) }];
  } else {
    try {
      answers = await (options.resolveHost ?? systemResolver)(host);
    } catch (error) {
      throw new Error(`Request blocked: host "${host}" did not resolve, so its address could not be checked (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (answers.length === 0) throw new Error(`Request blocked: host "${host}" resolved to no address`);
  for (const answer of answers) {
    const trust = classifyHostTrustTier(answer.address, options.trustTierConfig);
    if (trust.tier === 'blocked' && !trust.isSsrf) throw new Error(`Request blocked: ${trust.reason}`);
  }
  for (const answer of answers) {
    const range = classifyResolvedAddress(answer.address);
    if (range === null) continue;
    if (range === 'loopback' && writtenLoopback && options.localhostApproved) continue;
    const reachable = isCallerReachablePrivateAddress(answer.address);
    if (reachable && options.privateAllowed === true) continue;
    const next = reachable && options.callerWroteHost === true
      ? `. To reach it, the owner can add "${host}" to ${ALLOWED_PRIVATE_HOSTS_SETTING} in their own settings (a project file cannot set it)`
      : '';
    const reason = `host "${host}" resolves to ${answer.address}, a ${range} address, SSRF risk${next}`;
    if (options.diagnosticMode === 'opaque-url') {
      emitSsrfDeny('[redacted-host]', '[redacted-url]', 'Resolved address is not allowed');
    } else {
      emitSsrfDeny(host, url, reason);
    }
    throw new Error(`Request blocked: ${reason}`);
  }
  return answers;
}

