import { assertDeliveryCurrent, type DeliveryLifetime } from './delivery-lifetime.js';
/**
 * Public webhook URLs: the checks every webhook callback and delivery target
 * passes, and the delivery request itself.
 *
 * - validatePublicWebhookUrl (at intake): https only, no credentials in the
 *   URL, and a host that is not a loopback name (`localhost`, `*.localhost`,
 *   RFC 6761) or an address in a refused range as written. The ranges are the
 *   fetch tool's (tools/fetch/trust-tiers.ts classifyResolvedAddress), one
 *   declaration for the engine; a name is not judged by its spelling.
 * - postToPublicWebhook (at delivery): the same validation, then the host is
 *   resolved (every A and AAAA answer), every answer is checked against those
 *   ranges, and the request is sent pinned to a checked address with the
 *   written name kept for the Host header, TLS SNI and the certificate check
 *   (tools/fetch/pinned-request.ts), so a name that resolves to a private,
 *   loopback, link-local or metadata address, or is rebound between the check
 *   and the connection, is refused. Redirects are not followed: the delivery
 *   goes to the address that was checked.
 * - Owner approval of a host on the owner's own network: a target the owner
 *   configured (a watcher, a notification webhook, the default webhook
 *   target) may name a host listed in `network.privateDeliveryHosts`. For an
 *   approved host, private, loopback, link-local, unique-local and shared
 *   (CGNAT, Tailscale) addresses are admitted; a cloud metadata address never
 *   is. Addresses supplied by outside parties (a chat platform's response URL,
 *   a binding's callback, a device's push endpoint) never carry the approval.
 */

import { isIP } from 'node:net';
import { classifyResolvedAddress, type ResolvedAddressRange } from '../tools/fetch/trust-tiers.js';
import { pinnedFetch, resolveCheckedAddresses, systemResolver, type HostResolver, type ResolvedAddress } from '../tools/fetch/pinned-request.js';

/** The setting that lists hosts on the owner's own network that owner-configured deliveries may reach. */
export const PRIVATE_DELIVERY_HOSTS_SETTING = 'network.privateDeliveryHosts';

/** Ranges an approved private host may resolve to. Metadata, unspecified, multicast and reserved addresses stay refused. */
const APPROVED_PRIVATE_RANGES: ReadonlySet<ResolvedAddressRange> = new Set(['loopback', 'private', 'link-local', 'unique-local', 'shared']);

/** The setting's value (a comma-separated string or a list) as normalized host entries. */
export function parsePrivateDeliveryHosts(value: unknown): readonly string[] {
  const entries = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return entries.filter((entry): entry is string => typeof entry === 'string')
    .map(normalizeHost).filter(entry => entry.length > 0);
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Exact host or address, or `*.example.lan` for any name under it. */
export function isApprovedPrivateHost(hostname: string, approved: readonly string[]): boolean {
  const host = normalizeHost(hostname);
  if (!host) return false;
  return approved.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))));
}

function approvalHint(hostname: string): string {
  return `To deliver to a host on your own network, add "${normalizeHost(hostname)}" to ${PRIVATE_DELIVERY_HOSTS_SETTING}.`;
}

function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host)) return classifyResolvedAddress(host) !== null;
  return false;
}

export function validatePublicWebhookUrl(rawUrl: string): { ok: true; url: string } | { ok: false; error: string } {
  return validateWebhookDeliveryUrl(rawUrl, false);
}

function validateWebhookDeliveryUrl(rawUrl: string, allowHttp: boolean, approvedPrivateHosts?: readonly string[]): { ok: true; url: string } | { ok: false; error: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    return { ok: false, error: 'Webhook URL must use https' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Webhook URL must not include credentials' };
  }
  if (isBlockedHostname(parsed.hostname)) {
    const host = normalizeHost(parsed.hostname);
    const range = isIP(host) ? classifyResolvedAddress(host) : 'loopback';
    if (approvedPrivateHosts !== undefined && range !== null && APPROVED_PRIVATE_RANGES.has(range)) {
      if (isApprovedPrivateHost(host, approvedPrivateHosts)) return { ok: true, url: parsed.toString() };
      return { ok: false, error: `Webhook URL host ${host} is on a private network and is not approved. ${approvalHint(host)}` };
    }
    return { ok: false, error: 'Webhook URL host is not allowed' };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * The configuration-time check of a target the owner configured: the same
 * rules delivery applies to the URL as written, with the owner's approved
 * private hosts. Returns the refusal (naming the setting for an unapproved
 * private host) or undefined. A name that only resolves to a private address
 * is refused at delivery with the same hint. No I/O.
 */
export function ownerDeliveryTargetProblem(rawUrl: string, options: {
  readonly allowHttp?: boolean | undefined;
  readonly approvedPrivateHosts: readonly string[];
}): string | undefined {
  const validation = validateWebhookDeliveryUrl(rawUrl, options.allowHttp === true, options.approvedPrivateHosts);
  return validation.ok ? undefined : validation.error;
}

/** Resolve an approved private host: every answer must be in an admitted range. */
async function resolveApprovedPrivateAddresses(url: string, resolveHost: HostResolver | undefined): Promise<readonly ResolvedAddress[]> {
  const host = normalizeHost(new URL(url).hostname);
  let answers: readonly ResolvedAddress[];
  if (isIP(host)) answers = [{ address: host, family: isIP(host) }];
  else {
    try { answers = await (resolveHost ?? systemResolver)(host); }
    catch (error) {
      throw new Error(`Request blocked: host "${host}" did not resolve, so its address could not be checked (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  if (answers.length === 0) throw new Error(`Request blocked: host "${host}" resolved to no address`);
  for (const answer of answers) {
    const range = classifyResolvedAddress(answer.address);
    if (range !== null && !APPROVED_PRIVATE_RANGES.has(range)) {
      throw new Error(`Request blocked: approved host "${host}" resolves to ${answer.address}, a ${range} address, which is never reachable from a delivery.`);
    }
  }
  return answers;
}

/**
 * Sends a webhook delivery to a public URL: validated, resolved, every answer
 * checked, and pinned to a checked address; redirects are returned, not
 * followed. Throws when the URL or any resolved address is refused.
 */
export async function postToPublicWebhook(
  rawUrl: string,
  init: RequestInit,
  options: DeliveryLifetime & {
    readonly resolveHost?: HostResolver | undefined;
    /** Preserve HTTP for configured generic notification endpoints. HTTPS remains the default. */
    readonly allowHttp?: boolean | undefined;
    /**
     * The owner's approved hosts on their own network (`network.privateDeliveryHosts`),
     * passed only for a target the owner configured. Absent for an address an
     * outside party supplied, which keeps every private range refused.
     */
    readonly approvedPrivateHosts?: readonly string[] | undefined;
  } = {},
): Promise<Response> {
  const lifetime = { signal: init.signal && options.signal ? AbortSignal.any([init.signal, options.signal]) : init.signal ?? options.signal,
    assertCurrent: options.assertCurrent, withPublication: options.withPublication };
  assertDeliveryCurrent(lifetime);
  const approved = options.approvedPrivateHosts;
  const validation = validateWebhookDeliveryUrl(rawUrl, options.allowHttp === true, approved);
  if (!validation.ok) throw new Error(validation.error);
  const hostname = new URL(validation.url).hostname;
  let addresses: readonly ResolvedAddress[];
  if (approved !== undefined && isApprovedPrivateHost(hostname, approved)) {
    addresses = await resolveApprovedPrivateAddresses(validation.url, options.resolveHost);
  } else {
    try {
      addresses = await resolveCheckedAddresses(validation.url, {
        trustTierConfig: {},
        localhostApproved: false,
        resolveHost: options.resolveHost,
        diagnosticMode: 'opaque-url',
      });
    } catch (error) {
      // An owner-configured target gets the setting that would admit it.
      if (approved !== undefined && error instanceof Error && / resolves to .*address/.test(error.message)) {
        throw new Error(`${error.message}. ${approvalHint(hostname)}`, { cause: error });
      }
      throw error;
    }
  }
  assertDeliveryCurrent(lifetime);
  return pinnedFetch(validation.url, { ...init, ...(lifetime.signal ? { signal: lifetime.signal } : {}), redirect: 'manual' },
    addresses, 'opaque-url', options.assertCurrent, options.withPublication);
}
