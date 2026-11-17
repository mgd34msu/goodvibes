import { readExactSemanticIds, readExactSemanticId } from '../store-semantic-fact-selector.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { createRepairSubjectSelectionReader } from './repair-subject-selection/reader.js';
import { repairProfileSubject } from './repair-profile.js';
import { getKnowledgeSpaceId, isHomeAssistantKnowledgeSpace, normalizeKnowledgeSpaceId } from '../spaces.js';
import { KnowledgeGeneratedFactSupportHeldError } from './verification/types.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';
import type { KnowledgeSemanticFactInput } from './types.js';
import type { SemanticPrimarySourcePlanner, SemanticWriteGuard } from './primary-source-plan.js';
import { prepareGeneratedFactIdentity } from '../generated-fact-record-references.js';
import { createSemanticFactIdentityPlanner } from './identity-plan.js';
import { exactKnowledgeIds, type GeneratedFactWritePlanner } from './fact-support-write-plan.js';

export async function prepareEnrichmentFactDrafts(input: {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly store: KnowledgeStore;
  readonly spaceId: string;
  readonly source: KnowledgeSourceRecord;
  readonly extraction: KnowledgeExtractionRecord | null;
  readonly allFacts: readonly KnowledgeSemanticFactInput[];
  readonly persistedFacts: readonly KnowledgeSemanticFactInput[];
  readonly sourceSubjects: readonly KnowledgeNodeRecord[];
  readonly proposedEntities: readonly KnowledgeNodeRecord[];
  readonly guard: SemanticWriteGuard;
  readonly primary: SemanticPrimarySourcePlanner;
  readonly support: GeneratedFactWritePlanner;
}) {
  const { spaceId, source, extraction, guard, primary, support } = input;
  const factIdentities = createSemanticFactIdentityPlanner(input.store);
  const virtualSources = new Map<string, readonly string[]>();
  const originalExtractions = new Map([[source.id, extraction]]);
  const proposedIds = new Set(input.proposedEntities.map((subject) => subject.id));
  // A fact that is not persisted can still appear in generated wiki text; a
  // persisted fact's own support entry below covers that use as well.
  const persisted = new Set(input.persistedFacts);
  for (const [index, fact] of input.allFacts.entries()) if (!persisted.has(fact)) support.add(spaceId, {
    ...factClaim(`wiki-fact-${index}`, fact),
  }, [source.id], [], originalExtractions);
  const nodes = [...new Map([...input.sourceSubjects, ...input.proposedEntities].map(node => [node.id, node])).values()];
  const candidates = nodes.map((node, index) => ({ ...repairProfileSubject(node), kind: node.kind,
    aliases: node.aliases, identity: repairProfileSubject(node).identity ?? {}, reference: `subject-${index + 1}` }));
  // Subjects come from the links the source already has: one candidate, or the
  // one candidate a fact names, needs no reading. Only a fact that leaves more
  // than one candidate open is read, one reading per remaining pair.
  const decided = input.persistedFacts.map((fact) => subjectsFromLinks(fact, nodes));
  const pairs = input.persistedFacts.flatMap((fact, factIndex) => decided[factIndex] ? [] : candidates.map((candidate, candidateIndex) => ({ factIndex, candidateIndex, fact, candidate })));
  const states = pairs.map(({ fact, candidate }, index) => ({
    reference: `subject-${index + 1}`, candidate: candidate.reference, candidates, objectProfiles: [],
    query: JSON.stringify({ title: fact.title, summary: fact.summary, value: fact.value,
      evidence: fact.evidence, labels: fact.labels, targetHints: fact.targetHints }),
  }));
  assertJudgmentInput(states);
  const current = () => { input.assertCurrent?.(); };
  const reader = createRepairSubjectSelectionReader({ signal: input.signal, assertCurrent: current });
  guard.assertCurrent();
  const readings = states.length ? await reader.read(states) : [];
  guard.assertCurrent(); if (states.length) reader.assertCurrent();
  const readSubjects = new Map<number, Set<number>>();
  pairs.forEach((pair, index) => {
    if (!readings[index]?.selected) return;
    const chosen = readSubjects.get(pair.factIndex) ?? new Set<number>();
    chosen.add(pair.candidateIndex); readSubjects.set(pair.factIndex, chosen);
  });
  const drafts = [];
  for (const [index, fact] of input.persistedFacts.entries()) {
    guard.assertCurrent();
    const selectedIds = new Set([...(decided[index] ?? readSubjects.get(index) ?? [])].map((candidateIndex) => nodes[candidateIndex]!.id));
    const factLinkedObjects = input.sourceSubjects.filter(subject => selectedIds.has(subject.id));
    const entitySubjects = input.proposedEntities.filter(subject => selectedIds.has(subject.id));
    const sourceLinkedObjectIds = factLinkedObjects.map((node) => node.id);
    const sourceTargetHints = factLinkedObjects.map((node) => ({ id: node.id, kind: node.kind, title: node.title }));
    const targetHints = fact.targetHints?.length ? fact.targetHints : sourceTargetHints;
    const factIdentity = prepareGeneratedFactIdentity(input.store, { spaceId, kind: fact.kind, title: fact.title,
      value: fact.value, summary: fact.summary ?? fact.value ?? fact.evidence, subjectIds: sourceLinkedObjectIds, fallbackScope: source.id }, factIdentities);
    const factId = factIdentity.id;
    const existingFact = guard.node(factId);
    const sourceIds = exactKnowledgeIds([
      ...(virtualSources.get(factId) ?? readExactSemanticIds(existingFact?.metadata.sourceIds)),
      readExactSemanticId(existingFact?.metadata.sourceId), existingFact?.sourceId, source.id,
    ]);
    virtualSources.set(factId, sourceIds);
    const subjects = [...new Map([...factLinkedObjects, ...entitySubjects].map((subject) => [subject.id, subject])).values()];
    const supportKey = support.add(spaceId, { ...factClaim(factId, fact),
      subject: factLinkedObjects[0]?.title, targetHints,
    }, sourceIds, subjects, originalExtractions, proposedIds, { claimId: factId, subjectIds: new Set(entitySubjects.map((subject) => subject.id)) });
    const resolve = primary.prepare(spaceId, { kind: fact.kind, title: fact.title, summary: fact.summary,
      value: fact.value, evidence: fact.evidence, subjects: factLinkedObjects.map(({ id, title, kind }) => ({ id, title, kind })),
      targetHints: fact.targetHints,
    }, sourceIds);
    drafts.push({ fact, factId, factIdentity, existingFact, factLinkedObjects, sourceLinkedObjectIds, targetHints, sourceIds,
      supportKey, resolve, entitySubjectIds: new Set(entitySubjects.map((subject) => subject.id)) });
  }
  if (states.length) guard.watch('enrichment-fact-subject-readings', () => { reader.assertCurrent(); return true; });
  guard.watch('enrichment-fact-identities', () => { factIdentities.assertCurrent(); return true; });
  return drafts;
}

function subjectName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The subjects a fact is about when the source's links already say it: none
 * or one candidate, or exactly one candidate whose title or alias the fact
 * names in its target hints. `undefined` leaves the choice to a reading.
 */
function subjectsFromLinks(fact: KnowledgeSemanticFactInput, nodes: readonly KnowledgeNodeRecord[]): ReadonlySet<number> | undefined {
  if (nodes.length === 0) return new Set();
  if (nodes.length === 1) return new Set([0]);
  const hints = new Set((fact.targetHints ?? []).map(subjectName).filter(Boolean));
  if (hints.size === 0) return undefined;
  const named = nodes.flatMap((node, index) => [node.title, ...node.aliases].some((name) => hints.has(subjectName(name))) ? [index] : []);
  return named.length === 1 ? new Set(named) : undefined;
}
function factClaim(id: string, fact: KnowledgeSemanticFactInput) {
  return { id, kind: fact.kind, title: fact.title, summary: fact.summary ?? fact.value ?? fact.evidence,
    value: fact.value, evidence: fact.evidence, labels: fact.labels, aliases: fact.labels };
}
/** A namespace alias filters concrete spaces; it never relabels source content. */
export function resolveEnrichmentSpaceId(source: KnowledgeSourceRecord, requested?: string): string {
  const actual = getKnowledgeSpaceId(source);
  if (requested === undefined) return actual;
  if (typeof requested !== 'string') throw new KnowledgeGeneratedFactSupportHeldError('malformed');
  const normalized = normalizeKnowledgeSpaceId(requested);
  if (normalized !== actual && !(normalized === 'homeassistant' && isHomeAssistantKnowledgeSpace(actual))) {
    throw new KnowledgeGeneratedFactSupportHeldError('foreign-space');
  }
  return actual;
}
