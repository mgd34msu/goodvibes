/**
 * merchant-domain.ts, a shop as an owner or an agent may type it, reduced to
 * the one form every merchant comparison uses: its registrable domain.
 *
 * `www.shop.biz`, `https://shop.biz/cart` and `shop.biz:443` are all
 * `shop.biz`, which is what the merchant classifier compares a checkout host
 * against, so the owner's retailer lists, standing authorisations and the
 * classifier agree on what names a shop. Imports nothing but the public-suffix
 * table, so the settings schema can check a list with the same reading.
 */
import { registrableDomain } from '../security/public-suffix.js';

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//;

/** The host of a shop as typed (a domain, a `www.` host, or a URL with a path or port); null when no host can be read. */
function typedHost(typed: string): string | null {
  if (typed.length === 0) return null;
  try {
    const host = new URL(HAS_SCHEME.test(typed) ? typed : `https://${typed}`).hostname;
    return host.length > 0 ? host : null;
  } catch {
    return null;
  }
}

/** The registrable domain of a shop as typed, or null when it has none (a single label, a bare public suffix, or no host). */
export function registrableMerchant(value: string): string | null {
  const host = typedHost(value.trim().toLowerCase());
  return host === null ? null : registrableDomain(host);
}

/**
 * The form a shop is compared on: its registrable domain; a host with none
 * (a single label, an address) is compared as its host, and text with no
 * readable host as typed, lower-cased.
 */
export function merchantDomain(value: string): string {
  const typed = value.trim().toLowerCase();
  const host = typedHost(typed);
  return (host === null ? null : registrableDomain(host)) ?? host ?? typed;
}
