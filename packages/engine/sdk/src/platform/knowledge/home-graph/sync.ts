import { createHomeGraphNodeIdentityPlanner, prepareHomeGraphNodeIdentity, type HomeGraphNodeIdentityPlanner } from './node-identity-plan.js';
import { homeGraphIdentitySpace } from '../store-homegraph-node-selector.js';
import { captureSnapshotGroups, currentSnapshotMembership, storedSnapshotGroups, snapshotGroups, type CapturedSnapshotGroups } from './snapshot-groups.js';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { knowledgeClockIso, knowledgeRawRepresentation, retainKnowledgeRepresentation } from '../store-record-representation.js';
import { captureGeneratedKnowledgeSourceUpdate, registerGeneratedKnowledgeSourceReferences } from '../source-structural-references.js';
import { upsertObservedKnowledgeNode } from '../store-node-observation.js';
import { snapshotNodeInput } from '../activation/projection.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import { updateHomeGraphSnapshotGroups, type KnowledgeStore } from '../store.js';
import type { KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { yieldEvery } from '../cooperative.js';
import { autoLinkHomeGraphSources } from './auto-link.js';
import { upsertIntegrationDocumentationCandidates } from './documentation.js';
import { generateAutomaticHomeGraphPages } from './generated-pages.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  buildHomeGraphNodeInput,
  edgeIsActive,
  homeGraphObjectId,
  nodeKindForHomeGraphObject,
  homeGraphSourceId,
  isGeneratedPageSource,
  namespacedCanonicalUri,
  normalizeHomeGraphObjectInput,
  readRecord,
  resolveHomeGraphSpace,
} from './helpers.js';
import { linkHomeGraphSnapshotObjectReferences } from './link-node.js';
import { refreshHomeGraphQualityReport } from './quality.js';
import { HomeGraphQualityHeldError } from './quality/reader.js';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphObjectInput, HomeGraphSnapshotInput, HomeGraphSyncResult } from './types.js';

const SNAPSHOT_NODE_KINDS = new Set<string>([
  'ha_home',
  'ha_entity',
  'ha_device',
  'ha_area',
  'ha_automation',
  'ha_script',
  'ha_scene',
  'ha_label',
  'ha_integration',
]);

export async function runHomeGraphSnapshotSync(input: {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly snapshot: HomeGraphSnapshotInput;
  readonly signal?: AbortSignal | undefined;
}): Promise<HomeGraphSyncResult> {
  return withConfiguredDecisionModelPolicy(async () => {
    const { store, artifactStore } = input;
    const snapshot = snapshotNodeInput(input.snapshot);
    const { spaceId, installationId } = resolveHomeGraphSpace(snapshot);
    const snapshotMembership = captureSnapshotGroups(snapshot);
    await store.init();
    // Validate saved membership before any snapshot prefix is mutated.
    for (const node of store.listNodesInSpace(spaceId)) if (SNAPSHOT_NODE_KINDS.has(node.kind) && readRecord(node.metadata.homeAssistant).installationId === installationId) storedSnapshotGroups(node);
    const nodeIdentities = createHomeGraphNodeIdentityPlanner(store);
    // One native read frame prepares existing tuples/absence for the pass.
    store.assertRecordSnapshotFrame(() => {
      prepareHomeGraphNodeIdentity(nodeIdentities, store, { spaceId, kind: 'ha_home', objectId: snapshot.homeId ?? installationId });
      for (const [group, kind] of snapshotGroups) for (const object of snapshotMembership.snapshot[group] ?? []) {
        const nodeKind = nodeKindForHomeGraphObject(kind);
        prepareHomeGraphNodeIdentity(nodeIdentities, store, { spaceId, kind: nodeKind, objectId: homeGraphObjectId(nodeKind, object) });
      }
      return undefined;
    });
    const captured = await store.batch(async () => {
      const capturedAt = snapshot.capturedAt ?? Date.now();
      const sourceId = homeGraphSourceId(spaceId, 'snapshot', String(capturedAt));
      const canonicalUri = namespacedCanonicalUri(spaceId, 'snapshot', String(capturedAt));
      const sourceInput = {
        id: sourceId,
        connectorId: HOME_GRAPH_CONNECTOR_ID,
        sourceType: 'dataset' as const,
        title: snapshot.title ?? 'Home Assistant snapshot',
        canonicalUri,
        summary: 'Home Assistant entity, device, area, automation, script, scene, label, and integration snapshot.',
        tags: ['homeassistant', 'home-graph', 'snapshot'],
        status: 'indexed' as const,
        lastCrawledAt: capturedAt,
        metadata: buildHomeGraphMetadata(spaceId, installationId, {
          ...(snapshot.metadata ?? {}),
          homeGraphSourceKind: 'snapshot',
          capturedAt: snapshot.capturedAt ?? knowledgeClockIso(capturedAt),
        }),
      };
      const source = await store.upsertSource(snapshot.capturedAt === undefined
        ? retainKnowledgeRepresentation(sourceInput, { ...knowledgeRawRepresentation(sourceInput), lastCrawledAt: knowledgeClockIso(capturedAt) })
        : sourceInput);
      registerGeneratedKnowledgeSourceReferences(store, source, { id: sourceId, canonicalUri });
      const home = await upsertHomeNode(store, spaceId, installationId, snapshot, nodeIdentities);
      const beforeState = readHomeGraphState(store, spaceId);
      const beforeNodeIds = new Set(beforeState.nodes.map((node) => node.id));
      const beforeEdgeIds = new Set(beforeState.edges.map((edge) => edge.id));
      const activeSnapshotNodeIds = new Set([home.id]);
      const counts = await upsertSnapshotObjects(store, spaceId, installationId, snapshotMembership, home.id, source.id, activeSnapshotNodeIds, nodeIdentities);
      await retireMissingSnapshotRecords(store, spaceId, installationId, source.id, activeSnapshotNodeIds, snapshotMembership);
      return { source, home, beforeNodeIds, beforeEdgeIds, groups: counts };
    });
    // batch() is a deferred save, not a rollback transaction. Finish the raw
    // snapshot write phase before semantic readers inspect committed SQL rows.
    // A later enrichment hold preserves this captured prefix but cannot publish
    // an unvalidated link or generated page. Imports retain their own atomic seam.
    const { source, home, beforeNodeIds, beforeEdgeIds, groups } = captured;
    await autoLinkExistingSources(store, spaceId, installationId, input.signal);
    return await store.batch(async () => {
      let issueCount = 0;
      let quality: NonNullable<HomeGraphSyncResult['quality']>;
      if (isClassicOperation()) quality = { status: 'held', reason: 'decision-model-disabled' };
      else try {
        const report = await refreshHomeGraphQualityReport(store, spaceId, installationId, { signal: input.signal });
        issueCount = report.issues.length;
        quality = report.retainedLegacyIssues
          ? { status: 'partial', reason: 'legacy-reviewed-state-retained', retainedLegacyIssues: report.retainedLegacyIssues }
          : { status: 'refreshed' };
      } catch (error) {
        if (input.signal?.aborted) throw error;
        if (!(error instanceof HomeGraphQualityHeldError) && !(error instanceof JudgmentInputError)) throw error;
        quality = { status: 'held', reason: error instanceof HomeGraphQualityHeldError ? error.reason : error.problem === 'unsupported-input' ? 'malformed' : 'protected-input' };
      }
      const generated = await generateAutomaticHomeGraphPages({
        store,
        artifactStore,
        spaceId,
        installationId,
        input: snapshot,
        signal: input.signal,
      });
      const after = readHomeGraphState(store, spaceId);
      return {
        ok: true,
        ...(isClassicOperation() ? { provenance: 'classic' as const } : {}),
        spaceId,
        installationId,
        source,
        home,
        created: {
          nodes: after.nodes.filter((node) => !beforeNodeIds.has(node.id)).length,
          edges: after.edges.filter((edge) => !beforeEdgeIds.has(edge.id)).length,
          issues: issueCount,
        },
        generated,
        quality,
        counts: groups,
      };
    });
  });
}

async function autoLinkExistingSources(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  signal?: AbortSignal,
): Promise<void> {
  const state = readHomeGraphState(store, spaceId);
  const extractionBySourceId = new Map(state.extractions.map((extraction) => [extraction.sourceId, extraction]));
  await autoLinkHomeGraphSources({
    signal,
    store,
    spaceId,
    installationId,
    sources: state.sources,
    extractionBySourceId,
    state,
  });
}

async function upsertHomeNode(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  input: HomeGraphSnapshotInput,
  identities: HomeGraphNodeIdentityPlanner,
): Promise<KnowledgeNodeRecord> {
  const identity = prepareHomeGraphNodeIdentity(identities, store, { spaceId, kind: 'ha_home', objectId: input.homeId ?? installationId });
  return upsertObservedKnowledgeNode(store, {
    id: identity.id,
    kind: 'ha_home',
    slug: identity.slug,
    title: input.title ?? 'Home Assistant',
    summary: 'Home Assistant installation captured in the GoodVibes Home Graph.',
    aliases: [installationId],
    status: 'active',
    confidence: 100,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeGraphIdentityVersion: 1, homeGraphIdentitySpace: homeGraphIdentitySpace(spaceId),
      homeAssistant: { installationId, objectKind: 'home', objectId: identity.objectId },
    }),
  }, 'home-assistant-snapshot', input, () => { identity.assertCurrent(); return input; });
}

async function upsertSnapshotObjects(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  captured: CapturedSnapshotGroups,
  homeNodeId: string,
  sourceId: string,
  activeNodeIds: Set<string>,
  identities: HomeGraphNodeIdentityPlanner,
): Promise<HomeGraphSyncResult['counts']> {
  const input = captured.snapshot;
  const counts = {
    entities: 0,
    helpers: 0,
    devices: 0,
    areas: 0,
    automations: 0,
    scripts: 0,
    scenes: 0,
    labels: 0,
    integrations: 0,
  };
  const upsertGroup = async (kind: Parameters<typeof buildHomeGraphNodeInput>[2], objects: readonly HomeGraphObjectInput[] | undefined) => {
    let count = 0;
    for (const [index, rawObject] of (objects ?? []).entries()) {
      await yieldEvery(index, 16);
      const object = normalizeHomeGraphObjectInput(kind, rawObject);
      const nodeKind = nodeKindForHomeGraphObject(kind);
      const identity = prepareHomeGraphNodeIdentity(identities, store, { spaceId, kind: nodeKind, objectId: homeGraphObjectId(nodeKind, object) });
      const baseInput = buildHomeGraphNodeInput(spaceId, installationId, kind, object, identity);
      const previous = store.getNode(baseInput.id);
      const membership = previous ? currentSnapshotMembership(captured, previous)
        : [...(captured.members.get(nodeKindForHomeGraphObject(kind))?.get(homeGraphObjectId(nodeKindForHomeGraphObject(kind), object)) ?? [])];
      const nodeInput = { ...baseInput, metadata: buildHomeGraphMetadata(spaceId, installationId, { ...baseInput.metadata,
        homeAssistant: { ...readRecord(baseInput.metadata.homeAssistant), snapshotGroups: membership } }) };
      const node = await upsertObservedKnowledgeNode(store, { ...nodeInput, sourceId, status: 'active', confidence: 90 },
        'home-assistant-snapshot', store.getSource(sourceId), () => { identity.assertCurrent(); return store.getSource(sourceId); });
      activeNodeIds.add(node.id);
      await store.upsertEdge({
        fromKind: 'node',
        fromId: node.id,
        toKind: 'node',
        toId: homeNodeId,
        relation: 'source_for',
        metadata: buildHomeGraphMetadata(spaceId, installationId),
      });
      await linkHomeGraphSnapshotObjectReferences(store, { spaceId, installationId, node, object }, identities);
      if (node.kind === 'ha_integration') {
        await upsertIntegrationDocumentationCandidates(store, spaceId, installationId, node, object);
      }
      count += 1;
      await yieldEvery(count, 16);
    }
    return count;
  };
  counts.areas = await upsertGroup('area', input.areas);
  counts.integrations = await upsertGroup('integration', input.integrations);
  counts.devices = await upsertGroup('device', input.devices);
  counts.entities = await upsertGroup('entity', input.entities);
  counts.helpers = await upsertGroup('entity', input.helpers);
  counts.automations = await upsertGroup('automation', input.automations);
  counts.scripts = await upsertGroup('script', input.scripts);
  counts.scenes = await upsertGroup('scene', input.scenes);
  counts.labels = await upsertGroup('label', input.labels);
  return counts;
}

async function retireMissingSnapshotRecords(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  currentSnapshotSourceId: string,
  activeNodeIds: ReadonlySet<string>,
  captured: CapturedSnapshotGroups,
): Promise<void> {
  const staleAt = Date.now();
  const retiredNodeIds = new Set<string>();
  for (const node of store.listNodesInSpace(spaceId)) {
    if (!isSnapshotOwnedNode(node, installationId)) continue;
    if (activeNodeIds.has(node.id)) continue;
    if (node.status === 'stale') continue;
    const membership = currentSnapshotMembership(captured, node);
    if (membership.length) {
      const before = storedSnapshotGroups(node);
      if (before.length !== membership.length || before.some((group, index) => group !== membership[index])) await updateHomeGraphSnapshotGroups(store, node, membership, () => {
        if (currentSnapshotMembership(captured, node).join(',') !== membership.join(',')) throw new Error('Home Graph snapshot membership changed before publication.');
      });
      continue;
    }
    // Unattributed saved bodies cannot be matched to a new declared identity.
    // Keep their records until an explicit owner action identifies/removes them.
    if (/^unknown-[0-9a-f]{16}$/.test(String(readRecord(node.metadata.homeAssistant).objectId ?? ''))) continue;
    retiredNodeIds.add(node.id);
    await markNodeStale(store, spaceId, installationId, node, 'missing-from-latest-home-assistant-snapshot', staleAt);
  }

  // A partial snapshot does not replace omitted groups' original evidence.
  // Retained nodes keep their original source; do not stale it merely because
  // another group's new snapshot source was captured.
  const retainedSourceIds = new Set(store.listNodesInSpace(spaceId).filter(node => node.status !== 'stale').flatMap(node => node.sourceId ? [node.sourceId] : []));
  for (const source of store.listSourcesInSpace(spaceId)) {
    if (!isPreviousSnapshotSource(source, currentSnapshotSourceId, installationId) || retainedSourceIds.has(source.id)) continue;
    if (source.status === 'stale') continue;
    await markSourceStale(store, spaceId, installationId, source, 'superseded-by-newer-home-assistant-snapshot', staleAt);
  }

  if (retiredNodeIds.size > 0) {
    await retireGeneratedRecordsForStaleSnapshotNodes(store, spaceId, installationId, retiredNodeIds, staleAt);
  }
}

async function retireGeneratedRecordsForStaleSnapshotNodes(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  retiredNodeIds: ReadonlySet<string>,
  staleAt: number,
): Promise<void> {
  const nodes = store.listNodesInSpace(spaceId);
  const edges = store.listEdges();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const generatedTargetIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'node'
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
      && retiredNodeIds.has(edge.toId)) {
      generatedTargetIds.add(edge.fromId);
    }
  }

  for (const nodeId of generatedTargetIds) {
    const node = nodesById.get(nodeId);
    if (!node || node.status === 'stale') continue;
    await markNodeStale(store, spaceId, installationId, node, 'target-missing-from-latest-home-assistant-snapshot', staleAt);
  }

  const staleTargetIds = new Set([...retiredNodeIds, ...generatedTargetIds]);
  for (const source of store.listSourcesInSpace(spaceId)) {
    if (source.status === 'stale') continue;
    if (!isGeneratedPageSource(source)) continue;
    const targetsStaleNode = edges.some((edge) => (
      edgeIsActive(edge)
      && edge.fromKind === 'source'
      && edge.fromId === source.id
      && edge.toKind === 'node'
      && staleTargetIds.has(edge.toId)
    ));
    if (!targetsStaleNode) continue;
    await markSourceStale(store, spaceId, installationId, source, 'target-missing-from-latest-home-assistant-snapshot', staleAt);
  }
}

async function markNodeStale(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  node: KnowledgeNodeRecord,
  staleReason: string,
  staleAt: number,
): Promise<void> {
  await store.upsertNode({
    id: node.id,
    kind: node.kind,
    slug: node.slug,
    title: node.title,
    summary: node.summary,
    aliases: node.aliases,
    status: 'stale',
    confidence: node.confidence,
    sourceId: node.sourceId,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      ...knowledgeRawRepresentation(node).metadata,
      staleReason,
      staleAt: knowledgeClockIso(staleAt),
    }),
  });
}

async function markSourceStale(
  store: KnowledgeStore,
  spaceId: string,
  installationId: string,
  source: KnowledgeSourceRecord,
  staleReason: string,
  staleAt: number,
): Promise<void> {
  const raw = knowledgeRawRepresentation(source);
  const retainReferences = captureGeneratedKnowledgeSourceUpdate(store, source);
  const input = {
    id: source.id,
    connectorId: source.connectorId,
    sourceType: source.sourceType,
    title: source.title,
    sourceUri: source.sourceUri,
    canonicalUri: source.canonicalUri,
    summary: source.summary,
    description: source.description,
    tags: source.tags,
    folderPath: source.folderPath,
    status: 'stale' as const,
    artifactId: source.artifactId,
    contentHash: source.contentHash,
    lastCrawledAt: source.lastCrawledAt,
    crawlError: source.crawlError,
    sessionId: source.sessionId,
    metadata: buildHomeGraphMetadata(spaceId, installationId, {
      ...raw.metadata,
      staleReason,
      staleAt: knowledgeClockIso(staleAt),
    }),
  };
  const updated = await store.upsertSource(retainKnowledgeRepresentation(input, {
    ...knowledgeRawRepresentation(input),
    lastCrawledAt: raw.lastCrawledAt,
  }));
  retainReferences?.(updated);
}


function isSnapshotOwnedNode(
  node: KnowledgeNodeRecord,
  installationId: string,
): boolean {
  if (!SNAPSHOT_NODE_KINDS.has(node.kind)) return false;
  const homeAssistant = readRecord(node.metadata.homeAssistant);
  return homeAssistant.installationId === installationId && storedSnapshotGroups(node).length > 0;
}

function isPreviousSnapshotSource(
  source: KnowledgeSourceRecord,
  currentSnapshotSourceId: string,
  installationId: string,
): boolean {
  if (source.id === currentSnapshotSourceId) return false;
  const homeAssistant = readRecord(source.metadata.homeAssistant);
  return homeAssistant.installationId === installationId
    && source.connectorId === HOME_GRAPH_CONNECTOR_ID
    && source.metadata.homeGraphSourceKind === 'snapshot';
}
