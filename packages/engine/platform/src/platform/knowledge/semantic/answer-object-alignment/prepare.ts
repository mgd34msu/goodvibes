import { toJson, type JsonValue } from '@goodvibes/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import type { KnowledgeObjectProfilePolicy } from '../../extensions.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from '../../home-graph/extension.js';
import { knowledgeTerms } from '../../passages.js';
import { isActiveKnowledgeEdge } from '../../projection-utils.js';
import { getExplicitKnowledgeSpaceId, getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace } from '../../spaces.js';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeEdgeRecord, KnowledgeNodeRecord, KnowledgeReferenceKind, KnowledgeSourceRecord } from '../../types.js';
import type { EvidenceItem } from '../answer-common.js';
import { freezeSupport } from '../verification/projection.js';
import type { KnowledgeSemanticAnswerInput } from '../types.js';
import { readRecord, readString, readStringArray, uniqueStrings } from '../utils.js';
import { readAnswerObjectAlignment, snapshotAnswerObjectInput } from './reader.js';
import { ANSWER_OBJECT_LIMITS as LIMITS, KnowledgeAnswerObjectAlignmentHeldError as Held, type AnswerObjectCandidate } from './types.js';

// Exact schemas, not guesses based on kind substrings or a product-name shape.
const CORE_OBJECT_KINDS = new Set(['knowledge_entity', 'device', 'product', 'appliance', 'controller', 'service', 'provider', 'platform', 'tool', 'capability']);
const NON_OBJECT_KINDS = new Set(['fact', 'wiki_page', 'knowledge_gap', 'ha_device_passport']);
const CONTENT_KEYS = ['entityKind', 'value', 'evidence', 'labels', 'subject', 'markdown', 'text', 'searchText',
  'manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'domain', 'platform',
  'batteryPowered', 'batteryType', 'manualRequired', 'serial', 'firmware', 'installDate', 'purchaseDate', 'warrantyExpiration',
  'documentation', 'documentationUrl', 'documentation_url', 'sourceUrl', 'source_url', 'deviceClass', 'device_class',
  'entryType', 'entry_type', 'attributes', 'homeAssistant'];
function belongs(value: { readonly metadata?: Record<string, unknown> }, spaceId: string): boolean {
  const actual = getExplicitKnowledgeSpaceId(value);
  return typeof actual === 'string' && (actual === spaceId || (spaceId === 'homeassistant' && isHomeAssistantKnowledgeSpace(actual)));
}
function eligible(node: KnowledgeNodeRecord, kinds: ReadonlySet<string>): boolean {
  return node.status === 'active' && kinds.has(node.kind) && !NON_OBJECT_KINDS.has(node.kind)
    && !node.metadata.semanticKind && node.metadata.generatedKnowledgePage !== true && node.metadata.generatedProjection !== true;
}
function identity(node: KnowledgeNodeRecord) {
  return { kind: node.kind, title: node.title, summary: node.summary, aliases: node.aliases,
    ...Object.fromEntries(['manufacturer', 'brand', 'vendor', 'model', 'modelNumber', 'variant', 'entityKind', 'subject', 'homeAssistant']
      .filter((key) => node.metadata[key] !== undefined).map((key) => [key, node.metadata[key]])) };
}
/** Long text values are cut: a candidate is read for what it is, not for its whole body. */
function bounded(value: unknown): unknown {
  if (typeof value === 'string') return value.length > LIMITS.contentChars ? `${value.slice(0, LIMITS.contentChars)}…` : value;
  if (Array.isArray(value)) return value.slice(0, LIMITS.associations).map(bounded);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bounded(entry)]));
  return value;
}
function content(node: KnowledgeNodeRecord, nodesById: ReadonlyMap<string, KnowledgeNodeRecord>, references: ReadonlyMap<string, string>): Readonly<Record<string, JsonValue>> {
  const selected: Record<string, unknown> = Object.fromEntries(CONTENT_KEYS.filter((key) => node.metadata[key] !== undefined).map((key) => [key, bounded(node.metadata[key])]));
  for (const key of ['subject', 'targetHints'] as const) if (node[key] !== undefined) selected[`record${key}`] = bounded(node[key]);
  const local = (id: string | undefined) => {
    const target = id ? nodesById.get(id) : undefined;
    return target && target.status === 'active' && getKnowledgeSpaceId(target) === getKnowledgeSpaceId(node) ? target : undefined;
  };
  const projectHint = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const hint = readRecord(value), target = local(readString(hint.id));
    // Only an actual local row proves this particular reference is bookkeeping.
    if (!target) return hint;
    const { id: _id, ...meaning } = hint;
    return { ...meaning, reference: references.get(target.id), target: identity(target) };
  };
  for (const [key, value] of [['targetHints', node.metadata.targetHints], ['recordtargetHints', node.targetHints]] as const) {
    if (value !== undefined) selected[key] = Array.isArray(value) ? value.slice(0, LIMITS.associations).map(projectHint) : value;
  }
  const ids = uniqueStrings([readString(node.metadata.subjectId), ...readStringArray(node.metadata.subjectIds),
    ...readStringArray(node.metadata.linkedObjectIds), ...(node.subjectIds ?? []), ...(node.linkedObjectIds ?? [])]).slice(0, LIMITS.associations);
  if (ids.length) selected.subjects = ids.map((id) => {
    const target = local(id);
    return target ? { reference: references.get(id), ...identity(target) } : { externalReference: id };
  });
  // Scan structured values before toJson can omit, stringify or truncate them.
  assertJudgmentInput(selected);
  const projected = toJson(selected);
  if (!projected || typeof projected !== 'object' || Array.isArray(projected)) throw new Held('malformed');
  return projected;
}

export interface AnswerObjectProvenance {
  readonly nodeId: string;
  readonly callerContext: boolean;
  readonly evidence: readonly { readonly kind: 'source' | 'node'; readonly id: string }[];
  readonly factIds: readonly string[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}

/** The records of a space one answer reads, once. A caller holding a snapshot passes it in. */
export interface AnswerObjectRecords {
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
}

export interface AnswerLinkedObjectsResult {
  readonly linkedObjects: readonly KnowledgeNodeRecord[];
  readonly provenance: readonly AnswerObjectProvenance[];
  /** Objects whose reading did not settle: left out, not fatal. */
  readonly unsettled: number;
  /** Eligible objects of the space and how many of them were read. */
  readonly candidates: { readonly total: number; readonly considered: number };
}

/**
 * Which objects of the space a question is about. The space is read once (or
 * taken from the caller's snapshot); code shortlists at most
 * `ANSWER_OBJECT_LIMITS.candidates` objects: those the caller names, those
 * whose title or alias the question uses, those linked to the answer's
 * evidence and facts, then by words shared with the question. Only the
 * shortlist is read, each object in its own request with only its own content
 * (and the other shortlisted names). linkedObjects are context candidates,
 * never explicit selected targets or an operator-authorization channel.
 */
export function prepareAnswerLinkedObjects(store: KnowledgeStore, spaceId: string, input: KnowledgeSemanticAnswerInput,
  objectProfiles: readonly KnowledgeObjectProfilePolicy[], signal?: AbortSignal, records?: AnswerObjectRecords) {
  const assertCurrent = () => { if (signal?.aborted) throw new Held('aborted'); };
  // The standalone semantic service has always supported the built-in HA
  // namespace without constructing a HomeGraphService. Use its exact extension
  // declaration here, never its object-scope or repair-subject preferences.
  const builtins = spaceId === 'homeassistant' || isHomeAssistantKnowledgeSpace(spaceId) ? HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [] : [];
  const kinds = new Set([...CORE_OBJECT_KINDS, ...[...objectProfiles, ...builtins].flatMap((profile) => profile.subjectKinds)]);
  const nodes = records ? records.nodes.filter((node) => belongs(node, spaceId)) : store.listNodes(Number.MAX_SAFE_INTEGER).filter((node) => belongs(node, spaceId));
  const sources = records ? records.sources.filter((source) => belongs(source, spaceId)) : store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => belongs(source, spaceId));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  // One edge index per request: active in-space edges by each endpoint.
  const edgesByEndpoint = new Map<string, KnowledgeEdgeRecord[]>();
  for (const edge of records?.edges ?? store.listEdges()) {
    if (!isActiveKnowledgeEdge(edge)) continue;
    const from = edge.fromKind === 'node' ? nodesById.get(edge.fromId) : sourcesById.get(edge.fromId);
    const to = edge.toKind === 'node' ? nodesById.get(edge.toId) : sourcesById.get(edge.toId);
    if (!from || !to || getKnowledgeSpaceId(from) !== getKnowledgeSpaceId(to) || getKnowledgeSpaceId(edge) !== getKnowledgeSpaceId(from)) continue;
    for (const key of [`${edge.fromKind}:${edge.fromId}`, `${edge.toKind}:${edge.toId}`]) {
      const list = edgesByEndpoint.get(key);
      if (list) list.push(edge); else edgesByEndpoint.set(key, [edge]);
    }
  }
  const candidateEdges = (node: KnowledgeNodeRecord) => edgesByEndpoint.get(`node:${node.id}`) ?? [];
  const objects = nodes.filter((node) => eligible(node, kinds));
  const callerIds = new Set((input.linkedObjects ?? []).filter((node) => belongs(node, spaceId) && nodesById.has(node.id) && eligible(nodesById.get(node.id)!, kinds)).map((node) => node.id));
  const query = input.query.toLowerCase();
  const terms = knowledgeTerms([input.query]);
  const named = (node: KnowledgeNodeRecord) => [node.title, ...node.aliases].some((name) => {
    const value = name.trim().toLowerCase();
    return value.length >= 2 && query.includes(value);
  });
  const overlap = (node: KnowledgeNodeRecord) => {
    const words = new Set(knowledgeTerms([node.title, node.aliases, node.summary, node.metadata.manufacturer, node.metadata.model]));
    let total = 0;
    for (const term of terms) if (words.has(term)) total += term.length >= 5 || /\d/.test(term) ? 2 : 1;
    return total;
  };
  let result: Promise<AnswerLinkedObjectsResult> | undefined;
  return {
    assertCurrent,
    read(evidence: readonly EvidenceItem[], facts: readonly KnowledgeNodeRecord[]): Promise<AnswerLinkedObjectsResult> {
      assertCurrent();
      if (result) return result;
      const factIdsFor = (node: KnowledgeNodeRecord) => facts.filter((fact) => getKnowledgeSpaceId(fact) === getKnowledgeSpaceId(node)
        && ([...(fact.subjectIds ?? []), ...(fact.linkedObjectIds ?? []),
          ...readStringArray(fact.metadata.subjectIds), ...readStringArray(fact.metadata.linkedObjectIds)].includes(node.id)
          || candidateEdges(node).some((edge) => edge.fromKind === 'node' && edge.fromId === fact.id && edge.relation === 'describes'))).map((fact) => fact.id);
      const evidenceFor = (node: KnowledgeNodeRecord) => evidence.filter((item) => getKnowledgeSpaceId(item.node ?? item.source) === getKnowledgeSpaceId(node)
        && (item.node?.id === node.id
          || (item.source && readStringArray(readRecord(item.source.metadata.sourceDiscovery).linkedObjectIds).includes(node.id))
          || candidateEdges(node).some((edge) => (edge.fromKind === item.kind && edge.fromId === item.id)
            || (edge.toKind === item.kind && edge.toId === item.id)))).map((item) => ({ kind: item.kind, id: item.id }));
      const provenanceFor = (node: KnowledgeNodeRecord): AnswerObjectProvenance => freezeSupport({ nodeId: node.id, callerContext: callerIds.has(node.id),
        evidence: evidenceFor(node), factIds: factIdsFor(node), edges: candidateEdges(node) });
      // Shortlist in code; only the shortlist reaches the model.
      const ranked = objects.map((node, order) => {
        const provenance = provenanceFor(node);
        const score = (callerIds.has(node.id) ? 1_000 : 0) + (named(node) ? 100 : 0)
          + 10 * (provenance.evidence.length + provenance.factIds.length) + overlap(node);
        return { node, order, provenance, score };
      }).filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.order - right.order)
        .slice(0, LIMITS.candidates);
      if (ranked.length === 0) return result = Promise.resolve(freezeSupport({ linkedObjects: [], provenance: [], unsettled: 0,
        candidates: { total: objects.length, considered: 0 } }));
      const references = new Map<string, string>();
      ranked.forEach((entry, index) => references.set(entry.node.id, `object-${index + 1}`));
      let context = 0;
      const contextReference = (kind: KnowledgeReferenceKind, id: string) => {
        if (kind === 'node' && references.has(id)) return references.get(id);
        const key = `${kind}:${id}`;
        if (!references.has(key)) references.set(key, `context-${++context}`);
        return references.get(key);
      };
      const projected: AnswerObjectCandidate[] = ranked.map(({ node, provenance }) => ({
        reference: references.get(node.id)!, kind: node.kind, title: node.title, summary: node.summary, aliases: node.aliases,
        content: content(node, nodesById, references),
        associations: [
          ...(callerIds.has(node.id) ? [{ origin: 'caller-context' as const }] : []),
          ...provenance.edges.slice(0, LIMITS.associations).map((edge) => {
            const from = edge.fromKind === 'node' && edge.fromId === node.id;
            return { origin: 'graph' as const, reference: contextReference(from ? edge.toKind : edge.fromKind, from ? edge.toId : edge.fromId), relation: edge.relation };
          }),
          ...provenance.evidence.slice(0, LIMITS.associations).map(({ kind, id }) => ({ origin: 'evidence' as const, reference: contextReference(kind, id) })),
          ...provenance.factIds.slice(0, LIMITS.associations).map((id) => ({ origin: 'fact' as const, reference: contextReference('node', id) })),
        ].slice(0, LIMITS.associations),
      }));
      const snapshot = snapshotAnswerObjectInput({ query: input.query, candidates: projected });
      const byReference = new Map(ranked.map((entry) => [references.get(entry.node.id)!, entry]));
      result = readAnswerObjectAlignment(snapshot, { signal, assertCurrent }).then((plan) => {
        assertCurrent();
        const accepted = plan.accepted.map((reading) => byReference.get(reading.reference)!);
        return freezeSupport({ linkedObjects: accepted.map((entry) => entry.node), provenance: accepted.map((entry) => entry.provenance),
          unsettled: plan.unsettled, candidates: { total: objects.length, considered: ranked.length } });
      });
      return result;
    },
  };
}
export type PreparedAnswerLinkedObjects = ReturnType<typeof prepareAnswerLinkedObjects>;
