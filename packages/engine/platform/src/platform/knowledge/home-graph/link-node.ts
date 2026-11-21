import type { HomeGraphNodeIdentityPlanner } from './node-identity-plan.js';
import type { HomeGraphNodeKind } from './types.js';
import type { KnowledgeStore } from '../store.js';
import { buildHomeGraphMetadata } from './helpers.js';

/** One reference a snapshot object makes whose target node resolves: the relation and the target's node id. */
export interface HomeGraphSnapshotObjectReference {
  readonly relation: 'belongs_to_device' | 'located_in' | 'connected_via';
  readonly toId: string;
}

/**
 * The references a snapshot object makes (its device, area and integration)
 * whose targets resolve through the planner the sync prepared. A target absent
 * from the store and the snapshot is left out; it appears here once a later
 * snapshot brings it.
 */
export function resolveHomeGraphSnapshotObjectReferences(
  identities: HomeGraphNodeIdentityPlanner,
  input: {
    readonly spaceId: string;
    readonly nodeId: string;
    readonly nodeKind: HomeGraphNodeKind;
    readonly object: { readonly deviceId?: string | undefined; readonly areaId?: string | undefined; readonly integrationId?: string | undefined };
  },
): HomeGraphSnapshotObjectReference[] {
  const wanted: Array<{ relation: HomeGraphSnapshotObjectReference['relation']; toKind: HomeGraphNodeKind; toObjectId: string | undefined }> = [
    { relation: 'belongs_to_device', toKind: 'ha_device', toObjectId: input.nodeKind === 'ha_device' ? undefined : input.object.deviceId },
    { relation: 'located_in', toKind: 'ha_area', toObjectId: input.object.areaId },
    { relation: 'connected_via', toKind: 'ha_integration', toObjectId: input.object.integrationId },
  ];
  const resolved: HomeGraphSnapshotObjectReference[] = [];
  for (const reference of wanted) {
    if (!reference.toObjectId) continue;
    const target = identities.lookup({ spaceId: input.spaceId, kind: reference.toKind, objectId: reference.toObjectId });
    if (!target || target.id === input.nodeId) continue;
    resolved.push({ relation: reference.relation, toId: target.id });
  }
  return resolved;
}

/** Write the node-to-node edge for each resolved reference of a snapshot object. */
export async function linkHomeGraphSnapshotObjectReferences(
  store: KnowledgeStore,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly nodeId: string;
    readonly references: readonly HomeGraphSnapshotObjectReference[];
  },
): Promise<void> {
  for (const reference of input.references) {
    await store.upsertEdge({
      fromKind: 'node',
      fromId: input.nodeId,
      toKind: 'node',
      toId: reference.toId,
      relation: reference.relation,
      metadata: buildHomeGraphMetadata(input.spaceId, input.installationId),
    });
  }
}
