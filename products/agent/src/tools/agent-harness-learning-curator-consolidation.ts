import { requireDecisionFeature } from '@goodvibes-jev/engine/platform/platform/runtime';
import type { AgentWorkspaceLocalLibraryItem } from '../input/agent-workspace-types.ts';
import type { LearningCandidateDraft, LearningConsolidationDiff, LearningConsolidationPlan, LocalLearningCandidateDomain } from './agent-harness-learning-curator-types.ts';
import { localRegistryRoute, routeValue } from './agent-harness-learning-curator-common.ts';
import type { CatalogRankingOptions } from './agent-harness-catalog-ranking.ts';
import type { LearningRecord } from './agent-harness-learning-curator-source.ts';
import { readLearningDuplicatePair, readLearningSurvivor } from './agent-harness-learning-curator-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
const CONSOLIDATION_DOMAINS: readonly LocalLearningCandidateDomain[] = ['memory', 'persona', 'skill', 'routine'];

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

function consolidationCandidate(
  domain: LocalLearningCandidateDomain,
  key: string,
  items: readonly AgentWorkspaceLocalLibraryItem[],
  survivor: AgentWorkspaceLocalLibraryItem,
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
    reason: `${items.length} Agent-local ${domain} records have settled same-entity pair readings.`,
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

export async function consolidationCandidatesForDomain(
  domain: LocalLearningCandidateDomain,
  records: readonly LearningRecord[],
  options: CatalogRankingOptions,
  context?: unknown,
): Promise<readonly LearningCandidateDraft[]> {
  requireDecisionFeature('automatic duplicate consolidation; inspect the records and use explicit owner edits instead');
  if (!CONSOLIDATION_DOMAINS.includes(domain) || records.length < 2) return [];
  options.signal?.throwIfAborted(); options.assertCurrent?.();
  const edges = records.map(() => new Set<number>());
  // Every same-domain pair is read. Name normalization cannot shortlist durable records.
  for (let left = 0; left < records.length; left++) {
    for (let right = left + 1; right < records.length; right++) {
      const a = records[left], b = records[right];
      if (!a || !b) throw new ToolInputProjectionError('held');
      let same = false;
      try { same = await readLearningDuplicatePair({ left: { domain, ...a }, right: { domain, ...b } }, options); }
      catch (error) {
        // An unsettled pair is "not shown to be the same": it proposes nothing, and must not stop the other domains from being read.
        // A lost authority or abort still surfaces through the checks right below.
        if (!(error instanceof ToolInputProjectionError) || error.problem !== 'held') throw error;
        options.signal?.throwIfAborted(); options.assertCurrent?.();
        logger.warn('Learning duplicate pair reading was not settled; the pair is treated as distinct', { domain, left: a.item.id, right: b.item.id });
      }
      options.signal?.throwIfAborted(); options.assertCurrent?.();
      if (same) { edges[left]?.add(right); edges[right]?.add(left); }
    }
  }
  const visited = new Set<number>();
  const result: LearningCandidateDraft[] = [];
  for (let first = 0; first < records.length; first++) {
    if (visited.has(first)) continue;
    const indexes = [first]; visited.add(first);
    for (let cursor = 0; cursor < indexes.length; cursor++) {
      const current = indexes[cursor];
      if (current === undefined) throw new ToolInputProjectionError('held');
      for (const neighbor of edges[current] ?? []) if (!visited.has(neighbor)) { visited.add(neighbor); indexes.push(neighbor); }
    }
    if (indexes.length < 2) continue;
    // Alignment is not assumed transitive. Every proposed group must be a complete same-entity clique;
    // a group that is not one proposes nothing, and the rest of the curator still reads.
    const complete = indexes.every(left => indexes.every(right => left === right || edges[left]?.has(right) === true));
    if (!complete) {
      logger.warn('Learning duplicate readings are not a complete same-entity group; nothing is proposed for it', { domain, records: indexes.length });
      continue;
    }
    const group = indexes.map(index => {
      const record = records[index]; if (!record) throw new ToolInputProjectionError('held'); return record;
    }).sort((left, right) => left.item.id.localeCompare(right.item.id));
    // A duplicate already staged stays in the group, so the stale-then-delete flow can still find its candidate, but it
    // is never the survivor: only live records compete, so a second pass cannot flip the survivor onto a staged copy.
    const live = group.filter(record => record.item.reviewState !== 'stale');
    if (live.length === 0) continue;
    const selected = live.length === 1 ? 0 : await readLearningSurvivor({ domain, records: live, context }, options);
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    const survivor = live[selected]; if (!survivor) throw new ToolInputProjectionError('held');
    const key = JSON.stringify(group.map(record => record.item.id));
    const candidate = consolidationCandidate(domain, key, group.map(record => record.item), survivor.item);
    if (candidate) result.push(candidate);
  }
  options.signal?.throwIfAborted(); options.assertCurrent?.(); return result;
}
