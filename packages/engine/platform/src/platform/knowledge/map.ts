import {
  applyKnowledgeMapFilters,
  buildKnowledgeMapFacets,
} from './map-filters.js';
import type { KnowledgeScopeSelection } from './scope-selection.js';
import {
  isGeneratedKnowledgeSource,
} from './generated-projections.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFilterInput,
  KnowledgeMapNode,
  KnowledgeMapResult,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from './types.js';

export interface KnowledgeMapRenderState {
  readonly title?: string | undefined;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues?: readonly KnowledgeIssueRecord[] | undefined;
}

export interface KnowledgeMapRenderOptions {
  readonly limit?: number | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeIssues?: boolean | undefined;
  readonly includeGenerated?: boolean | undefined;
  readonly title?: string | undefined;
  readonly spaceId?: string | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
  readonly filters?: KnowledgeMapFilterInput | undefined;
  readonly query?: string | undefined;
  readonly recordKinds?: readonly ('source' | 'node' | 'issue')[] | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly linkedToIds?: readonly string[] | undefined;
  readonly nodeKinds?: readonly string[] | undefined;
  readonly sourceTypes?: readonly string[] | undefined;
  readonly sourceStatuses?: readonly string[] | undefined;
  readonly nodeStatuses?: readonly string[] | undefined;
  readonly issueCodes?: readonly string[] | undefined;
  readonly issueStatuses?: readonly string[] | undefined;
  readonly issueSeverities?: readonly string[] | undefined;
  readonly edgeRelations?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly minConfidence?: number | undefined;
  /** `nextCursor` from an earlier map of the same request: the next slice of records. */
  readonly cursor?: string | undefined;
}

type MapCandidate =
  | { readonly recordKind: 'node'; readonly id: string; readonly kind: string; readonly title: string; readonly record: KnowledgeNodeRecord }
  | { readonly recordKind: 'source'; readonly id: string; readonly kind: string; readonly title: string; readonly record: KnowledgeSourceRecord }
  | { readonly recordKind: 'issue'; readonly id: string; readonly kind: string; readonly title: string; readonly record: KnowledgeIssueRecord };

export function renderKnowledgeMap(
  state: KnowledgeMapRenderState,
  selection: KnowledgeScopeSelection,
  options: KnowledgeMapRenderOptions = {},
): KnowledgeMapResult {
  const limit = sanitizeMapLimit(options.limit);
  const filtered = applyKnowledgeMapFilters({
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues ?? [],
  }, selection, options);
  const filteredEdges = filtered.edges.filter((edge) => edge.fromId !== edge.toId);
  const candidates: MapCandidate[] = [
    ...filtered.nodes.map((node): MapCandidate => ({ recordKind: 'node', id: node.id, kind: node.kind, title: node.title, record: node })),
    ...(options.includeSources === false ? [] : filtered.sources.map((source): MapCandidate => ({
      recordKind: 'source', id: source.id, kind: sourceKind(source), title: source.title ?? source.sourceUri ?? source.id, record: source }))),
    ...(options.includeIssues ? filtered.issues.map((issue): MapCandidate => ({
      recordKind: 'issue', id: issue.id, kind: issue.code, title: issue.message, record: issue })) : []),
  ];
  const focus = new Set([...normalizeIds(options.ids ?? options.filters?.ids), ...normalizeIds(options.linkedToIds ?? options.filters?.linkedToIds)]);
  const ordered = orderMapCandidates(candidates, filteredEdges, focus);
  const offset = readMapCursor(options.cursor, ordered.length);
  const page = ordered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const laid = layoutMapNodes(page.map((candidate): KnowledgeMapNode => mapNodeFor(candidate)), filteredEdges, focus);
  const mapNodes = laid.nodes;
  const nodeIds = new Set(mapNodes.map((node) => node.id));
  const mapNodeById = new Map(mapNodes.map((node) => [node.id, node]));
  const visibleEdges = filteredEdges
    .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId))
    .map((edge) => {
      const from = mapNodeById.get(edge.fromId);
      const to = mapNodeById.get(edge.toId);
      return {
        id: edge.id,
        fromId: edge.fromId,
        toId: edge.toId,
        source: edge.fromId,
        target: edge.toId,
        ...(from ? { fromTitle: from.title, sourceTitle: from.title } : {}),
        ...(to ? { toTitle: to.title, targetTitle: to.title } : {}),
        relation: edge.relation,
        weight: edge.weight,
        metadata: edge.metadata,
      };
    });
  const { width, height } = laid;
  const title = options.title ?? state.title ?? 'Knowledge Map';
  const result: KnowledgeMapResult = {
    ok: true,
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    title,
    generatedAt: Date.now(),
    width,
    height,
    nodeCount: mapNodes.length,
    edgeCount: visibleEdges.length,
    // Only the categories this map can render, so "N of M" never counts nodes that are unreachable.
    totalNodeCount: ordered.length,
    totalEdgeCount: filteredEdges.length,
    ...(nextOffset < ordered.length ? { nextCursor: String(nextOffset) } : {}),
    facets: buildKnowledgeMapFacets(filtered),
    nodes: mapNodes,
    edges: visibleEdges,
    svg: renderMapSvg({ width, height, title, nodes: mapNodes, edges: visibleEdges }),
  };
  selection.assertCurrent();
  return result;
}

function mapNodeFor(candidate: MapCandidate): KnowledgeMapNode {
  if (candidate.recordKind === 'node') {
    const node = candidate.record;
    return { id: node.id, recordKind: 'node', kind: node.kind, title: node.title, ...(node.summary ? { summary: node.summary } : {}),
      x: 0, y: 0, radius: radiusForNodeKind(node.kind), metadata: node.metadata };
  }
  if (candidate.recordKind === 'source') {
    const source = candidate.record;
    return { id: source.id, recordKind: 'source', kind: candidate.kind, title: candidate.title,
      ...(source.summary ? { summary: source.summary } : {}), x: 0, y: 0, radius: 11, metadata: source.metadata };
  }
  const issue = candidate.record;
  return { id: issue.id, recordKind: 'issue', kind: issue.code, title: issue.message, x: 0, y: 0, radius: 10, metadata: issue.metadata };
}

function normalizeIds(value: readonly string[] | undefined): string[] {
  return (value ?? []).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
}

function readMapCursor(cursor: string | undefined, total: number): number {
  const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
  return Number.isFinite(offset) && offset > 0 ? Math.min(offset, total) : 0;
}

/**
 * The order records are shown in: within each record kind (every node kind,
 * documents and issues), the focus records first, then their neighbours, then
 * the most connected; the kinds then take turns, so every kind, documents
 * included, has a share of any slice.
 */
function orderMapCandidates(candidates: readonly MapCandidate[], edges: readonly KnowledgeEdgeRecord[], focus: ReadonlySet<string>): MapCandidate[] {
  const degree = new Map<string, number>();
  const nearFocus = new Set<string>();
  for (const edge of edges) {
    degree.set(edge.fromId, (degree.get(edge.fromId) ?? 0) + 1);
    degree.set(edge.toId, (degree.get(edge.toId) ?? 0) + 1);
    if (focus.has(edge.fromId)) nearFocus.add(edge.toId);
    if (focus.has(edge.toId)) nearFocus.add(edge.fromId);
  }
  const rank = (candidate: MapCandidate): number => focus.has(candidate.id) ? 0 : nearFocus.has(candidate.id) ? 1 : 2;
  const buckets = new Map<string, MapCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.recordKind === 'node' ? `node:${candidate.kind}` : candidate.recordKind;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate); else buckets.set(key, [candidate]);
  }
  const queues = [...buckets.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([, bucket]) => bucket.sort((left, right) =>
    rank(left) - rank(right) || (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || compareRecordTitle(left, right)));
  // A kind holding a focus record goes first in every turn.
  queues.sort((left, right) => rank(left[0]!) - rank(right[0]!));
  const ordered: MapCandidate[] = [];
  for (let index = 0; ordered.length < candidates.length; index += 1) {
    for (const queue of queues) if (index < queue.length) ordered.push(queue[index]!);
  }
  return ordered;
}

/** Spacing along a ring so labels do not overlap. */
const MAP_LABEL_SPACING = 64;
const MAP_RING_STEP = 150;
const MAP_MARGIN = 90;

/**
 * Lays the records out around the focus: the focus records (or, with none, the
 * most connected record) at the centre, each further ring one link further
 * away, records not linked to the centre on the outer ring. A ring grows with
 * its record count so labels keep their spacing; the canvas grows to fit.
 */
function layoutMapNodes(nodes: readonly KnowledgeMapNode[], edges: readonly KnowledgeEdgeRecord[], focus: ReadonlySet<string>): {
  readonly nodes: readonly KnowledgeMapNode[]; readonly width: number; readonly height: number;
} {
  if (nodes.length === 0) return { nodes: [], width: 1280, height: 920 };
  const ids = new Set(nodes.map((node) => node.id));
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ids.has(edge.fromId) || !ids.has(edge.toId)) continue;
    (neighbours.get(edge.fromId) ?? neighbours.set(edge.fromId, []).get(edge.fromId)!).push(edge.toId);
    (neighbours.get(edge.toId) ?? neighbours.set(edge.toId, []).get(edge.toId)!).push(edge.fromId);
  }
  let centre = nodes.filter((node) => focus.has(node.id)).map((node) => node.id);
  if (centre.length === 0) {
    const best = [...nodes].sort((left, right) => (neighbours.get(right.id)?.length ?? 0) - (neighbours.get(left.id)?.length ?? 0))[0]!;
    centre = [best.id];
  }
  const distance = new Map<string, number>(centre.map((id) => [id, 0]));
  const queue = [...centre];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    for (const next of neighbours.get(id) ?? []) {
      if (distance.has(next)) continue;
      distance.set(next, distance.get(id)! + 1);
      queue.push(next);
    }
  }
  const farthest = Math.max(0, ...distance.values());
  const rings = new Map<number, KnowledgeMapNode[]>();
  for (const node of nodes) {
    const ring = distance.get(node.id) ?? farthest + 1;
    (rings.get(ring) ?? rings.set(ring, []).get(ring)!).push(node);
  }
  const placed: { node: KnowledgeMapNode; angle: number; radius: number }[] = [];
  let previousRadius = 0;
  for (const [ring, group] of [...rings.entries()].sort((left, right) => left[0] - right[0])) {
    const minimum = ring === 0 && group.length === 1 ? 0 : previousRadius + (ring === 0 ? 0 : MAP_RING_STEP);
    const radius = group.length === 1 && ring === 0 ? 0 : Math.max(minimum, (group.length * MAP_LABEL_SPACING) / (Math.PI * 2));
    const offset = ring * 0.41;
    group.forEach((node, index) => placed.push({ node, radius, angle: -Math.PI / 2 + offset + (Math.PI * 2 * index) / group.length }));
    previousRadius = radius;
  }
  const extent = previousRadius + MAP_MARGIN;
  const width = Math.max(1280, Math.ceil(extent * 2)), height = Math.max(920, Math.ceil(extent * 2));
  return {
    width,
    height,
    nodes: placed.map(({ node, angle, radius }) => ({
      ...node,
      x: Math.round(width / 2 + Math.cos(angle) * radius),
      y: Math.round(height / 2 + Math.sin(angle) * radius),
    })),
  };
}

function renderMapSvg(input: {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly nodes: readonly KnowledgeMapNode[];
  readonly edges: readonly { readonly fromId: string; readonly toId: string; readonly relation: string }[];
}): string {
  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const edgeLines = input.edges.map((edge) => {
    const from = byId.get(edge.fromId);
    const to = byId.get(edge.toId);
    if (!from || !to) return '';
    return `<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" stroke="rgba(57,74,97,0.35)" stroke-width="1.3"><title>${escapeXml(edge.relation)}</title></line>`;
  }).join('\n');
  const nodeShapes = input.nodes.map((node) => {
    const color = colorForKind(node.kind, node.recordKind);
    const label = truncateLabel(node.title, node.recordKind === 'source' ? 28 : 24);
    const shape = node.recordKind === 'source'
      ? `<rect x="${node.x - 58}" y="${node.y - 17}" width="116" height="34" rx="11" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.4" />`
      : `<circle cx="${node.x}" cy="${node.y}" r="${node.radius}" fill="${color.fill}" stroke="${color.stroke}" stroke-width="1.6" />`;
    const textY = node.recordKind === 'source' ? node.y + 4 : node.y + node.radius + 18;
    return `<g class="node">
  <title>${escapeXml(node.title)} (${escapeXml(node.kind)})</title>
  ${shape}
  <text x="${node.x}" y="${textY}" text-anchor="middle">${escapeXml(label)}</text>
</g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${input.width}" height="${input.height}" viewBox="0 0 ${input.width} ${input.height}" role="img" aria-label="${escapeXml(input.title)}">
<defs>
  <radialGradient id="knowledgeMapBg" cx="50%" cy="46%" r="70%">
    <stop offset="0%" stop-color="#f7f4ec" />
    <stop offset="60%" stop-color="#e9eef0" />
    <stop offset="100%" stop-color="#dde6df" />
  </radialGradient>
  <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#27313a" flood-opacity="0.14"/>
  </filter>
</defs>
<style>
  text { font-family: "Avenir Next", "Trebuchet MS", sans-serif; font-size: 12px; fill: #263238; paint-order: stroke; stroke: rgba(247,244,236,0.76); stroke-width: 3px; stroke-linejoin: round; }
  .node { filter: url(#softShadow); }
</style>
<rect width="100%" height="100%" fill="url(#knowledgeMapBg)" />
<g>${edgeLines}</g>
<g>${nodeShapes}</g>
</svg>`;
}

function sourceKind(source: KnowledgeSourceRecord): string {
  if (isGeneratedKnowledgeSource(source)) {
    const projectionKind = typeof source.metadata.projectionKind === 'string'
      ? source.metadata.projectionKind
      : 'page';
    return `generated_${projectionKind.replace(/[^a-z0-9]+/gi, '_')}`;
  }
  return source.sourceType;
}

function radiusForNodeKind(kind: string): number {
  if (kind === 'ha_home' || kind === 'domain') return 30;
  if (kind === 'topic' || kind === 'ha_area' || kind === 'ha_room' || kind === 'wiki_page') return 23;
  if (kind === 'ha_device') return 18;
  if (kind === 'fact') return 14;
  if (kind === 'ha_entity') return 13;
  return 12;
}

function colorForKind(kind: string, recordKind: KnowledgeMapNode['recordKind']): { readonly fill: string; readonly stroke: string } {
  if (recordKind === 'issue') return { fill: '#f4c7c3', stroke: '#9f3f36' };
  if (recordKind === 'source') {
    if (kind.startsWith('generated_')) return { fill: '#fff1c7', stroke: '#b98920' };
    return { fill: '#dceef5', stroke: '#3f839c' };
  }
  if (kind === 'ha_home' || kind === 'domain') return { fill: '#284b63', stroke: '#102a3a' };
  if (kind === 'topic' || kind === 'ha_area' || kind === 'ha_room') return { fill: '#9ec5ab', stroke: '#49765a' };
  if (kind === 'ha_device') return { fill: '#f2b880', stroke: '#a86028' };
  if (kind === 'ha_entity') return { fill: '#b8c7e0', stroke: '#5d7092' };
  if (kind === 'ha_device_passport') return { fill: '#f6df90', stroke: '#9a7725' };
  if (kind === 'wiki_page') return { fill: '#f7f0d2', stroke: '#8f7a32' };
  if (kind === 'fact') return { fill: '#d7e7c5', stroke: '#5e7f39' };
  if (kind === 'knowledge_entity') return { fill: '#d9cfef', stroke: '#67509c' };
  if (kind === 'knowledge_gap') return { fill: '#f5d5cf', stroke: '#a25042' };
  return { fill: '#d7d0c2', stroke: '#70695e' };
}

function compareRecordTitle(left: { readonly title?: string | undefined; readonly id: string }, right: { readonly title?: string | undefined; readonly id: string }): number {
  return (left.title ?? left.id).localeCompare(right.title ?? right.id) || left.id.localeCompare(right.id);
}

function sanitizeMapLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 500;
  return Math.max(1, Math.min(1000, Math.trunc(value)));
}

function truncateLabel(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}...`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
