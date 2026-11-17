import type { KnowledgeScopeSelection } from '../scope-selection.js';
import { sameKnowledgeRecord } from '../store-record-representation.js';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeMapFacetValue,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { renderKnowledgeMap } from '../map.js';
import { REPAIRS_GAP_RELATION } from './types.js';
import { countFacet, normalizeStringArray, readString } from '../map-filters.js';
import { edgeIsActive, factSourceIds, isGeneratedPageSource, uniqueStrings } from './helpers.js';
import type { HomeGraphMapHaFilterInput, HomeGraphMapInput, HomeGraphMapResult } from './types.js';
import { isHomeGraphPageFactCandidate, assertHomeGraphPageFactPlan, createHomeGraphPageSourceReader, type HomeGraphPageFactReader, type HomeGraphPageFactPlan } from './page-quality.js';

export interface HomeGraphRenderState {
  readonly spaceId: string;
  readonly title: string;
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
}

/** The line every Home Graph page built without a decision model opens with. */
const UNCHECKED_PAGE_NOTE = '> Built without a decision model: linked sources are listed as stored (not ranked or checked for usefulness), and facts are shown as stored, not checked against their sources.';

/** What a room page covers: the area, its devices, entities, automations, scenes and scripts, and the sources linked to them. */
function roomPageScope(state: HomeGraphRenderState, areaId: string | undefined) {
  const area = areaId
    ? findNodeByHaId(state.nodes, 'ha_area', areaId) ?? findNodeByHaId(state.nodes, 'ha_room', areaId)
    : undefined;
  if (areaId && !area) throw new GoodVibesError('Requested Home Graph room was not found.', {
    category: 'not_found', source: 'runtime', operation: 'homegraph.generateRoomPage',
  });
  const title = area?.title ?? state.title;
  const areaNodeId = area?.id;
  const entities = state.nodes.filter((node) => (
    node.kind === 'ha_entity'
    && (!areaNodeId || hasActiveEdge(state.edges, node.id, 'located_in', areaNodeId))
  ));
  const devices = state.nodes.filter((node) => (
    node.kind === 'ha_device'
    && (!areaNodeId || hasActiveEdge(state.edges, node.id, 'located_in', areaNodeId))
  ));
  const automations = filterNodesForArea(state.nodes, state.edges, 'ha_automation', areaNodeId);
  const scenes = filterNodesForArea(state.nodes, state.edges, 'ha_scene', areaNodeId);
  const scripts = filterNodesForArea(state.nodes, state.edges, 'ha_script', areaNodeId);
  const relatedNodeIds = new Set([
    ...(areaNodeId ? [areaNodeId] : []),
    ...devices.map((node) => node.id),
    ...entities.map((node) => node.id),
    ...automations.map((node) => node.id),
    ...scenes.map((node) => node.id),
    ...scripts.map((node) => node.id),
  ]);
  const sourceIds = relatedNodeIds.size > 0 ? sourceIdsLinkedToNodes(state.edges, state.nodes, relatedNodeIds) : null;
  const sourceCandidates = state.sources.filter(source => !isGeneratedPageSource(source) && (!sourceIds || sourceIds.has(source.id)));
  return { title, devices, entities, automations, scenes, scripts, relatedNodeIds, sourceCandidates };
}

function renderRoomBody(state: HomeGraphRenderState, scope: ReturnType<typeof roomPageScope>, sources: readonly KnowledgeSourceRecord[],
  facts: { readonly title: string; readonly nodes: readonly KnowledgeNodeRecord[] }, note?: string): string {
  const { title, devices, entities, automations, scenes, scripts, relatedNodeIds } = scope;
  const issues = issuesForScope(state.issues, state.edges, relatedNodeIds, sources);
  return [
    `# ${title}`,
    '',
    ...(note ? [note, ''] : []),
    `Knowledge space: \`${state.spaceId}\``,
    '',
    renderRoomOverview(title, devices, entities, automations, scenes, scripts),
    renderNodeList('Devices', devices),
    renderNodeList('Entities', entities),
    renderNodeList('Automations', automations),
    renderNodeList('Scenes', scenes),
    renderNodeList('Scripts', scripts),
    renderSemanticFacts(facts.title, facts.nodes),
    renderSourceList('Linked Sources', sources),
    renderIssueList('Open Issues', issues),
  ].filter(Boolean).join('\n');
}

export async function renderRoomPage(state: HomeGraphRenderState, areaId?: string, sourceReader = createHomeGraphPageSourceReader(), createFactReader?: (subjects: readonly KnowledgeNodeRecord[], sources: readonly KnowledgeSourceRecord[]) => HomeGraphPageFactReader): Promise<string> {
  const scope = roomPageScope(state, areaId);
  if (!createFactReader) throw new GoodVibesError('Home Graph room rendering requires a fact quality reader.', {
    category: 'bad_request', source: 'runtime', operation: 'homegraph.generateRoomPage',
  });
  const factReader = createFactReader(state.nodes.filter((node) => scope.relatedNodeIds.has(node.id)), scope.sourceCandidates);
  const sources = (await sourceReader.rank(scope.sourceCandidates)).map(item => item.source);
  const factPlan = await factReader.prepare(semanticFactsLinkedToSources(sources, state.nodes, state.edges, scope.relatedNodeIds));
  assertHomeGraphPageFactPlan(factPlan);
  const semanticFacts = factPlan.facts.filter((fact) => factPlan.accepts(fact));
  factPlan.assertCurrent();
  return renderRoomBody(state, scope, sources, { title: 'Extracted Facts', nodes: semanticFacts });
}

/**
 * A room page without a decision model: the same structure, its linked sources
 * in stored order and the stored facts about it shown as not checked. Returns
 * the records the page shows, so publication can hold them current.
 */
export function renderUncheckedRoomPage(state: HomeGraphRenderState, areaId?: string): {
  readonly markdown: string; readonly subjects: readonly KnowledgeNodeRecord[]; readonly sources: readonly KnowledgeSourceRecord[]; readonly facts: readonly KnowledgeNodeRecord[];
} {
  const scope = roomPageScope(state, areaId);
  const facts = semanticFactsLinkedToSources(scope.sourceCandidates, state.nodes, state.edges, scope.relatedNodeIds);
  const markdown = renderRoomBody(state, scope, scope.sourceCandidates, { title: 'Stored Facts (not checked)', nodes: facts }, UNCHECKED_PAGE_NOTE);
  return { markdown, subjects: state.nodes.filter((node) => scope.relatedNodeIds.has(node.id)), sources: scope.sourceCandidates, facts };
}

export function renderDevicePassportPage(input: {
  readonly spaceId: string;
  readonly device: KnowledgeNodeRecord;
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly missingFields: readonly string[];
  readonly semanticFacts?: readonly KnowledgeNodeRecord[] | undefined;
  readonly factPlan: HomeGraphPageFactPlan;
}): string {
  assertHomeGraphPageFactPlan(input.factPlan);
  const semanticFacts = (input.semanticFacts ?? input.factPlan.facts).filter((fact) => input.factPlan.accepts(fact));
  return [
    `# ${input.device.title}`,
    '',
    `Knowledge space: \`${input.spaceId}\``,
    '',
    '## Overview',
    '',
    renderDeviceOverview(input.device, input.entities, input.sources),
    '',
    '## Home Assistant Profile',
    '',
    renderMetadataField('Manufacturer', input.device.metadata.manufacturer),
    renderMetadataField('Model', input.device.metadata.model),
    renderMetadataField('Area', readHa(input.device, 'areaId')),
    renderMetadataField('Device id', readHa(input.device, 'deviceId')),
    '',
    renderNodeList('Entities Exposed To Home Assistant', input.entities),
    renderSemanticFacts('Verified Device Facts', semanticFacts),
    renderSourceList('Sources', input.sources),
    renderIssueList('Open Issues', input.issues.filter((issue) => issue.status === 'open')),
    input.missingFields.length > 0
      ? ['## Open Questions', '', ...input.missingFields.map((field) => `- ${field}`), ''].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

/** A device passport without a decision model: the profile, entities, sources as stored and the stored facts shown as not checked. */
export function renderUncheckedDevicePassportPage(input: {
  readonly spaceId: string;
  readonly device: KnowledgeNodeRecord;
  readonly entities: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly missingFields: readonly string[];
  readonly facts: readonly KnowledgeNodeRecord[];
}): string {
  return [
    `# ${input.device.title}`,
    '',
    UNCHECKED_PAGE_NOTE,
    '',
    `Knowledge space: \`${input.spaceId}\``,
    '',
    '## Overview',
    '',
    renderDeviceOverview(input.device, input.entities, input.sources),
    '',
    '## Home Assistant Profile',
    '',
    renderMetadataField('Manufacturer', input.device.metadata.manufacturer),
    renderMetadataField('Model', input.device.metadata.model),
    renderMetadataField('Area', readHa(input.device, 'areaId')),
    renderMetadataField('Device id', readHa(input.device, 'deviceId')),
    '',
    renderNodeList('Entities Exposed To Home Assistant', input.entities),
    renderSemanticFacts('Stored Device Facts (not checked)', input.facts),
    renderSourceList('Sources', input.sources),
    renderIssueList('Open Issues', input.issues.filter((issue) => issue.status === 'open')),
    input.missingFields.length > 0
      ? ['## Open Questions', '', 'Read from the Home Assistant profile and linked sources only.', '', ...input.missingFields.map((field) => `- ${field}`), ''].join('\n')
      : '',
  ].filter(Boolean).join('\n');
}

const PACKET_SECTIONS = ['devices', 'rooms', 'maintenance', 'troubleshooting', 'network', 'sources', 'issues'] as const;
type PacketSection = typeof PACKET_SECTIONS[number];

/**
 * What each sharing profile may ever show. Anything not listed is withheld,
 * and `includeFields` can only narrow a profile, never widen it. The default
 * profile keeps the full packet.
 */
const PACKET_PROFILE_SECTIONS: Readonly<Record<string, readonly PacketSection[]>> = {
  default: PACKET_SECTIONS,
  guest: ['devices', 'rooms'],
  'pet-sitter': ['devices', 'rooms', 'maintenance'],
  emergency: ['devices', 'rooms', 'troubleshooting'],
  contractor: ['devices', 'rooms', 'maintenance', 'troubleshooting'],
  'network-admin': ['devices', 'network', 'troubleshooting'],
};

/** A packet kind that names a sharing profile shows that profile's sections when no profile is given. */
export function sharingProfileForPacket(packetKind: string | undefined, sharingProfile: string | undefined): string {
  if (sharingProfile) return sharingProfile;
  const kind = packetKind?.trim().toLowerCase();
  return kind && kind !== 'default' && Object.hasOwn(PACKET_PROFILE_SECTIONS, kind) ? kind : 'default';
}

const NETWORK_TERMS = /\b(wi-?fi|wlan|ssid|ethernet|lan|ip address|ipv[46]|dhcp|dns|router|gateway|mesh|zigbee|z-?wave|thread|matter|bluetooth|mqtt|port \d+|subnet|vlan|access point|network)\b/i;

/** Facts the home has, by the packet section they belong to: maintenance, troubleshooting (with warnings) and network. */
function packetFacts(state: HomeGraphRenderState): Record<'maintenance' | 'troubleshooting' | 'network', KnowledgeNodeRecord[]> {
  const out = { maintenance: [] as KnowledgeNodeRecord[], troubleshooting: [] as KnowledgeNodeRecord[], network: [] as KnowledgeNodeRecord[] };
  for (const node of state.nodes) {
    if (node.status !== 'active' || (node.kind !== 'fact' && node.metadata.semanticKind !== 'fact')) continue;
    const kind = readString(node.metadata.factKind);
    if (kind === 'maintenance') out.maintenance.push(node);
    else if (kind === 'troubleshooting' || kind === 'warning') out.troubleshooting.push(node);
    const text = [node.title, node.summary, typeof node.metadata.value === 'string' ? node.metadata.value : ''].join(' ');
    if (kind === 'network' || kind === 'connectivity' || ((kind === 'configuration' || kind === 'specification' || kind === 'compatibility') && NETWORK_TERMS.test(text))) out.network.push(node);
  }
  return out;
}

/** The device each fact describes, for grouping a packet section by device. */
function factDevices(state: HomeGraphRenderState): Map<string, string> {
  const devices = new Map(state.nodes.filter((node) => node.kind === 'ha_device').map((node) => [node.id, node.title]));
  const byFact = new Map<string, string>();
  for (const edge of state.edges) {
    if (!edgeIsActive(edge) || edge.relation !== 'describes' || edge.fromKind !== 'node' || edge.toKind !== 'node') continue;
    const title = devices.get(edge.toId);
    if (title && !byFact.has(edge.fromId)) byFact.set(edge.fromId, title);
  }
  for (const node of state.nodes) {
    if (byFact.has(node.id)) continue;
    const id = [...normalizeStringArray(node.metadata.subjectIds), ...normalizeStringArray(node.metadata.linkedObjectIds)].find((candidate) => devices.has(candidate));
    if (id) byFact.set(node.id, devices.get(id)!);
  }
  return byFact;
}

function renderPacketSection(title: string, nodes: readonly KnowledgeNodeRecord[], facts: readonly KnowledgeNodeRecord[],
  devicesByFact: ReadonlyMap<string, string>, empty: string): string {
  if (nodes.length === 0 && facts.length === 0) return [`## ${title}`, '', empty, ''].join('\n');
  const groups = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of dedupePageFacts(facts)) {
    const device = devicesByFact.get(fact.id) ?? 'Whole home';
    groups.set(device, [...(groups.get(device) ?? []), fact]);
  }
  const lines: string[] = [`## ${title}`, ''];
  lines.push(...listWithRemainder(nodes, PAGE_LIST_LIMIT, (node) => `- ${node.title}${node.summary ? ` - ${node.summary}` : ''}`));
  for (const [device, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push('', `### ${device}`, '', ...listWithRemainder(group, PAGE_FACT_GROUP_LIMIT, renderPageFactLine));
  }
  lines.push('');
  return lines.join('\n');
}

function packetFieldNames(label: string, fields: readonly string[] | undefined): Set<PacketSection> {
  const names = new Set<PacketSection>();
  for (const field of fields ?? []) {
    const name = field.trim().toLowerCase() as PacketSection;
    if (!PACKET_SECTIONS.includes(name)) {
      throw new GoodVibesError(`Unknown packet field "${field}" in ${label}; use ${PACKET_SECTIONS.join(', ')}.`, {
        category: 'bad_request', source: 'runtime', operation: 'homegraph.packet', recoverable: true,
      });
    }
    names.add(name);
  }
  return names;
}

export function renderPacketPage(state: HomeGraphRenderState, options: {
  readonly packetKind?: string | undefined;
  readonly sharingProfile?: string | undefined;
  readonly includeFields?: readonly string[] | undefined;
  readonly excludeFields?: readonly string[] | undefined;
} = {}): string {
  const profile = options.sharingProfile ?? 'default';
  const profileSections = Object.hasOwn(PACKET_PROFILE_SECTIONS, profile) ? PACKET_PROFILE_SECTIONS[profile] : undefined;
  if (!profileSections) {
    throw new GoodVibesError(`Unknown sharing profile "${profile}"; use ${Object.keys(PACKET_PROFILE_SECTIONS).join(', ')}.`, {
      category: 'bad_request', source: 'runtime', operation: 'homegraph.packet', recoverable: true,
    });
  }
  const title = state.title;
  const included = packetFieldNames('includeFields', options.includeFields);
  const excluded = packetFieldNames('excludeFields', options.excludeFields);
  const shows = (section: PacketSection): boolean => profileSections.includes(section)
    && (included.size === 0 || included.has(section)) && !excluded.has(section);
  const facts = packetFacts(state);
  const devicesByFact = factDevices(state);
  const allDevices = state.nodes.filter((node) => node.kind === 'ha_device');
  // A guest sees only the devices the owner chose to share with guests.
  const devices = profile === 'guest' ? allDevices.filter((node) => sharedWith(node, 'guest')) : allDevices;
  const section = (name: PacketSection, heading: string, nodes: readonly KnowledgeNodeRecord[], empty: string): string =>
    shows(name) ? (nodes.length > 0 ? renderNodeList(heading, nodes) : [`## ${heading}`, '', empty, ''].join('\n')) : '';
  return [
    `# ${title}`,
    '',
    `Sharing profile: \`${profile}\``,
    `Knowledge space: \`${state.spaceId}\``,
    '',
    section('devices', 'Devices', devices, profile === 'guest'
      ? 'No devices are shared with guests. Review a device with `shareWith: ["guest"]` to include it.'
      : 'No devices recorded.'),
    section('rooms', 'Rooms', state.nodes.filter((node) => node.kind === 'ha_area' || node.kind === 'ha_room'), 'No rooms recorded.'),
    shows('maintenance') ? renderPacketSection('Maintenance', state.nodes.filter((node) => node.kind === 'ha_maintenance_item'),
      facts.maintenance, devicesByFact, 'No maintenance information recorded.') : '',
    shows('troubleshooting') ? renderPacketSection('Troubleshooting', state.nodes.filter((node) => node.kind === 'ha_troubleshooting_case'),
      facts.troubleshooting, devicesByFact, 'No troubleshooting information recorded.') : '',
    shows('network') ? renderPacketSection('Network', state.nodes.filter((node) => node.kind === 'ha_network_node'),
      facts.network, devicesByFact, 'No network information recorded.') : '',
    shows('sources') ? (renderSourceList('Sources', state.sources.filter((source) => !isGeneratedPageSource(source))) || '## Sources\n\nNo sources recorded.\n') : '',
    shows('issues') ? (renderIssueList('Open Issues', state.issues.filter((issue) => issue.status === 'open')) || '## Open Issues\n\nNo open issues.\n') : '',
  ].filter(Boolean).join('\n');
}

function sharedWith(node: KnowledgeNodeRecord, profile: string): boolean {
  const labels = normalizeStringArray(node.metadata.shareWith).map((label) => label.toLowerCase());
  return labels.includes(profile) || labels.includes('all');
}

export function renderHomeGraphMap(state: HomeGraphRenderState, selection: KnowledgeScopeSelection, options: HomeGraphMapInput = {}): HomeGraphMapResult {
  selection.assertCurrent();
  const admittedEdges = new Map(selection.edges.map(edge => [edge.id, edge]));
  const scoped = { ...state, sources: state.sources.filter(selection.source), nodes: state.nodes.filter(selection.node), issues: state.issues.filter(selection.issue),
    edges: state.edges.filter(edge => sameKnowledgeRecord(edge, admittedEdges.get(edge.id))) };
  const filtered = applyHomeGraphMapFilters(scoped, options.ha);
  const result = renderKnowledgeMap(filtered, selection, {
    ...options,
    title: state.title,
    spaceId: state.spaceId,
  });
  selection.assertCurrent();
  return {
    ...result,
    spaceId: state.spaceId,
    facets: {
      recordKinds: result.facets?.recordKinds ?? [],
      nodeKinds: result.facets?.nodeKinds ?? [],
      sourceTypes: result.facets?.sourceTypes ?? [],
      sourceStatuses: result.facets?.sourceStatuses ?? [],
      nodeStatuses: result.facets?.nodeStatuses ?? [],
      issueCodes: result.facets?.issueCodes ?? [],
      issueStatuses: result.facets?.issueStatuses ?? [],
      issueSeverities: result.facets?.issueSeverities ?? [],
      edgeRelations: result.facets?.edgeRelations ?? [],
      tags: result.facets?.tags ?? [],
      homeAssistant: buildHomeAssistantMapFacets(scoped),
    },
  };
}

function applyHomeGraphMapFilters(
  state: HomeGraphRenderState,
  input: HomeGraphMapHaFilterInput | undefined,
): HomeGraphRenderState {
  const filters = normalizeHomeGraphMapFilters(input);
  if (!hasHomeGraphFilters(filters)) return state;
  const matchedNodeIds = new Set(state.nodes
    .filter((node) => matchesHomeGraphNode(node, state.edges, filters, state.nodes))
    .map((node) => node.id));
  const nodeIds = expandHomeGraphMapNodeIds(state.edges, matchedNodeIds);
  const nodes = state.nodes.filter((node) => nodeIds.has(node.id));
  const sourceIds = sourceIdsLinkedToNodes(state.edges, state.nodes, nodeIds);
  const sources = state.sources.filter((source) => sourceIds.has(source.id) || matchesHomeGraphSource(source, filters));
  const sourceSet = new Set(sources.map((source) => source.id));
  const issues = state.issues.filter((issue) => (
    (issue.nodeId && nodeIds.has(issue.nodeId))
    || (issue.sourceId && sourceSet.has(issue.sourceId))
  ));
  const visibleIds = new Set([...nodeIds, ...sourceSet, ...issues.map((issue) => issue.id)]);
  const edges = state.edges.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));
  return { ...state, nodes, sources, issues, edges };
}

function expandHomeGraphMapNodeIds(
  edges: readonly KnowledgeEdgeRecord[],
  matchedNodeIds: ReadonlySet<string>,
): Set<string> {
  const nodeIds = new Set(matchedNodeIds);
  for (const edge of edges) {
    if (!edgeIsActive(edge) || edge.fromKind !== 'node' || edge.toKind !== 'node') continue;
    if (!isContextMapRelation(edge.relation)) continue;
    if (matchedNodeIds.has(edge.fromId)) nodeIds.add(edge.toId);
    if (matchedNodeIds.has(edge.toId)) nodeIds.add(edge.fromId);
  }
  return nodeIds;
}

function isContextMapRelation(relation: string): boolean {
  return relation === 'belongs_to_device'
    || relation === 'located_in'
    || relation === 'connected_via'
    || relation === 'source_for'
    || relation === 'has_manual'
    || relation === 'supports_fact'
    || relation === 'has_gap'
    || relation === REPAIRS_GAP_RELATION;
}

function buildHomeAssistantMapFacets(state: HomeGraphRenderState): Record<string, readonly KnowledgeMapFacetValue[]> {
  return {
    objectKinds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).objectKind ?? node.kind)),
    entityIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).entityId)),
    deviceIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).deviceId)),
    areaIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).areaId)),
    integrationIds: countFacet(state.nodes.map((node) => readHomeAssistantRecord(node).integrationId)),
    integrationDomains: countFacet(state.nodes.map((node) => readIntegrationDomain(node))),
    domains: countFacet(state.nodes.map((node) => readEntityDomain(node))),
    deviceClasses: countFacet(state.nodes.map((node) => readDeviceClass(node))),
    labels: countFacet(state.nodes.flatMap((node) => normalizeStringArray(node.metadata.labels))),
  };
}

function normalizeHomeGraphMapFilters(input: HomeGraphMapHaFilterInput | undefined): Required<HomeGraphMapHaFilterInput> {
  return {
    objectKinds: normalizeStringArray(input?.objectKinds),
    entityIds: normalizeStringArray(input?.entityIds),
    deviceIds: normalizeStringArray(input?.deviceIds),
    areaIds: normalizeStringArray(input?.areaIds),
    integrationIds: normalizeStringArray(input?.integrationIds),
    integrationDomains: normalizeStringArray(input?.integrationDomains),
    domains: normalizeStringArray(input?.domains),
    deviceClasses: normalizeStringArray(input?.deviceClasses),
    labels: normalizeStringArray(input?.labels),
  };
}

function hasHomeGraphFilters(filters: Required<HomeGraphMapHaFilterInput>): boolean {
  return Object.values(filters).some((value) => (value as string[]).length > 0);
}

function matchesHomeGraphNode(
  node: KnowledgeNodeRecord,
  edges: readonly KnowledgeEdgeRecord[],
  filters: Required<HomeGraphMapHaFilterInput>,
  nodes: readonly KnowledgeNodeRecord[],
): boolean {
  const ha = readHomeAssistantRecord(node);
  return matchesFilter(filters.objectKinds!, String(ha.objectKind ?? node.kind), node.kind)
    && matchesFilter(filters.entityIds!, readString(ha.entityId), readString(ha.objectId))
    && matchesFilter(filters.deviceIds!, readString(ha.deviceId), node.kind === 'ha_device' ? readString(ha.objectId) : undefined)
    && matchesAreaFilter(filters.areaIds!, node, edges, nodes)
    && matchesFilter(filters.integrationIds!, readString(ha.integrationId), node.kind === 'ha_integration' ? readString(ha.objectId) : undefined)
    && matchesFilter(filters.integrationDomains!, readIntegrationDomain(node))
    && matchesFilter(filters.domains!, readEntityDomain(node))
    && matchesFilter(filters.deviceClasses!, readDeviceClass(node))
    && matchesAny(filters.labels!, normalizeStringArray(node.metadata.labels));
}

function matchesHomeGraphSource(source: KnowledgeSourceRecord, filters: Required<HomeGraphMapHaFilterInput>): boolean {
  return matchesAny(filters.labels!, [...source.tags, ...normalizeStringArray(source.metadata.labels)]);
}

function matchesAreaFilter(
  areaIds: readonly string[],
  node: KnowledgeNodeRecord,
  edges: readonly KnowledgeEdgeRecord[],
  nodes: readonly KnowledgeNodeRecord[],
): boolean {
  if (areaIds.length === 0) return true;
  const ha = readHomeAssistantRecord(node);
  if (matchesFilter(areaIds, readString(ha.areaId), node.kind === 'ha_area' || node.kind === 'ha_room' ? readString(ha.objectId) : undefined)) {
    return true;
  }
  const targetAreaNodeIds = new Set(nodes
    .filter((candidate) => (candidate.kind === 'ha_area' || candidate.kind === 'ha_room')
      && matchesFilter(areaIds, readString(readHomeAssistantRecord(candidate).objectId), readString(readHomeAssistantRecord(candidate).areaId)))
    .map((candidate) => candidate.id));
  return edges.some((edge) => edgeIsActive(edge)
    && edge.fromId === node.id
    && edge.relation === 'located_in'
    && targetAreaNodeIds.has(edge.toId));
}

function sourceIdsLinkedToNodes(
  edges: readonly KnowledgeEdgeRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  nodeIds: ReadonlySet<string>,
): Set<string> {
  const sourceIds = new Set<string>();
  const factIds = new Set<string>();
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && nodeIds.has(edge.toId)) sourceIds.add(edge.fromId);
    if (edge.fromKind === 'node' && nodeIds.has(edge.fromId) && edge.toKind === 'source') sourceIds.add(edge.toId);
    if (edge.fromKind === 'node' && edge.toKind === 'node' && nodeIds.has(edge.toId) && edge.relation === 'describes') {
      factIds.add(edge.fromId);
    }
  }
  for (const edge of edges) {
    if (!edgeIsActive(edge)) continue;
    if (edge.fromKind === 'source' && edge.toKind === 'node' && factIds.has(edge.toId) && edge.relation === 'supports_fact') {
      sourceIds.add(edge.fromId);
    }
  }
  for (const fact of nodes) {
    if (!factIds.has(fact.id)) continue;
    for (const sourceId of factSourceIds(fact)) sourceIds.add(sourceId);
  }
  return sourceIds;
}

function readHomeAssistantRecord(node: KnowledgeNodeRecord): Record<string, unknown> {
  const value = node.metadata.homeAssistant;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readIntegrationDomain(node: KnowledgeNodeRecord): string | undefined {
  const ha = readHomeAssistantRecord(node);
  return readString(ha.integrationId)
    ?? readString(node.metadata.integrationDomain)
    ?? readString(node.metadata.platform)
    ?? readString(node.metadata.domain);
}

function readEntityDomain(node: KnowledgeNodeRecord): string | undefined {
  const entityId = readString(readHomeAssistantRecord(node).entityId);
  const fromEntity = entityId?.includes('.') ? entityId.split('.')[0] : undefined;
  return fromEntity ?? readString(node.metadata.domain);
}

function readDeviceClass(node: KnowledgeNodeRecord): string | undefined {
  const attributes = node.metadata.attributes && typeof node.metadata.attributes === 'object' && !Array.isArray(node.metadata.attributes)
    ? node.metadata.attributes as Record<string, unknown>
    : {};
  return readString(node.metadata.deviceClass) ?? readString(node.metadata.device_class) ?? readString(attributes.device_class);
}

function matchesFilter(allowed: readonly string[], ...values: readonly (string | undefined)[]): boolean {
  return allowed.length === 0 || values.some((value) => value !== undefined && allowed.includes(value));
}

function matchesAny(allowed: readonly string[], values: readonly string[]): boolean {
  return allowed.length === 0 || values.some((value) => allowed.includes(value));
}

const PAGE_LIST_LIMIT = 100;
const PAGE_FACT_LIMIT = 80;
const PAGE_FACT_GROUP_LIMIT = 24;

/** The first `limit` lines of a list, then a line saying how many more were not shown. */
function listWithRemainder<T>(items: readonly T[], limit: number, line: (item: T) => string): string[] {
  const lines = items.slice(0, limit).map(line).filter(Boolean);
  if (items.length > limit) lines.push(`- (${items.length - limit} more not shown)`);
  return lines;
}

function renderNodeList(title: string, nodes: readonly KnowledgeNodeRecord[]): string {
  if (nodes.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...listWithRemainder(nodes, PAGE_LIST_LIMIT, (node) => `- ${node.title}${node.summary ? ` - ${node.summary}` : ''}`),
    '',
  ].join('\n');
}

function renderRoomOverview(
  title: string,
  devices: readonly KnowledgeNodeRecord[],
  entities: readonly KnowledgeNodeRecord[],
  automations: readonly KnowledgeNodeRecord[],
  scenes: readonly KnowledgeNodeRecord[],
  scripts: readonly KnowledgeNodeRecord[],
): string {
  return [
    '## Overview',
    '',
    `${title} currently has ${devices.length} device(s), ${entities.length} entity record(s), ${automations.length} automation(s), ${scenes.length} scene(s), and ${scripts.length} script(s) in the Home Graph.`,
    '',
  ].join('\n');
}

function renderDeviceOverview(
  device: KnowledgeNodeRecord,
  entities: readonly KnowledgeNodeRecord[],
  sources: readonly KnowledgeSourceRecord[],
): string {
  const identity = uniqueStrings([
    readMetadataString(device, 'manufacturer'),
    readMetadataString(device, 'model'),
    readHa(device, 'areaId') ? `area ${readHa(device, 'areaId')}` : undefined,
  ]);
  const details = identity.length > 0 ? ` ${identity.join(' - ')}.` : '.';
  return `${device.title}${details} The Home Graph links this device to ${entities.length} Home Assistant entity record(s) and ${sources.length} source(s).`;
}

function readMetadataString(node: KnowledgeNodeRecord, key: string): string | undefined {
  const value = node.metadata[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function renderSourceList(title: string, sources: readonly KnowledgeSourceRecord[]): string {
  if (sources.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...listWithRemainder(sources, PAGE_LIST_LIMIT, (source) => {
      const uri = source.sourceUri ?? source.url ?? source.canonicalUri;
      const label = source.title ?? uri ?? source.id;
      return `- ${label}${uri ? ` (${uri})` : ''}`;
    }),
    '',
  ].join('\n');
}

function renderSemanticFacts(title: string, facts: readonly KnowledgeNodeRecord[]): string {
  const all = dedupePageFacts([...facts]
    .sort((left, right) => semanticFactSortKey(left).localeCompare(semanticFactSortKey(right)) || left.title.localeCompare(right.title)));
  const entries = all.slice(0, PAGE_FACT_LIMIT);
  if (entries.length === 0) return '';
  const groups = new Map<string, KnowledgeNodeRecord[]>();
  for (const fact of entries) {
    const kind = readString(fact.metadata.factKind) ?? 'fact';
    groups.set(kind, [...(groups.get(kind) ?? []), fact]);
  }
  return [
    `## ${title}`,
    '',
    ...[...groups.entries()].flatMap(([kind, group]) => [
      `### ${titleCase(kind)}`,
      '',
      ...listWithRemainder(group, PAGE_FACT_GROUP_LIMIT, renderPageFactLine),
      '',
    ]),
    ...(all.length > entries.length ? [`(${all.length - entries.length} more fact(s) not shown)`, ''] : []),
  ].join('\n');
}

function dedupePageFacts(facts: readonly KnowledgeNodeRecord[]): KnowledgeNodeRecord[] {
  const seen = new Set<string>();
  const result: KnowledgeNodeRecord[] = [];
  for (const fact of facts) {
    const key = normalizePageFactText(renderPageFactLine(fact));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(fact);
  }
  return result;
}

function renderPageFactLine(fact: KnowledgeNodeRecord): string {
  const title = cleanPageFactTitle(fact.title);
  if (!title) return '';
  const value = cleanPageFactDetail(typeof fact.metadata.value === 'string' ? fact.metadata.value
    : fact.metadata.value === undefined ? undefined : JSON.stringify(fact.metadata.value));
  const summary = cleanPageFactDetail(fact.summary);
  const canonicalValue = selectPageFactValue(title, value, summary);
  const detail = selectPageFactDetail(title, canonicalValue, summary);
  const line = normalizePageFactLine(`- ${title}${canonicalValue ? `: ${canonicalValue}` : ''}${detail ? ` - ${detail}` : ''}`);
  return line;
}

function selectPageFactValue(
  title: string,
  value: string | undefined,
  summary: string | undefined,
): string | undefined {
  for (const candidate of [value, extractSummaryValue(title, summary)]) {
    if (!candidate) continue;
    if (isRedundantPageFactDetail(title, undefined, candidate)) continue;
    return candidate;
  }
  return undefined;
}

function selectPageFactDetail(
  title: string,
  value: string | undefined,
  summary: string | undefined,
): string | undefined {
  if (!summary) return undefined;
  const normalized = normalizePageFactText(summary);
  if (!normalized) return undefined;
  if (isRedundantPageFactDetail(title, value, summary)) return undefined;
  return summary;
}

function extractSummaryValue(title: string, detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  const titlePattern = escapeRegExp(title.trim()).replace(/\s+/g, '\\s+');
  const match = trimmed.match(new RegExp(`^${titlePattern}\\s*[:\\-]\\s*(.+?)\\.?$`, 'i'));
  return match?.[1] ? match[1].trim() : undefined;
}

function isRedundantPageFactDetail(title: string, value: string | undefined, detail: string): boolean {
  const text = detail.trim();
  return text.length === 0 || text === title.trim() || text === value?.trim()
    || (value !== undefined && (text === `${title}: ${value}` || text === `${title}: ${value}.`));
}

function cleanPageFactDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function cleanPageFactTitle(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = normalizePageFactLine(value.trim());
  if (!trimmed) return undefined;
  return trimmed;
}

function normalizePageFactLine(value: string): string {
  return value.trim();
}

function normalizePageFactText(value: string): string {
  // Formatting comparison only. Signs, punctuation, case, units and qualifiers
  // remain part of the claim; lexical overlap never establishes equivalence.
  return value.trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function semanticFactsLinkedToSources(
  sources: readonly KnowledgeSourceRecord[],
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds?: ReadonlySet<string>,
): KnowledgeNodeRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const describedFactIds = nodeIds ? factIdsDescribingNodes(edges, nodeIds) : undefined;
  const factIds = new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'source'
    && sourceIds.has(edge.fromId)
    && edge.toKind === 'node'
    && edge.relation === 'supports_fact'
  )).map((edge) => edge.toId));
  return nodes.filter((node) => (
    (factIds.has(node.id) || factSourceIds(node).some((sourceId) => sourceIds.has(sourceId)))
    && (!nodeIds || factHasSubjectLink(node, nodeIds, describedFactIds))
    && isHomeGraphPageFactCandidate(node)
  ));
}

function factIdsDescribingNodes(
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(edges.filter((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.toKind === 'node'
    && edge.relation === 'describes'
    && nodeIds.has(edge.toId)
  )).map((edge) => edge.fromId));
}

function factHasSubjectLink(
  fact: KnowledgeNodeRecord,
  nodeIds: ReadonlySet<string>,
  describedFactIds: ReadonlySet<string> | undefined,
): boolean {
  if (describedFactIds?.has(fact.id)) return true;
  return normalizeStringArray(fact.metadata.subjectIds).some((id) => nodeIds.has(id))
    || normalizeStringArray(fact.metadata.linkedObjectIds).some((id) => nodeIds.has(id));
}

function semanticFactSortKey(node: KnowledgeNodeRecord): string {
  const order: Record<string, string> = {
    feature: '01',
    capability: '02',
    specification: '03',
    configuration: '04',
    compatibility: '05',
    procedure: '06',
    maintenance: '07',
    troubleshooting: '08',
    warning: '09',
  };
  return order[readString(node.metadata.factKind) ?? ''] ?? '99';
}

function renderIssueList(title: string, issues: readonly KnowledgeIssueRecord[]): string {
  const entries = issues.filter(isUsefulHomeGraphPageIssue);
  if (entries.length === 0) return '';
  return [
    `## ${title}`,
    '',
    ...listWithRemainder(entries, PAGE_LIST_LIMIT, (issue) => `- ${issue.severity}: ${issue.message}`),
    '',
  ].join('\n');
}

function isUsefulHomeGraphPageIssue(issue: KnowledgeIssueRecord): boolean {
  if (issue.status !== 'open') return false;
  if (issue.code.startsWith('knowledge.')) return false;
  return true;
}

export function issuesForScope(
  issues: readonly KnowledgeIssueRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
  sources: readonly KnowledgeSourceRecord[],
): KnowledgeIssueRecord[] {
  const sourceIds = new Set(sources.map((source) => source.id));
  const scopedNodeIds = expandScopedIssueNodeIds(edges, nodeIds, sourceIds);
  return issues.filter((issue) => (
    issue.status === 'open'
    && (
      (issue.nodeId !== undefined && scopedNodeIds.has(issue.nodeId))
      || (issue.sourceId !== undefined && sourceIds.has(issue.sourceId))
    )
  ));
}

function expandScopedIssueNodeIds(
  edges: readonly KnowledgeEdgeRecord[],
  nodeIds: ReadonlySet<string>,
  sourceIds: ReadonlySet<string>,
): Set<string> {
  const scoped = new Set(nodeIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (!edgeIsActive(edge)) continue;
      if (edge.toKind !== 'node') continue;
      const fromScopedNode = edge.fromKind === 'node' && scoped.has(edge.fromId);
      const fromScopedSource = edge.fromKind === 'source' && sourceIds.has(edge.fromId);
      if ((fromScopedNode || fromScopedSource) && isIssueRelation(edge.relation) && !scoped.has(edge.toId)) {
        scoped.add(edge.toId);
        changed = true;
      }
    }
  }
  return scoped;
}

function isIssueRelation(relation: string): boolean {
  return relation === 'has_gap'
    || relation === 'has_issue'
    || relation === 'source_for'
    || relation === 'supports_fact'
    || relation === 'mentions';
}

function renderMetadataField(label: string, value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? `- ${label}: ${value.trim()}` : '';
}

function filterNodesForArea(
  nodes: readonly KnowledgeNodeRecord[],
  edges: readonly KnowledgeEdgeRecord[],
  kind: string,
  areaNodeId?: string,
): KnowledgeNodeRecord[] {
  return nodes.filter((node) => (
    node.kind === kind
    && (!areaNodeId || hasActiveEdge(edges, node.id, 'located_in', areaNodeId))
  ));
}

function hasActiveEdge(
  edges: readonly KnowledgeEdgeRecord[],
  fromId: string,
  relation: string,
  toId: string,
): boolean {
  return edges.some((edge) => (
    edgeIsActive(edge)
    && edge.fromKind === 'node'
    && edge.fromId === fromId
    && edge.toKind === 'node'
    && edge.toId === toId
    && edge.relation === relation
  ));
}

function findNodeByHaId(nodes: readonly KnowledgeNodeRecord[], kind: string, id: string): KnowledgeNodeRecord | undefined {
  return nodes.find((node) => node.kind === kind && (
    readHa(node, 'objectId') === id
    || readHa(node, 'areaId') === id
    || node.id === id
  ));
}

function readHa(node: KnowledgeNodeRecord, key: string): string | undefined {
  const homeAssistant = node.metadata.homeAssistant;
  if (!homeAssistant || typeof homeAssistant !== 'object' || Array.isArray(homeAssistant)) return undefined;
  const value = (homeAssistant as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}
