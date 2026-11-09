import { createHomeGraphNodeIdentityPlanner, prepareHomeGraphNodeIdentity } from './node-identity-plan.js';
import { homeGraphIdentitySpace } from '../store-homegraph-node-selector.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';
import { upsertObservedKnowledgeNode } from '../store-node-observation.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeNodeUpsertInput, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeStore } from '../store.js';
import { isActiveKnowledgeEdge } from '../projection-utils.js';
import {
  belongsToSpace,
  buildHomeGraphMetadata,
  nodeKindForHomeGraphObject,
  targetToReference,
} from './helpers.js';
import type { HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult, HomeGraphUnlinkResult } from './types.js';

type ResolvedLinkTarget = {
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly record: KnowledgeSourceRecord | KnowledgeNodeRecord | null;
};

export async function linkHomeGraphKnowledge(
  store: KnowledgeStore,
  input: HomeGraphLinkInput & { readonly spaceId: string; readonly installationId: string },
): Promise<HomeGraphLinkResult> {
  const from = resolveLinkSource(store, input.spaceId, input);
  const target = await ensureHomeGraphLinkTarget(store, input.spaceId, input.installationId, input.target);
  const relation = input.relation ?? input.target.relation ?? 'source_for';
  const edge = await store.upsertEdge({
    fromKind: from.kind,
    fromId: from.id,
    toKind: target.kind,
    toId: target.id,
    relation,
    metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
      ...(input.metadata ?? {}),
      linkStatus: typeof input.metadata?.linkStatus === 'string' ? input.metadata.linkStatus : 'active',
    }),
  });
  return { ok: true, spaceId: input.spaceId, edge, target: target.record };
}

export async function unlinkHomeGraphKnowledge(
  store: KnowledgeStore,
  input: HomeGraphLinkInput & { readonly spaceId: string; readonly installationId: string },
): Promise<HomeGraphUnlinkResult> {
  const from = resolveLinkSource(store, input.spaceId, input);
  const target = resolveExistingHomeGraphTarget(store, input.spaceId, input.target);
  const relation = input.relation ?? input.target.relation ?? 'source_for';
  // Never-linked target: nothing to reverse, and we materialize no phantom records.
  if (!target) {
    return { ok: true, spaceId: input.spaceId, reversed: false, target: null };
  }
  const edge = findHomeGraphLinkEdge(store, from, target, relation);
  if (!edge) {
    return { ok: true, spaceId: input.spaceId, reversed: false, target: target.record };
  }
  await store.deleteEdge(edge.id);
  let removedNodeId: string | undefined;
  if (
    target.kind === 'node'
    && target.record
    && wasLinkCreatedNode(target.record as KnowledgeNodeRecord)
    && !hasOtherActiveEdges(store, target.id, edge.id)
  ) {
    await store.deleteNode(target.id);
    removedNodeId = target.id;
  }
  return {
    ok: true,
    spaceId: input.spaceId,
    reversed: true,
    removedEdgeId: edge.id,
    ...(removedNodeId ? { removedNodeId } : {}),
    target: target.record,
  };
}

function resolveExistingHomeGraphTarget(
  store: KnowledgeStore,
  spaceId: string,
  target: HomeGraphKnowledgeTarget,
): ResolvedLinkTarget | null {
  const ref = targetToReference(target);
  if (ref.kind === 'source') {
    const source = store.getSource(ref.id);
    return source && belongsToSpace(source, spaceId) ? { kind: 'source', id: source.id, record: source } : null;
  }
  const existing = store.getNode(ref.id);
  if (existing && belongsToSpace(existing, spaceId)) return { kind: 'node', id: existing.id, record: existing };
  const kind = ref.nodeKind ?? nodeKindForHomeGraphObject(target.kind as never);
  const saved = createHomeGraphNodeIdentityPlanner(store).lookup({ spaceId, kind, objectId: ref.id });
  return saved
    ? { kind: 'node', id: saved.id, record: saved }
    : null;
}

function findHomeGraphLinkEdge(
  store: KnowledgeStore,
  from: { readonly kind: 'source' | 'node'; readonly id: string },
  target: ResolvedLinkTarget,
  relation: string,
): KnowledgeEdgeRecord | undefined {
  return store.edgesFor(from.kind, from.id).find((edge) => (
    edge.fromKind === from.kind
    && edge.fromId === from.id
    && edge.toKind === target.kind
    && edge.toId === target.id
    && edge.relation === relation
  ));
}

function wasLinkCreatedNode(node: KnowledgeNodeRecord): boolean {
  return node.metadata.linkCreated === true;
}

function hasOtherActiveEdges(store: KnowledgeStore, nodeId: string, excludeEdgeId: string): boolean {
  return store.edgesFor('node', nodeId).some((edge) => edge.id !== excludeEdgeId && isActiveKnowledgeEdge(edge));
}

function resolveLinkSource(
  store: KnowledgeStore,
  spaceId: string,
  input: HomeGraphLinkInput,
): { readonly kind: 'source' | 'node'; readonly id: string } {
  if (input.sourceId) {
    const source = store.getSource(input.sourceId);
    if (!source || !belongsToSpace(source, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph source: ${input.sourceId}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'source', id: source.id };
  }
  if (input.nodeId) {
    const node = store.getNode(input.nodeId);
    if (!node || !belongsToSpace(node, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph node: ${input.nodeId}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'node', id: node.id };
  }
  throw new GoodVibesSdkError('linkKnowledge requires sourceId or nodeId.', {
    category: 'bad_request',
    source: 'runtime',
    recoverable: false,
  });
}

async function ensureHomeGraphLinkTarget(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  target: HomeGraphKnowledgeTarget,
): Promise<{
  readonly kind: 'source' | 'node';
  readonly id: string;
  readonly record: KnowledgeSourceRecord | KnowledgeNodeRecord | null;
}> {
  const ref = targetToReference(target);
  if (ref.kind === 'source') {
    const source = store.getSource(ref.id);
    if (!source || !belongsToSpace(source, spaceId)) {
      throw new GoodVibesSdkError(`Unknown Home Graph source target: ${ref.id}`, {
        category: 'not_found',
        source: 'runtime',
        recoverable: false,
      });
    }
    return { kind: 'source', id: source.id, record: source };
  }
  const existing = store.getNode(ref.id);
  if (existing && belongsToSpace(existing, spaceId)) return { kind: 'node', id: existing.id, record: existing };
  if (existing) throw new GoodVibesSdkError('Home Graph link target belongs to another knowledge space.', {
    category: 'not_found', source: 'runtime', recoverable: false,
  });
  const kind = ref.nodeKind ?? nodeKindForHomeGraphObject(target.kind as never);
  const identities = createHomeGraphNodeIdentityPlanner(store);
  const identity = prepareHomeGraphNodeIdentity(identities, store, { spaceId, kind, objectId: ref.id });
  const saved = identities.lookup(identity.selector);
  if (saved) return { kind: 'node', id: saved.id, record: saved };
  const nodeInput: KnowledgeNodeUpsertInput = {
    id: identity.id,
    kind,
    slug: identity.slug,
    title: target.title ?? target.id,
    aliases: [target.id],
    confidence: 60,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeGraphIdentityVersion: 1, homeGraphIdentitySpace: homeGraphIdentitySpace(spaceId),
      homeAssistant: { installationId, objectKind: kind, objectId: identity.objectId },
      // Marks a node the link itself materialized, so unlink can cleanly remove it
      // (and only it) on reversal.
      linkCreated: true,
      ...(isClassicOperation() ? { provenance: 'classic', existence: 'caller-declared', semanticAssessment: 'not-evaluated' } : {}),
    }),
  };
  const evidence = snapshotNodeInput(target);
  const node = isClassicOperation()
    ? await upsertObservedKnowledgeNode(store, nodeInput, 'link-declaration', evidence, () => { identity.assertCurrent(); return target; })
    : await store.upsertNode(nodeInput);
  return { kind: 'node', id: node.id, record: node };
}
