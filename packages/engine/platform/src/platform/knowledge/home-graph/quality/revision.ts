/** Opaque quality lifecycles over actual saved history. No source body is
 * copied into issue metadata, and a deleted history is never reconstructed. */
import { isDeepStrictEqual } from 'node:util';
import { opaqueUuid } from '@goodvibes-jev/judgment/decisions';
import type { KnowledgeStore } from '../../store.js';
import type { KnowledgeIssueRecord, KnowledgeNodeRecord, KnowledgeNodeRevisionRecord } from '../../types.js';
import { sameKnowledgeRecord } from '../../store-record-representation.js';
import { readRecord } from '../helpers.js';
import { projectHomeGraphQualityInput, readHomeGraphDeclaredBoolean } from './projection.js';
import { HomeGraphQualityHeldError as Held, type HomeGraphQualityInput } from './types.js';

export const HOME_GRAPH_QUALITY_REVISION_VERSION = 1;
interface Dependency {
  readonly nodeId: string;
  readonly incarnation: string;
  readonly revisionId: string;
  readonly generation: string;
}
interface SubjectState {
  readonly semantic: boolean;
  readonly subject: Dependency;
  readonly entities: readonly Dependency[];
}
interface Capture {
  readonly nodeId: string;
  readonly node: KnowledgeNodeRecord;
  readonly generation: string;
  readonly dependency: Dependency | null;
  assertCurrent(): void;
}
export interface QualityRevisionPlan {
  metadata(): { readonly subjectRevision: string; readonly homeGraphQualityRevisionVersion: number; readonly qualitySubjectState: unknown };
  assertCurrent(): void;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const opaque = (value: unknown): value is string => typeof value === 'string' && value.length === 39 && /^hq-[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}$/.test(value);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function dependency(value: unknown): value is Dependency {
  return object(value) && Object.keys(value).length === 4 && text(value.nodeId) && text(value.incarnation)
    && text(value.revisionId) && typeof value.generation === 'string' && value.generation.length === 35 && /^kr-[0-9a-f]{32}$/.test(value.generation);
}
export function readQualitySubjectState(issue: KnowledgeIssueRecord | undefined): SubjectState | null {
  if (!issue || issue.metadata.homeGraphQualityRevisionVersion === undefined) return null;
  const state = issue.metadata.qualitySubjectState;
  if (issue.metadata.homeGraphQualityRevisionVersion === HOME_GRAPH_QUALITY_REVISION_VERSION && opaque(issue.metadata.subjectRevision) && state === null) return null;
  if (issue.metadata.homeGraphQualityRevisionVersion !== HOME_GRAPH_QUALITY_REVISION_VERSION || !opaque(issue.metadata.subjectRevision)
    || !object(state) || Object.keys(state).length !== 3 || typeof state.semantic !== 'boolean' || !dependency(state.subject)
    || state.subject.nodeId !== issue.nodeId || !Array.isArray(state.entities) || state.entities.some(value => !dependency(value))
    || (!state.semantic && state.entities.length > 0)) throw new Held('malformed');
  const entities: Dependency[] = [];
  for (const value of state.entities) {
    if (!dependency(value) || entities.length && order(entities.at(-1)!.nodeId, value.nodeId) >= 0 || value.nodeId === state.subject.nodeId) throw new Held('malformed');
    entities.push(value);
  }
  return { semantic: state.semantic, subject: state.subject, entities };
}

function capture(store: KnowledgeStore, node: KnowledgeNodeRecord): Capture {
  const snapshot = store.getRecordSnapshot('node', node.id);
  if (!snapshot.record || !snapshot.generation || store.getNode(node.id) !== node || !sameKnowledgeRecord(node, snapshot.record)) throw new Held('stale');
  const history = store.getNodeHistorySnapshot(node.id);
  if ((history.firstId === null) !== (history.latestId === null)) throw new Held('malformed');
  const selected = history.firstId && history.latestId ? {
    nodeId: node.id, incarnation: history.firstId, revisionId: history.latestId, generation: snapshot.generation,
  } : null;
  return { nodeId: node.id, node, generation: snapshot.generation, dependency: selected, assertCurrent() {
    if (store.getNode(node.id) !== node || store.getRecordGeneration('node', node.id) !== snapshot.generation) throw new Held('stale');
  } };
}
function historyNode(row: KnowledgeNodeRevisionRecord): KnowledgeNodeRecord {
  return { id: row.nodeId, kind: row.kind, slug: row.slug, title: row.title, ...(row.summary !== undefined ? { summary: row.summary } : {}),
    aliases: row.aliases, status: row.status, confidence: row.confidence, ...(row.sourceId !== undefined ? { sourceId: row.sourceId } : {}),
    metadata: row.metadata, createdAt: row.nodeCreatedAt, updatedAt: row.nodeUpdatedAt };
}
function previousNode(store: KnowledgeStore, before: Dependency, current: Capture): KnowledgeNodeRecord {
  if (before.generation === current.dependency?.generation) return current.node;
  const selected = store.getNodeHistorySnapshot(before.nodeId, before.revisionId);
  if (selected.firstId !== before.incarnation || !selected.selected || selected.selected.nodeId !== before.nodeId) throw new Held('stale');
  return historyNode(selected.selected);
}
const aliases = (value: unknown): readonly string[] => {
  if (!Array.isArray(value)) throw new Held('malformed');
  const values = new Set<string>();
  for (const entry of value) { if (typeof entry !== 'string') throw new Held('malformed'); values.add(entry); }
  return [...values].sort(order);
};
function meaning(node: KnowledgeNodeRecord, entities: readonly KnowledgeNodeRecord[], code: string, semantic: boolean): unknown {
  const question = code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable';
  const home = readRecord(node.metadata.homeAssistant), attributes = readRecord(node.metadata.attributes);
  const projected = semantic ? projectHomeGraphQualityInput('quality', node, entities, [], [question]) : undefined;
  const normalized = (subject: Readonly<Record<string, unknown>>) => ({ ...subject, aliases: aliases(subject.aliases) });
  return { code, kind: node.kind, title: node.title, manufacturer: node.metadata.manufacturer, model: node.metadata.model,
    objectKind: home.objectKind, objectId: home.objectId, entityId: home.entityId, deviceId: home.deviceId,
    integrationId: home.integrationId, domain: home.domain, deviceClass: attributes.device_class,
    ...(question === 'batteryApplicable' ? { batteryPowered: readHomeGraphDeclaredBoolean(node.metadata.batteryPowered), batteryType: node.metadata.batteryType }
      : { manualRequired: readHomeGraphDeclaredBoolean(node.metadata.manualRequired) }),
    ...(projected ? { semantic: { subject: normalized(projected.subject),
      entities: projected.entities.map(({ reference: _reference, ...entity }) => JSON.stringify(normalized(entity))).sort(order) } } : {}),
  };
}

/** The pass retains its original current rows; history lookups remain closed,
 * indexed and inside the same native read frame as the final issue writer. */
export function createQualityRevisionPlans(store: KnowledgeStore) {
  const captures = new Map<string, Capture>();
  const select = (node: KnowledgeNodeRecord): Capture => {
    const prior = captures.get(node.id);
    if (prior) { if (prior.node !== node) throw new Held('stale'); return prior; }
    const selected = capture(store, node); captures.set(node.id, selected); return selected;
  };
  return {
    prepare(code: string, node: KnowledgeNodeRecord, entities: readonly KnowledgeNodeRecord[], input: HomeGraphQualityInput,
      existing: KnowledgeIssueRecord | undefined): QualityRevisionPlan {
      const semantic = input.questions.includes(code === 'homegraph.device.unknown_battery' ? 'batteryApplicable' : 'manualApplicable');
      if (node.kind !== 'ha_device' || !['homegraph.device.missing_manual','homegraph.device.unknown_battery'].includes(code)) throw new Held('malformed');
      const unique = new Map<string,KnowledgeNodeRecord>();
      if (semantic) for (const entity of entities) {
        if (entity.kind !== 'ha_entity' || unique.has(entity.id) && unique.get(entity.id) !== entity) throw new Held('malformed');
        unique.set(entity.id,entity);
      }
      const subject = select(node), members = [...unique.values()].sort((a,b) => order(a.id,b.id)).map(select);
      const before = readQualitySubjectState(existing);
      let unchanged = false;
      const bound = subject.dependency !== null && members.every(member => member.dependency !== null);
      const state: SubjectState | null = bound ? { semantic, subject: subject.dependency!, entities: members.map(member => member.dependency!) } : null;
      if (before && !state) throw new Held('stale');
      if (before && state && before.semantic === semantic && before.subject.incarnation === state.subject.incarnation
        && before.entities.length === state.entities.length && before.entities.every((member,index) => member.nodeId === state.entities[index]!.nodeId
          && member.incarnation === state.entities[index]!.incarnation)) {
        const sameGenerations = before.subject.generation === state.subject.generation
          && before.entities.every((member,index) => member.generation === state.entities[index]!.generation);
        unchanged = sameGenerations || isDeepStrictEqual(
          meaning(previousNode(store,before.subject,subject),before.entities.map((member,index) => previousNode(store,member,members[index]!)),code,semantic),
          meaning(node,members.map(member => member.node),code,semantic));
      }
      // Rows predating saved history cannot prove a later semantic change.
      // They remain explicitly unbound and receive conservative review treatment.
      const previousRevision = existing?.metadata.subjectRevision;
      let revision = (unchanged || !state) && opaque(previousRevision) ? previousRevision : undefined;
      const assertCurrent = () => { subject.assertCurrent(); for (const member of members) member.assertCurrent(); };
      return { assertCurrent, metadata() {
        assertCurrent(); revision ??= `hq-${opaqueUuid()}`;
        return { subjectRevision: revision, homeGraphQualityRevisionVersion: HOME_GRAPH_QUALITY_REVISION_VERSION, qualitySubjectState: state };
      } };
    },
    assertCurrent() {
      if (captures.size === 0) return;
      // One closed native read-set checks these same original rows together.
      // It retains physical pre/post fences without repeating every native
      // execution dependency probe for each row in the global quality guard.
      store.assertRecordSnapshotFrame(() => {
        const selected = [...captures.values()];
        const generations = store.getRecordGenerations(selected.map(item => ({ kind: 'node' as const, id: item.nodeId })));
        for (const [index, item] of selected.entries()) {
          if (item.node.id !== item.nodeId || store.getNode(item.nodeId) !== item.node || generations[index] !== item.generation) throw new Held('stale');
        }
        return undefined;
      });
    },
  };
}
