import type { AgentWorkspaceLocalLibraryItem } from './local-library-items.js';
import type { LearningCandidateDraft, LearningConsolidationDiff, LearningConsolidationPlan, LocalLearningCandidateDomain } from './learning-curator-types.js';
import { isReviewed, localRegistryRoute, routeValue } from './learning-curator-common.js';
import type { LearningRecord } from './learning-curator-source.js';
import { logger } from '@goodvibes/engine/platform/platform/utils';

function uniqueText(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function mergeableDescription(domain: LocalLearningCandidateDomain, item: AgentWorkspaceLocalLibraryItem): string {
  if (domain === 'memory') {
    const fallback = item.scope && item.cls ? `${item.scope}/${item.cls}` : '';
    return item.description === fallback ? '' : item.description;
  }
  return item.description;
}

function consolidationDiff(
  field: string,
  survivor: string,
  duplicateValues: readonly string[],
  merged: string,
): LearningConsolidationDiff | null {
  const duplicates = uniqueText(duplicateValues);
  if (duplicates.length === 0 && !merged) return null;
  const normalizedSurvivor = survivor.trim().toLowerCase();
  const differs = duplicates.some((value) => value.trim().toLowerCase() !== normalizedSurvivor)
    || merged.trim().toLowerCase() !== normalizedSurvivor;
  if (!differs) return null;
  return {
    field,
    survivor: survivor || '(empty)',
    duplicates,
    merged: merged || '(empty)',
  };
}

function consolidationDiffs(
  domain: LocalLearningCandidateDomain,
  survivor: AgentWorkspaceLocalLibraryItem,
  duplicates: readonly AgentWorkspaceLocalLibraryItem[],
): readonly LearningConsolidationDiff[] {
  const tags = survivor.tags.join(', ');
  const triggers = survivor.triggers.join(', ');
  return [
    consolidationDiff('name', survivor.name, duplicates.map((item) => item.name), survivor.name),
    consolidationDiff('description', mergeableDescription(domain, survivor), duplicates.map((item) => mergeableDescription(domain, item)), mergeableDescription(domain, survivor)),
    consolidationDiff('tags', survivor.tags.join(', '), duplicates.map((item) => item.tags.join(', ')), tags),
    domain === 'memory' ? null : consolidationDiff('triggers', survivor.triggers.join(', '), duplicates.map((item) => item.triggers.join(', ')), triggers),
  ].filter((diff): diff is LearningConsolidationDiff => diff !== null);
}

function consolidationProposalFields(plan: LearningConsolidationPlan): Readonly<Record<string, string>> {
  return {
    survivorId: plan.survivorId,
    duplicateIds: plan.duplicateIds.join(','),
    visibleDiff: plan.diffs.length > 0
      ? plan.diffs.map((diff) => `${diff.field}: retain [${diff.survivor}]; duplicates [${diff.duplicates.join("; ")}]`).join('\n')
      : 'Visible metadata matches; inspect record bodies before marking duplicates stale.',
    staleFirst: plan.staleRoutes.join('\n'),
    rollback: plan.rollbackRoutes.join('\n'),
  };
}

/** What made a group: settled same-entity readings, or identical content compared by code (no decision model in use). */
export type ConsolidationBasis = 'readings' | 'identical';

function consolidationCandidate(
  domain: LocalLearningCandidateDomain,
  key: string,
  items: readonly AgentWorkspaceLocalLibraryItem[],
  survivor: AgentWorkspaceLocalLibraryItem,
  basis: ConsolidationBasis,
): LearningCandidateDraft | null {
  if (items.length < 2) return null;
  const duplicates = items.filter((item) => item.id !== survivor.id);
  if (duplicates.length === 0) return null;
  const staleRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'stale', item.id)} reason:"Duplicate of ${routeValue(survivor.id)}; staged by learning curator consolidation."`);
  const deleteRoutes = duplicates.map((item) => `${localRegistryRoute(domain, 'delete', item.id)}`);
  // Same-entity evidence cannot authorize synthesized descriptions or new triggers, so the survivor is never rewritten;
  // the only change is staging the duplicates as stale, and rollback is reviewing them again.
  const rollbackRoutes = [
    ...duplicates.map((item) => localRegistryRoute(domain, 'review', item.id)),
  ];
  const diffs = consolidationDiffs(domain, survivor, duplicates);
  const plan: LearningConsolidationPlan = {
    survivorId: survivor.id,
    duplicateIds: duplicates.map((item) => item.id),
    sharedKey: key,
    ...(duplicates.some(item => item.reviewState === 'stale')
      ? { staleDuplicateIds: duplicates.filter(item => item.reviewState === 'stale').map(item => item.id) } : {}),
    diffs,
    staleRoutes,
    deleteRoutes,
    rollbackRoutes,
  };
  return {
    id: `consolidation:${domain}:${encodeURIComponent(key)}`,
    label: `Consolidate duplicate ${domain}: ${survivor.name}`,
    domain,
    recordId: survivor.id,
    status: 'needs-consolidation',
    reason: basis === 'identical'
      ? `${items.length} Agent-local ${domain} records have identical content, compared by code (no decision model is in use, so only exact copies are found).`
      : `${items.length} Agent-local ${domain} records have settled same-entity pair readings.`,
    next: 'Keep the selected record unchanged and mark settled duplicates stale, retaining their complete originals.',
    reviewState: survivor.reviewState,
    ...(survivor.enabled === undefined ? {} : { enabled: survivor.enabled }),
    ...(survivor.active === undefined ? {} : { active: survivor.active }),
    ...(survivor.confidence === undefined ? {} : { confidence: survivor.confidence }),
    proposalFields: consolidationProposalFields(plan),
    consolidation: plan,
    inspectRoute: localRegistryRoute(domain, 'get', survivor.id),
    modelRoute: 'memory action:"curator" query:"consolidation"',
    reviewRoute: localRegistryRoute(domain, 'review', survivor.id),
    ...(staleRoutes[0] ? { staleRoute: staleRoutes[0] } : {}),
    ...(deleteRoutes[0] ? { deleteRoute: deleteRoutes[0] } : {}),
    cleanupRoutes: staleRoutes,
    rollbackRoutes,
  };
}

/** Domains whose duplicates the curator proposes to consolidate. */
export const CONSOLIDATION_DOMAINS: readonly LocalLearningCandidateDomain[] = ['memory', 'persona', 'skill', 'routine'];

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'what', 'about', 'your', 'our', 'are', 'was', 'use', 'using']);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length >= 3 && !STOP_WORDS.has(word)));
}

/**
 * The pairs worth asking about: records of one domain (and, for memory, one
 * class) that share a tag, the same name, or enough of their words. A pair
 * with nothing in common is not sent to a model; this keeps a first pass far
 * below every-pair-against-every-pair.
 */
export function shortlistDuplicatePairs(domain: LocalLearningCandidateDomain, records: readonly LearningRecord[]): readonly (readonly [number, number])[] {
  if (!CONSOLIDATION_DOMAINS.includes(domain) || records.length < 2) return [];
  const facts = records.map(({ item }) => ({
    name: item.name.trim().toLowerCase(),
    cls: item.cls,
    tags: new Set(item.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean)),
    words: words(`${item.name} ${item.description}`),
  }));
  const pairs: (readonly [number, number])[] = [];
  for (let left = 0; left < facts.length; left++) {
    for (let right = left + 1; right < facts.length; right++) {
      const a = facts[left]!, b = facts[right]!;
      if (domain === 'memory' && a.cls && b.cls && a.cls !== b.cls) continue;
      const sharedTag = [...a.tags].some(tag => b.tags.has(tag));
      let shared = 0;
      for (const word of a.words) if (b.words.has(word)) shared++;
      const union = a.words.size + b.words.size - shared;
      if (a.name === b.name || sharedTag || shared >= 2 || (union > 0 && shared / union >= 0.34)) pairs.push([left, right]);
    }
  }
  return pairs;
}

export function duplicatePairKey(domain: LocalLearningCandidateDomain, left: LearningRecord, right: LearningRecord): string {
  const [a, b] = [left.item.id, right.item.id].sort();
  return `${domain}|${a}|${b}`;
}

export function survivorGroupKey(domain: LocalLearningCandidateDomain, group: readonly LearningRecord[]): string {
  return `${domain}|${group.map(record => record.item.id).sort().join('|')}`;
}

/**
 * Groups of records every pair of which was read as the same entity. A group
 * that is not complete proposes nothing: alignment is not assumed transitive.
 */
export function consolidationGroups(records: readonly LearningRecord[], pairs: readonly (readonly [number, number])[],
  same: (left: number, right: number) => boolean): readonly (readonly LearningRecord[])[] {
  const edges = records.map(() => new Set<number>());
  for (const [left, right] of pairs) if (same(left, right)) { edges[left]?.add(right); edges[right]?.add(left); }
  const visited = new Set<number>();
  const groups: LearningRecord[][] = [];
  for (let first = 0; first < records.length; first++) {
    if (visited.has(first)) continue;
    const indexes = [first]; visited.add(first);
    for (let cursor = 0; cursor < indexes.length; cursor++) {
      for (const neighbor of edges[indexes[cursor]!] ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); indexes.push(neighbor); }
    }
    if (indexes.length < 2) continue;
    const complete = indexes.every(left => indexes.every(right => left === right || edges[left]?.has(right) === true));
    if (!complete) {
      logger.warn('Learning duplicate readings are not a complete same-entity group; nothing is proposed for it', { records: indexes.length });
      continue;
    }
    groups.push(indexes.map(index => records[index]!).sort((left, right) => left.item.id.localeCompare(right.item.id)));
  }
  return groups;
}

/**
 * The live records of a group, the ones that may survive. A duplicate already
 * staged stays in the group, so the stale-then-delete flow can still find its
 * candidate, but it is never the survivor.
 */
export function liveGroupMembers(group: readonly LearningRecord[]): readonly LearningRecord[] {
  return group.filter(record => record.item.reviewState !== 'stale');
}

export function consolidationCandidateForGroup(domain: LocalLearningCandidateDomain, group: readonly LearningRecord[], survivorId: string,
  basis: ConsolidationBasis = 'readings'): LearningCandidateDraft | null {
  const survivor = group.find(record => record.item.id === survivorId);
  if (!survivor || survivor.item.reviewState === 'stale') return null;
  const key = JSON.stringify(group.map(record => record.item.id));
  return consolidationCandidate(domain, key, group.map(record => record.item), survivor.item, basis);
}

/** The fields that are a record's content in each consolidation domain; identity, review and timestamps are not. */
const CONTENT_FIELDS: Readonly<Partial<Record<LocalLearningCandidateDomain, readonly string[]>>> = {
  memory: ['summary', 'detail', 'scope', 'cls', 'tags'],
  persona: ['name', 'description', 'body', 'tags', 'triggers'],
  skill: ['name', 'description', 'procedure', 'triggers', 'tags', 'requirements'],
  routine: ['name', 'description', 'steps', 'triggers', 'tags', 'requirements'],
};

/** One content field, compared as written: text trimmed, tag and trigger lists as sets. */
function contentValue(field: string, value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if ((field === 'tags' || field === 'triggers') && Array.isArray(value)) {
    return [...new Set(value.map(entry => typeof entry === 'string' ? entry.trim().toLowerCase() : JSON.stringify(entry)))].sort();
  }
  return value ?? null;
}

/**
 * Whether two records of one domain carry identical content: a fact code
 * decides without a decision model. Records that say the same thing in
 * different words are not found this way; a decision model's pair reading
 * finds those.
 */
export function identicalLearningRecords(domain: LocalLearningCandidateDomain, left: LearningRecord, right: LearningRecord): boolean {
  const fields = CONTENT_FIELDS[domain];
  if (!fields) return false;
  const content = (record: LearningRecord): string => {
    const source = record.record && typeof record.record === 'object' ? record.record as Record<string, unknown> : {};
    return JSON.stringify(fields.map(field => contentValue(field, source[field])));
  };
  return content(left) === content(right);
}

/**
 * The survivor code keeps among identical records: a reviewed one before an
 * unreviewed one, then the first by id. The content is the same, so the
 * choice loses nothing; the others are only marked stale.
 */
export function identicalGroupSurvivor(group: readonly LearningRecord[]): string | undefined {
  const live = liveGroupMembers(group);
  return [...live].sort((left, right) => Number(isReviewed(right.item)) - Number(isReviewed(left.item))
    || left.item.id.localeCompare(right.item.id))[0]?.item.id;
}
