import { isClassicOperation } from '../../runtime/decision-policy.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import {
  listGeneratedKnowledgePages,
  type GeneratedKnowledgePageGraph,
} from '../generated-pages.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import { isGeneratedPageSource, readRecord } from './helpers.js';
import type { HomeGraphPageGraphNode, HomeGraphPageListResult } from './types.js';

/**
 * Lists generated pages, ordered by the priority stored on each page when it
 * was generated (pages without one follow, by title). Listing reads what is
 * stored: no model request, and it works with the model down.
 */
export async function listHomeGraphPages(input: {
  readonly artifactStore: ArtifactStore;
  readonly spaceId: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly limit: number;
  readonly includeMarkdown: boolean;
}): Promise<HomeGraphPageListResult> {
  const result = await listGeneratedKnowledgePages<HomeGraphPageGraphNode>({
    artifactStore: input.artifactStore,
    spaceId: input.spaceId,
    sources: input.sources,
    nodes: input.nodes,
    edges: input.edges,
    limit: input.limit,
    includeMarkdown: input.includeMarkdown,
    isGeneratedSource: isGeneratedPageSource,
    isPageSubjectNode,
    resolvePageSubject,
    projectNode: pageGraphNode,
    rankGeneratedPages: async (sources) => [...sources].sort(compareStoredPagePriority),
  });
  return { ...result, ...(isClassicOperation() ? { provenance: 'classic' as const } : {}) };
}

function storedPagePriority(source: KnowledgeSourceRecord): number | undefined {
  const value = source.metadata.pagePriority;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function compareStoredPagePriority(left: KnowledgeSourceRecord, right: KnowledgeSourceRecord): number {
  const a = storedPagePriority(left), b = storedPagePriority(right);
  if (a !== undefined || b !== undefined) {
    if (a === undefined) return 1;
    if (b === undefined) return -1;
    if (a !== b) return b - a;
  }
  return (left.title ?? left.id).localeCompare(right.title ?? right.id) || left.id.localeCompare(right.id);
}

function resolvePageSubject(target: KnowledgeNodeRecord, graph: GeneratedKnowledgePageGraph): KnowledgeNodeRecord | undefined {
  if (target.kind === 'ha_device_passport') {
    const deviceEdge = graph.edges.find((edge) => (
      edge.fromKind === 'node'
      && edge.fromId === target.id
      && edge.toKind === 'node'
      && edge.relation === 'source_for'
    ));
    return deviceEdge ? graph.nodesById.get(deviceEdge.toId) : undefined;
  }
  if (isPageSubjectNode(target)) return target;
  return undefined;
}

function isPageSubjectNode(node: KnowledgeNodeRecord): boolean {
  if (node.status === 'stale') return false;
  if (node.metadata.semanticKind) return false;
  return !['fact', 'knowledge_gap', 'wiki_page', 'ha_device_passport'].includes(node.kind);
}

function pageGraphNode(node: KnowledgeNodeRecord): HomeGraphPageGraphNode {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    id: node.id,
    kind: node.kind,
    title: node.title,
    ...(typeof ha.objectKind === 'string' ? { objectKind: ha.objectKind } : {}),
    ...(typeof ha.objectId === 'string' ? { objectId: ha.objectId } : {}),
    ...(typeof ha.entityId === 'string' ? { entityId: ha.entityId } : {}),
    ...(typeof ha.deviceId === 'string' ? { deviceId: ha.deviceId } : {}),
    ...(typeof ha.areaId === 'string' ? { areaId: ha.areaId } : {}),
    ...(typeof ha.integrationId === 'string' ? { integrationId: ha.integrationId } : {}),
  };
}

export function prioritySubject(node: KnowledgeNodeRecord) {
  const ha = readRecord(node.metadata.homeAssistant);
  return {
    kind: node.kind, title: node.title, summary: node.summary,
    manufacturer: node.metadata.manufacturer, model: node.metadata.model,
    objectKind: ha.objectKind, domain: ha.domain ?? node.metadata.domain,
  };
}
