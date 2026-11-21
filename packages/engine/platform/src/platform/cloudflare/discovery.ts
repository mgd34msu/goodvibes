import { summarizeError } from '../utils/error-display.js';
import type {
  CloudflareApiClient,
  CloudflareZoneLike,
} from './types.js';
import { CloudflareControlPlaneError } from './types.js';
import { clean, collectAsync } from './utils.js';

export async function discoverZones(
  client: CloudflareApiClient,
  input: { readonly accountId: string; readonly zoneName?: string | undefined; readonly warnings: string[] },
): Promise<readonly CloudflareZoneLike[]> {
  if (!client.zones) return [];
  return await tryDiscover('zones', input.warnings, async () => {
    const query = {
      ...(input.accountId ? { account: { id: input.accountId } } : {}),
      ...(clean(input.zoneName) ? { name: clean(input.zoneName) } : {}),
    };
    return await collectAsync(client.zones!.list(query), undefined, () => truncationWarning('zones', input.warnings));
  }) ?? [];
}

/** Discovery lists are capped; say so, or a partial account reads as the whole account. */
export function truncationWarning(label: string, warnings: string[]): void {
  warnings.push(`The Cloudflare ${label} list was cut off at 250 items, so this result is partial.`);
}

export async function selectDiscoveredZone(
  client: CloudflareApiClient,
  zones: readonly CloudflareZoneLike[],
  input: {
    readonly zoneId?: string | undefined;
    readonly zoneName?: string | undefined;
    readonly configuredZoneId: string;
    readonly configuredZoneName: string;
    readonly warnings: string[];
  },
): Promise<CloudflareZoneLike | undefined> {
  const { zoneId, zoneName } = requestedZone(input);
  if (zoneId && client.zones) {
    try {
      return await client.zones.get({ zone_id: zoneId });
    } catch (error: unknown) {
      input.warnings.push(`Could not load Cloudflare zone ${zoneId}: ${summarizeError(error)}`);
    }
  }
  if (zoneName) return zones.find((zone) => zone.name === zoneName);
  return zones.length === 1 ? zones[0] : undefined;
}

/**
 * The zone a request means, as a pair: an id it names wins; else a name it
 * names (the configured id is not used, since it may be another zone); else
 * the configured id and name together.
 */
function requestedZone(input: {
  readonly zoneId?: string | undefined;
  readonly zoneName?: string | undefined;
  readonly configuredZoneId: string;
  readonly configuredZoneName: string;
}): { readonly zoneId: string; readonly zoneName: string } {
  const zoneId = clean(input.zoneId);
  if (zoneId) return { zoneId, zoneName: '' };
  const zoneName = clean(input.zoneName);
  if (zoneName) return { zoneId: '', zoneName };
  return { zoneId: input.configuredZoneId, zoneName: input.configuredZoneName };
}

export async function resolveZone(
  client: CloudflareApiClient,
  input: {
    readonly accountId: string;
    readonly zoneId?: string | undefined;
    readonly zoneName?: string | undefined;
    readonly configuredZoneId: string;
    readonly configuredZoneName: string;
    readonly required: boolean;
  },
): Promise<CloudflareZoneLike | undefined> {
  if (!client.zones) {
    if (input.required) {
      throw new CloudflareControlPlaneError('The Cloudflare client does not expose Zones APIs required for the requested operation.', 'CLOUDFLARE_ZONES_API_UNAVAILABLE', 500);
    }
    return undefined;
  }
  const { zoneId, zoneName } = requestedZone(input);
  if (zoneId) return await client.zones.get({ zone_id: zoneId });
  const zones = await collectAsync(client.zones.list({
    ...(input.accountId ? { account: { id: input.accountId } } : {}),
    ...(zoneName ? { name: zoneName } : {}),
  }));
  if (zoneName) return zones.find((zone) => zone.name === zoneName);
  return zones.length === 1 ? zones[0] : undefined;
}

export async function tryDiscover<T>(label: string, warnings: string[], run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error: unknown) {
    warnings.push(`Could not discover Cloudflare ${label}: ${summarizeError(error)}`);
    return undefined;
  }
}
