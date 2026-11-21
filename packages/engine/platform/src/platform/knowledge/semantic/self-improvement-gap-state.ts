import { knowledgeClockIso, knowledgeRawRepresentation } from '../store-record-representation.js';
import { KnowledgeSourceQualityHeldError } from '../source-quality.js';
import { prepareObservedKnowledgeNodeInput, upsertObservedKnowledgeNode } from '../store-node-observation.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeIssueRecord,
  KnowledgeIssueUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeNodeUpsertInput,
} from '../types.js';
import {
  semanticMetadata,
} from './utils.js';
import { defineFormat, renderChecked } from '../../utils/format-codec.js';

export const SELF_IMPROVEMENT_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

/** The `resolution.resolvedBy` a gap repair writes on the issues it resolves. */
export const GAP_REPAIR_RESOLVER = 'semantic-self-improvement';

/**
 * A gap's `nextRepairAttemptAt`: milliseconds since the epoch, as a safe
 * integer. The gap writer renders it and every scheduler reads it with this
 * one codec, so a retry window cannot be stored in a form the scheduler skips.
 */
export const GAP_RETRY_CLOCK = defineFormat<number>({
  name: 'knowledge gap retry time',
  parse(raw) {
    return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
      ? { ok: true, value: raw }
      : { ok: false, reason: 'expected milliseconds since the epoch as a whole number' };
  },
  render(value) { return value; },
});

/** The gap's retry time, or undefined when it holds none (or one this codec cannot read). */
export function gapRetryAt(metadata: Readonly<Record<string, unknown>>): number | undefined {
  const parsed = GAP_RETRY_CLOCK.parse(metadata.nextRepairAttemptAt);
  return parsed.ok ? parsed.value : undefined;
}

/** Every `repairStatus` a gap's metadata records. */
export type KnowledgeGapRepairStatus =
  | 'open'
  | 'not_applicable'
  | 'repaired'
  | 'deferred'
  | 'failed'
  | 'searched_no_sources'
  | 'no_repairer'
  | 'needs_context'
  | 'skipped';

/** Statuses after which a repair waits SELF_IMPROVEMENT_RETRY_DELAY_MS before the next attempt. */
const RETRY_WINDOW_STATUSES: ReadonlySet<KnowledgeGapRepairStatus> = new Set(['searched_no_sources', 'failed', 'deferred']);

export async function suppressGap(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  reason: string | undefined,
  spaceId: string,
  assertCurrent: () => void = () => {},
): Promise<void> {
  assertCurrent();
  const node = prepareObservedKnowledgeNodeInput(store, {
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    status: 'stale',
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...knowledgeRawRepresentation(gap.metadata),
      repairStatus: 'not_applicable',
      repairReason: reason,
      repairedAt: knowledgeClockIso(Date.now()),
    },
  }, 'research-task', gap, () => { assertCurrent(); return store.getNode(gap.id); });
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open');
  const guard = () => {
    assertCurrent();
    for (const issue of issues) if (store.getIssue(issue.id) !== issue) throw new KnowledgeSourceQualityHeldError('stale');
  };
  await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [node], edges: [], issues: issues.map((issue) => resolvedIssueInput(issue, spaceId, reason ?? 'Gap was classified as not applicable.')),
    assertCurrent: guard,
  }));
}

export async function markGapRepairAttempt(
  store: KnowledgeStore,
  gap: KnowledgeNodeRecord,
  spaceId: string,
  details: {
    readonly status: KnowledgeGapRepairStatus;
    readonly reason?: string | undefined;
    readonly query?: string | undefined;
    readonly acceptedSourceIds?: readonly string[] | undefined;
    readonly promotedFactCount?: number | undefined;
    readonly nextRepairAttemptAt?: number | undefined;
    readonly assertCurrent?: (() => void) | undefined;
  },
): Promise<KnowledgeNodeRecord> {
  // Only the locally generated retry clock is encoded. Explicit caller values
  // remain untouched and undergo complete raw admission on later reads.
  const retryAt = details.nextRepairAttemptAt ?? (
    RETRY_WINDOW_STATUSES.has(details.status) ? Date.now() + SELF_IMPROVEMENT_RETRY_DELAY_MS : undefined
  );
  const nextRepairAttemptAt = retryAt === undefined ? undefined : renderChecked(GAP_RETRY_CLOCK, retryAt);
  // An undefined key would erase the stored window on merge. Only a retry
  // status sets it and only a repair clears it; any other status keeps it.
  const retryWindow = nextRepairAttemptAt !== undefined
    ? { nextRepairAttemptAt }
    : details.status === 'repaired' ? { nextRepairAttemptAt: undefined } : {};
  const input: KnowledgeNodeUpsertInput = {
    id: gap.id,
    kind: gap.kind,
    slug: gap.slug,
    title: gap.title,
    summary: gap.summary,
    aliases: gap.aliases,
    // A repaired gap is retired, as a suppressed one is: it leaves the
    // candidate set, so later runs spend their slots on gaps still open.
    status: details.status === 'repaired' ? 'stale' : gap.status,
    confidence: gap.confidence,
    sourceId: gap.sourceId,
    metadata: {
      ...knowledgeRawRepresentation(gap.metadata),
      repairStatus: details.status,
      ...(details.reason ? { repairReason: details.reason } : {}),
      ...(details.query ? { repairQuery: details.query } : {}),
      ...((details.acceptedSourceIds?.length ?? 0) > 0 ? { acceptedSourceIds: details.acceptedSourceIds } : {}),
      ...(typeof details.promotedFactCount === 'number' ? { promotedFactCount: details.promotedFactCount } : {}),
      lastRepairAttemptAt: knowledgeClockIso(Date.now()),
      ...retryWindow,
      knowledgeSpaceId: spaceId,
    },
  };
  const readEvidence = () => { details.assertCurrent?.(); return store.getNode(gap.id); };
  if (details.status !== 'repaired') return upsertObservedKnowledgeNode(store, input, 'research-task', gap, readEvidence);
  // A repaired gap is retired together with its open issues, in one commit, as
  // suppressGap does: a failure part way can no longer leave an open issue on a
  // gap that left the candidate set.
  const node = prepareObservedKnowledgeNodeInput(store, input, 'research-task', gap, readEvidence);
  const issues = store.listIssues(Number.MAX_SAFE_INTEGER).filter((entry) => entry.nodeId === gap.id && entry.status === 'open');
  const guard = () => {
    details.assertCurrent?.();
    for (const issue of issues) if (store.getIssue(issue.id) !== issue) throw new KnowledgeSourceQualityHeldError('stale');
  };
  const reason = details.reason ?? 'Gap was repaired with accepted source-backed evidence.';
  await store.applyPreparedIngest({ sources: [], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
    nodes: [node], edges: [], issues: issues.map((issue) => resolvedIssueInput(issue, spaceId, reason)),
    assertCurrent: guard,
  }));
  const committed = store.getNode(gap.id);
  if (!committed) throw new Error(`The repaired gap ${gap.id} is not in the knowledge store after its commit`);
  return committed;
}

function resolvedIssueInput(issue: KnowledgeIssueRecord, spaceId: string, reason: string): KnowledgeIssueUpsertInput {
  return {
    id: issue.id,
    severity: issue.severity,
    code: issue.code,
    message: issue.message,
    status: 'resolved',
    sourceId: issue.sourceId,
    nodeId: issue.nodeId,
    metadata: semanticMetadata(spaceId, {
      ...issue.metadata,
      resolution: {
        reason,
        resolvedBy: GAP_REPAIR_RESOLVER,
        resolvedAt: Date.now(),
      },
    }),
  };
}
