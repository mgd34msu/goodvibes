/**
 * cloudflare-dns.ts, the DNS provider for a name whose zone is on Cloudflare,
 * through the Cloudflare client and API token the product already uses for
 * its `/cloudflare` commands (cloudflare/client.ts, the token resolved by
 * cloudflare/cloudflare-token-resolvers.ts: `cloudflare.apiTokenRef`, then
 * CLOUDFLARE_API_TOKEN, then the stored `CLOUDFLARE_API_TOKEN` secret).
 *
 * The token needs one permission: Zone, DNS, Edit on the zone that holds the
 * name. What goes to Cloudflare: the name, the proof value (a digest; no
 * secret), and this machine's local network address. Nothing else.
 */
import { createCloudflareApiClient } from '../../cloudflare/client.js';
import type { CloudflareApiClient, CloudflareDnsRecordLike } from '../../cloudflare/types.js';
import { collectAsync } from '../../cloudflare/utils.js';
import { DnsProviderError, SECURE_ADDRESS_RECORD_COMMENT, type DnsProofRecord, type DnsProvider } from './dns-provider.js';

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Cloudflare's own refusal turned into the person's words; never the token. */
function cloudflareWords(error: unknown, doing: string): DnsProviderError {
  const status = statusOf(error);
  if (status === 401 || status === 403) {
    return new DnsProviderError(`Cloudflare refused the API token while ${doing}: the token needs the permission Zone, DNS, Edit on the zone that holds the name. Make one at dash.cloudflare.com, My Profile, API Tokens (template "Edit zone DNS") and give it here.`, 'token-refused');
  }
  if (status === undefined) {
    return new DnsProviderError(`Cloudflare could not be reached while ${doing} (${error instanceof Error ? error.message : String(error)}). Nothing was changed there; it is tried again at the next start of the https listener.`, 'unreachable');
  }
  return new DnsProviderError(`Cloudflare answered ${status} while ${doing}: ${error instanceof Error ? error.message : String(error)}.`, 'refused');
}

export class CloudflareDnsProvider implements DnsProvider {
  readonly label = 'Cloudflare';
  private clientPromise: Promise<CloudflareApiClient> | null = null;
  private readonly zones = new Map<string, { readonly id: string; readonly name: string }>();

  constructor(
    private readonly token: () => Promise<string | null>,
    private readonly makeClient: (token: string) => Promise<CloudflareApiClient> = createCloudflareApiClient,
    /** When no token was read: the words for a secret store that could not be read (config/secret-store-unreadable.ts), or null. */
    private readonly unreadable: () => Promise<string | null> = async () => null,
  ) {}

  private async client(): Promise<CloudflareApiClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const token = await this.token();
        // A store this computer could not read is not "no token": the person is not asked for one they gave.
        const unreadable = token ? null : await this.unreadable();
        if (unreadable) throw new DnsProviderError(unreadable, 'store-unreadable');
        if (!token) throw new DnsProviderError('No Cloudflare API token is stored. Give one with the permission Zone, DNS, Edit on the zone that holds the name (dash.cloudflare.com, My Profile, API Tokens, template "Edit zone DNS").', 'token-missing');
        return this.makeClient(token);
      })();
      this.clientPromise.catch(() => { this.clientPromise = null; });
    }
    return this.clientPromise;
  }

  async zoneFor(name: string): Promise<{ readonly id: string; readonly name: string }> {
    const wanted = name.toLowerCase().replace(/\.$/, '');
    const known = [...this.zones.values()].find((zone) => wanted === zone.name || wanted.endsWith(`.${zone.name}`));
    if (known) return known;
    const client = await this.client();
    if (!client.zones) throw new DnsProviderError('This Cloudflare client cannot list zones.', 'refused');
    const labels = wanted.split('.');
    // The zone is the longest suffix of the name that the account holds: ask for each, longest first.
    for (let at = 0; at < labels.length - 1; at += 1) {
      const candidate = labels.slice(at).join('.');
      let found: readonly { readonly id: string; readonly name: string }[];
      try { found = await collectAsync(client.zones.list({ name: candidate }), 5); } catch (error) { throw cloudflareWords(error, `looking for the zone of ${wanted}`); }
      const zone = found.find((entry) => entry.name === candidate);
      if (zone) {
        const kept = { id: zone.id, name: zone.name };
        this.zones.set(zone.name, kept);
        return kept;
      }
    }
    throw new DnsProviderError(`No zone this Cloudflare token can see holds ${wanted}. The name must be under a domain whose DNS is on Cloudflare, and the token must have Zone, DNS, Edit on that zone.`, 'zone-not-found');
  }

  async addProofRecord(name: string, value: string): Promise<DnsProofRecord> {
    const zone = await this.zoneFor(name);
    const client = await this.client();
    try {
      const created = await client.dns!.records.create({ zone_id: zone.id, type: 'TXT', name, content: value, ttl: 60, comment: SECURE_ADDRESS_RECORD_COMMENT });
      return { id: created.id ?? '', zoneId: zone.id, name };
    } catch (error) { throw cloudflareWords(error, `writing the proof record ${name}`); }
  }

  async removeProofRecord(record: DnsProofRecord): Promise<void> {
    if (!record.id) return;
    const client = await this.client();
    try { await client.dns!.records.delete?.(record.id, { zone_id: record.zoneId }); } catch (error) { throw cloudflareWords(error, `removing the proof record ${record.name}`); }
  }

  private async addressRecords(zoneId: string, name: string): Promise<readonly CloudflareDnsRecordLike[]> {
    const client = await this.client();
    try { return await collectAsync(client.dns!.records.list({ zone_id: zoneId, type: 'A', name: { exact: name } }), 20); } catch (error) { throw cloudflareWords(error, `reading the address record of ${name}`); }
  }

  async setAddressRecord(name: string, address: string): Promise<{ readonly changed: boolean }> {
    const zone = await this.zoneFor(name);
    const client = await this.client();
    const existing = (await this.addressRecords(zone.id, name)).filter((record) => record.name === name && record.type === 'A');
    const ours = existing.find((record) => record.comment === SECURE_ADDRESS_RECORD_COMMENT);
    const theirs = existing.find((record) => record.comment !== SECURE_ADDRESS_RECORD_COMMENT);
    if (theirs && !ours) {
      throw new DnsProviderError(`${name} already has an address record (to ${theirs.content}) that GoodVibes did not write, so it was left as it is. Remove it in Cloudflare or choose another name.`, 'record-taken');
    }
    const params = { zone_id: zone.id, type: 'A' as const, name, content: address, proxied: false, ttl: 60, comment: SECURE_ADDRESS_RECORD_COMMENT };
    try {
      if (ours?.id) {
        if (ours.content === address) return { changed: false };
        await client.dns!.records.update(ours.id, params);
        return { changed: true };
      }
      await client.dns!.records.create(params);
      return { changed: true };
    } catch (error) { throw cloudflareWords(error, `writing the address record ${name}`); }
  }

  async removeAddressRecord(name: string): Promise<void> {
    const zone = await this.zoneFor(name);
    const client = await this.client();
    for (const record of await this.addressRecords(zone.id, name)) {
      if (record.comment !== SECURE_ADDRESS_RECORD_COMMENT || !record.id) continue;
      try { await client.dns!.records.delete?.(record.id, { zone_id: zone.id }); } catch (error) { throw cloudflareWords(error, `removing the address record ${name}`); }
    }
  }
}
