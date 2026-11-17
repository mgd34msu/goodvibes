import type { CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import type { CommandContext } from '../input/command-registry.ts';

/**
 * What the paired devices can do, read from the one owner: the daemon's device
 * capability runtime (paired nodes with the catalog capabilities each serves,
 * and the live grants), through `context.platform.devices`. A row is typed by
 * its capability id, so nothing is interpreted.
 */
export interface DeviceLiveCapabilityRecord {
  /** `<nodeId>:<capabilityId>`. */
  readonly id: string;
  /** The device catalog id, e.g. `device.camera.rear.capture`. */
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly nodeLabel: string | null;
  readonly nodeKind: string | null;
  readonly platform: string | null;
  /** `granted`: a live grant covers it; `ask`: the node serves it and a request asks under `permissions.mode`. */
  readonly status: 'granted' | 'ask';
  readonly grant: {
    readonly grantId: string;
    readonly scope: string | null;
    readonly expiresAt: string | null;
    readonly lastUsedAt: string | null;
    readonly useCount: number;
  } | null;
  readonly modelRoute: string;
}

export interface DeviceLiveReadModelSnapshot {
  readonly capabilities: readonly DeviceLiveCapabilityRecord[];
  readonly pairedNodes: number;
  /** Why the device runtime could not be read (no daemon client, or the daemon did not answer); absent when it was read. */
  readonly unavailable?: string;
}

/** Device catalog capabilities that a camera, screen, location or device-command row covers. */
export const SENSOR_DEVICE_CAPABILITY_IDS: readonly string[] = [
  'device.camera.rear.capture', 'device.camera.front.capture', 'device.screen.capture',
  'device.location.coarse', 'device.location.precise',
  'device.command.notify', 'device.command.open_url', 'device.command.vibrate',
];

function isoTime(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One read of the paired nodes and one of the grants, side by side. A daemon
 * that does not answer is reported in `unavailable`; it is not an empty map.
 */
export async function deviceLiveReadModelSnapshot(context: CommandContext, options: CatalogRankingOptions = {}): Promise<DeviceLiveReadModelSnapshot> {
  options.signal?.throwIfAborted();
  const devices = context.platform.devices;
  if (!devices) return { capabilities: [], pairedNodes: 0, unavailable: 'This runtime has no connection to the daemon\'s device runtime.' };
  const [nodes, grants] = await Promise.allSettled([devices.listNodes(), devices.listGrants()]);
  options.signal?.throwIfAborted();
  if (nodes.status === 'rejected') return { capabilities: [], pairedNodes: 0, unavailable: `Paired devices could not be read: ${reason(nodes.reason)}` };
  const grantsByKey = new Map<string, NonNullable<DeviceLiveCapabilityRecord['grant']>>();
  if (grants.status === 'fulfilled') {
    for (const grant of grants.value) {
      if (!grant.nodeId || !grant.capabilityId) continue;
      grantsByKey.set(`${grant.nodeId}:${grant.capabilityId}`, {
        grantId: grant.grantId,
        scope: grant.scope ?? null,
        expiresAt: isoTime(grant.expiresAt),
        lastUsedAt: isoTime(grant.lastUsedAt),
        useCount: grant.useCount ?? 0,
      });
    }
  }
  const capabilities: DeviceLiveCapabilityRecord[] = [];
  for (const node of nodes.value) {
    for (const capabilityId of node.supported ?? []) {
      const id = `${node.nodeId}:${capabilityId}`;
      const grant = grantsByKey.get(id) ?? null;
      capabilities.push({
        id,
        capabilityId,
        nodeId: node.nodeId,
        nodeLabel: node.label ?? null,
        nodeKind: node.nodeKind ?? null,
        platform: node.platform ?? null,
        status: grant ? 'granted' : 'ask',
        grant,
        modelRoute: `phone action:"run" nodeId:${JSON.stringify(node.nodeId)} capabilityId:${JSON.stringify(capabilityId)}`,
      });
    }
  }
  return {
    capabilities,
    pairedNodes: nodes.value.length,
    ...(grants.status === 'rejected' ? { unavailable: `Grants could not be read (every row shows "ask"): ${reason(grants.reason)}` } : {}),
  };
}

/** The rows for the given device catalog ids. */
export function deviceLiveRecordsFor(snapshot: DeviceLiveReadModelSnapshot, capabilityIds: readonly string[]): readonly DeviceLiveCapabilityRecord[] {
  const wanted = new Set(capabilityIds);
  return snapshot.capabilities.filter((record) => wanted.has(record.capabilityId));
}
