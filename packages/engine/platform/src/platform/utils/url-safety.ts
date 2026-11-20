import { assertDeliveryCurrent, type DeliveryLifetime } from './delivery-lifetime.js';
/**
 * Public webhook URLs: the checks every webhook callback and delivery target
 * passes, and the delivery request itself.
 *
 * - validatePublicWebhookUrl (at intake): https only, no credentials in the
 *   URL, and a host that is not a loopback name (`localhost`, `*.localhost`,
 *   RFC 6761) or an address in a refused range as written. The ranges are the
 *   destination owner's (runtime/network/destination.ts
 *   classifyResolvedAddress), one declaration for the engine; a name is not
 *   judged by its spelling.
 * - postToPublicWebhook (at delivery): the same validation, then the host is
 *   resolved (every A and AAAA answer), every answer is checked against those
 *   ranges, and the request is sent pinned to a checked address with the
 *   written name kept for the Host header, TLS SNI and the certificate check
 *   (runtime/network/destination.ts), so a name that resolves to a private,
 *   loopback, link-local or metadata address, or is rebound between the check
 *   and the connection, is refused (`checkDestination` with the
 *   `owner-webhook` rule). Redirects are not followed: the delivery goes to the
 *   address that was checked.
 * - Owner approval of a host on the owner's own network: a target the owner
 *   configured (a watcher, a notification webhook, the default webhook
 *   target) may name a host listed in `network.privateDeliveryHosts`. For an
 *   approved host, private, loopback, link-local, unique-local and shared
 *   (CGNAT, Tailscale) addresses are admitted; a cloud metadata address never
 *   is. Addresses supplied by outside parties (a chat platform's response URL,
 *   a binding's callback, a device's push endpoint) never carry the approval.
 */

import { isIP } from 'node:net';
import {
  DestinationRefusedError,
  PRIVATE_DELIVERY_HOSTS_SETTING,
  checkDestination,
  classifyResolvedAddress,
  hostIsApproved,
  pinnedFetch,
  type HostResolver,
  type ResolvedAddressRange,
} from '../runtime/network/destination.js';
import { emitSsrfDeny } from '../tools/fetch/trust-tiers.js';
import { CONFIG_SCHEMA } from '../config/schema.js';

/** Ranges an approved private host may be written as. Metadata, unspecified, multicast and reserved addresses stay refused. */
const APPROVED_PRIVATE_RANGES: ReadonlySet<ResolvedAddressRange> = new Set(['loopback', 'private', 'link-local', 'unique-local', 'shared']);

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

let privateDeliveryHostsName: string | undefined;

/** The setting by its plain name, as the settings screen shows it, with its key. */
function namedSetting(): string {
  privateDeliveryHostsName ??= (() => {
    const label = CONFIG_SCHEMA.find((setting) => setting.key === PRIVATE_DELIVERY_HOSTS_SETTING)?.label;
    return label ? `"${label}" (${PRIVATE_DELIVERY_HOSTS_SETTING})` : PRIVATE_DELIVERY_HOSTS_SETTING;
  })();
  return privateDeliveryHostsName;
}

function approvalHint(hostname: string): string {
  return `To deliver to a host on your own network, add "${normalizeHost(hostname)}" to the setting ${namedSetting()}.`;
}

/**
 * An owner-configured target refused because its host is on the owner's own
 * network and not in `network.privateDeliveryHosts`. The message names the
 * setting by its plain name and the host to add; adding it is the owner's call.
 */
export class PrivateDeliveryHostRefusedError extends Error {
  readonly code = 'PRIVATE_DELIVERY_HOST_NOT_APPROVED';
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'PrivateDeliveryHostRefusedError';
  }
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

function validateWebhookDeliveryUrl(rawUrl: string, allowHttp: boolean, approvedPrivateHosts?: readonly string[]): { ok: true; url: string } | { ok: false; error: string; privateHost?: true } {
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
      if (hostIsApproved(host, approvedPrivateHosts)) return { ok: true, url: parsed.toString() };
      return { ok: false, error: `Webhook URL host ${host} is on your own network and is not approved. ${approvalHint(host)}`, privateHost: true };
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

/**
 * The refusal of an owner-configured target whose host, as written, is on the
 * owner's own network and not in `network.privateDeliveryHosts` (naming the
 * setting), or undefined for any other outcome. No I/O.
 */
export function ownerPrivateHostRefusal(rawUrl: string, options: {
  readonly allowHttp?: boolean | undefined;
  readonly approvedPrivateHosts: readonly string[];
}): string | undefined {
  const validation = validateWebhookDeliveryUrl(rawUrl, options.allowHttp === true, options.approvedPrivateHosts);
  return !validation.ok && validation.privateHost === true ? validation.error : undefined;
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
  if (!validation.ok) throw validation.privateHost ? new PrivateDeliveryHostRefusedError(validation.error) : new Error(validation.error);
  const hostname = new URL(validation.url).hostname;
  let addresses;
  try {
    // An owner-configured target may reach the hosts he approved; an address an outside party supplied never does.
    ({ addresses } = await checkDestination(validation.url, 'owner-webhook', {
      approvedHosts: approved ?? [], resolver: options.resolveHost, ...(lifetime.signal ? { signal: lifetime.signal } : {}),
    }));
  } catch (error) {
    if (!(error instanceof DestinationRefusedError)) throw error;
    emitSsrfDeny('[redacted-host]', '[redacted-url]', 'Resolved address is not allowed');
    // An owner-configured target on his own network gets the setting that would admit it;
    // a range no approval admits (cloud metadata, reserved, multicast) is refused as it is.
    if (approved !== undefined && APPROVED_PRIVATE_RANGES.has(error.range as ResolvedAddressRange)) {
      throw new PrivateDeliveryHostRefusedError(`${error.message}. ${approvalHint(hostname)}`, { cause: error });
    }
    throw error;
  }
  assertDeliveryCurrent(lifetime);
  return pinnedFetch(validation.url, { ...init, ...(lifetime.signal ? { signal: lifetime.signal } : {}), redirect: 'manual' },
    addresses, 'opaque-url', options.assertCurrent, options.withPublication);
}
