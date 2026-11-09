import type { HomeGraphNodeIdentityPlanner } from './node-identity-plan.js';
import type { HomeGraphNodeKind } from './types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord } from '../types.js';
import { buildHomeGraphMetadata } from './helpers.js';

export async function linkHomeGraphSnapshotObjectReferences(
  store: KnowledgeStore,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly node: KnowledgeNodeRecord;
    readonly object: { readonly deviceId?: string | undefined; readonly areaId?: string | undefined; readonly integrationId?: string | undefined };
  },
  identities: HomeGraphNodeIdentityPlanner,
): Promise<void> {
  if (input.object.deviceId && input.node.kind !== 'ha_device') {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'belongs_to_device',
      toKind: 'ha_device',
      toObjectId: input.object.deviceId,
    }, identities);
  }
  if (input.object.areaId) {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'located_in',
      toKind: 'ha_area',
      toObjectId: input.object.areaId,
    }, identities);
  }
  if (input.object.integrationId) {
    await linkHomeGraphNodeReference(store, {
      ...input,
      fromId: input.node.id,
      relation: 'connected_via',
      toKind: 'ha_integration',
      toObjectId: input.object.integrationId,
    }, identities);
  }
}

export async function linkHomeGraphNodeReference(
  store: KnowledgeStore,
  input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly fromId: string;
    readonly relation: string;
    readonly toKind: HomeGraphNodeKind;
    readonly toObjectId: string;
  },
  identities: HomeGraphNodeIdentityPlanner,
): Promise<void> {
  const target = identities.lookup({ spaceId: input.spaceId, kind: input.toKind, objectId: input.toObjectId });
  if (!target || input.fromId === target.id) return;
  const toId = target.id;
  await store.upsertEdge({
    fromKind: 'node',
    fromId: input.fromId,
    toKind: 'node',
    toId,
    relation: input.relation,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId),
  });
}
