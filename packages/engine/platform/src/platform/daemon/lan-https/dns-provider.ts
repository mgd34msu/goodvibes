/**
 * dns-provider.ts, what the daemon needs from a DNS service it can drive by
 * API to get and keep a Let's Encrypt certificate for a name the person owns:
 * write and remove the proof record (`_acme-challenge.<name>`, TXT), and keep
 * an address record (A) pointing a name at a machine's local address.
 *
 * Cloudflare (cloudflare-dns.ts) is the first implementation; another service
 * implements the same four calls and is chosen by `secureAddress.dnsProvider`.
 * Every record the daemon writes carries its comment, so a record someone else
 * made under the same name is never changed.
 */

/** The comment on every record the daemon writes, and the mark of the ones it may change. */
export const SECURE_ADDRESS_RECORD_COMMENT = 'GoodVibes secure address (written by the GoodVibes daemon)';

/** One TXT record written as a proof, to remove afterwards. */
export interface DnsProofRecord {
  readonly id: string;
  readonly zoneId: string;
  readonly name: string;
}

/** A refusal from the DNS service, in plain words for the person. */
export class DnsProviderError extends Error {
  constructor(message: string, readonly code: 'token-missing' | 'store-unreadable' | 'token-refused' | 'zone-not-found' | 'record-taken' | 'unreachable' | 'refused') {
    super(message);
    this.name = 'DnsProviderError';
  }
}

export interface DnsProvider {
  /** The service's name, as the screen says it ("Cloudflare"). */
  readonly label: string;
  /** The zone that holds `name`, checked with the token now: refuses with words when there is none or the token may not edit it. */
  zoneFor(name: string): Promise<{ readonly id: string; readonly name: string }>;
  /** Add a TXT record (several may share a name: a wildcard proof needs two). */
  addProofRecord(name: string, value: string): Promise<DnsProofRecord>;
  /** Remove a proof record written by addProofRecord. */
  removeProofRecord(record: DnsProofRecord): Promise<void>;
  /**
   * Make `name`'s A record point at `address`, creating it when absent. A
   * record under that name the daemon did not write is left alone and refused
   * with words. Returns whether anything changed.
   */
  setAddressRecord(name: string, address: string): Promise<{ readonly changed: boolean }>;
  /** Remove the A record the daemon wrote under `name`, if any (a node that left its group). */
  removeAddressRecord(name: string): Promise<void>;
}
