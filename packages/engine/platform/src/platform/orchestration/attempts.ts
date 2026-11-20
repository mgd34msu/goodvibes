import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

/**
 * attempts.ts, best-of-N sibling attempts for the orchestration engine.
 *
 * A work item declared with `attempts: N` is expanded into N sibling items that
 * run the SAME pipeline INDEPENDENTLY, each in its own isolated worktree. When a
 * sibling passes, the engine does NOT auto-merge it: it parks the sibling in the
 * 'held-merge' state (worktree kept, diff inspectable) and, once EVERY sibling in
 * the group is terminal, exposes the group's candidates for a winner pick. A
 * winner is accepted explicitly (fleet.attempts.pick), or PROPOSED by an
 * judge (fleet.attempts.judge, the contract.best-of-n selector), which only auto-picks when the
 * source item opted into `autoAcceptWinner`. Picking merges the winner's branch
 * through the existing sequential integration lane and cleans the losers'
 * worktrees.
 *
 * This coordinator owns the group registry and the pick/judge orchestration; the
 * engine keeps only thin hooks (expand at create, hold-vs-merge at terminal-pass,
 * a readiness nudge at terminal-fail) and delegates its public best-of-N methods
 * here, so engine.ts stays small.
 */
import {
  type AttemptCandidate,
  type AttemptJudge,
  type AttemptJudgment,
  type AttemptLoserOutcome,
  type AttemptPickResult,
  type HeldMergeGroup,
  type OrchestrationEvent,
  type WorkItem,
  type WorkItemSpec,
  type Workstream,
  type WorkstreamIsolation,
} from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { OwnedScope } from '../utils/owned-work.js';
import { existsSync } from 'node:fs';
import { done, failedOutcome, observe, pending, refusal, type EffectOutcome } from '@goodvibes-jev/engine/errors';

/** How long a pick waits for each loser's worktree clean-up before reporting it still cleaning. */
const LOSER_CLEANUP_DEADLINE_MS = 10_000;

/** Thrown for an honest caller error against the best-of-N surface (unknown group, not-ready, bad winner). */
export class AttemptError extends Error {
  constructor(message: string, readonly reason: 'precondition' | 'judge-unavailable' = 'precondition') {
    super(message);
    this.name = 'AttemptError';
  }
}

/**
 * A pick whose winner did not merge. `conflict`: the winner's branch conflicts
 * with the base in `files`; `not-merged`: the merge did not complete (`reason`).
 * Either way nothing was discarded: every attempt is still a candidate and the
 * group can be picked again.
 */
export class AttemptMergeError extends AttemptError {
  constructor(
    readonly groupId: string,
    readonly winnerItemId: string,
    readonly outcome: 'conflict' | 'not-merged',
    readonly files: readonly string[],
    readonly detail: string,
  ) {
    super(outcome === 'conflict'
      ? `the winner ${winnerItemId} of best-of-N group ${groupId} conflicts with the base in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}; nothing was discarded and the group can be picked again: pick another attempt, or resolve the conflict and pick it again`
      : `the winner ${winnerItemId} of best-of-N group ${groupId} was not merged (${detail}); nothing was discarded and the group can be picked again`);
    this.name = 'AttemptMergeError';
  }
}

export interface AttemptsCoordinatorDeps {
  /** Shared with the engine so nested integration/cleanup belongs to the same drain. */
  readonly ownedWork?: OwnedScope | undefined;
  readonly emit: (event: OrchestrationEvent) => void;
  readonly getWorkstream: (id: string) => Workstream | null;
  /** Route a (non-attempt terminal-passed item, or a picked winner) onto the sequential integration lane. */
  readonly enqueueIntegration: (workstream: Workstream, item: WorkItem) => void | Promise<void>;
  /** Remove a loser's worktree (clean → removed; dirty → kept, the existing cleanup rule). Never throws. */
  readonly cleanupWorktree: (workstream: Workstream, item: WorkItem) => Promise<void>;
  /** The diff a candidate's worktree branch introduced over base, or null if it has no live worktree. */
  readonly diffItem: (item: WorkItem) => Promise<{ files: string[]; unifiedDiff: string; stat: string } | null>;
  /** Optional judge (the contract.best-of-n selector). Absent → fleet.attempts.judge honestly reports no judge is configured. */
  readonly judge?: AttemptJudge | undefined;
  /** Why a candidate's last phase commit failed, or undefined when its work is committed; such a branch cannot be merged yet. */
  readonly commitPending?: ((workstream: Workstream, item: WorkItem) => string | undefined) | undefined;
}

export interface AttemptsCoordinator {
  join(): Promise<void>;
  /** Expand any `attempts:N` spec into N sibling items (worktree isolation only); pass others through unchanged. */
  expandItems(
    workstreamId: string,
    isolation: WorkstreamIsolation | undefined,
    specs: readonly WorkItemSpec[],
    build: (spec: WorkItemSpec) => WorkItem,
    beforePublish?: (() => void) | undefined,
  ): WorkItem[];
  /** Validate group labels without publishing any imported state. */
  assertImportable(workstream: Workstream): void;
  /** Rebuild the in-memory group registry from an imported workstream's items (resume path). */
  reconcileGroups(workstream: Workstream): void;
  /** At an item's terminal PASS: hold it as a best-of-N candidate, or (non-attempt) enqueue its integration. */
  onItemPassedTerminal(workstream: Workstream, item: WorkItem): void;
  /** At an attempt sibling's terminal FAIL: re-check whether its group is now fully resolved. No-op for non-attempt items. */
  onItemFailedTerminal(workstream: Workstream, item: WorkItem): void;
  /**
   * A sibling left its terminal state (retried, requeued, auto-retried). Its
   * group is no longer settled, so readiness is announced again when it settles.
   * No-op for non-attempt items.
   */
  onItemReopened(item: WorkItem): void;
  /**
   * The held-merge groups (optionally filtered by workstream, or narrowed to
   * one group id), each with its candidates' diffs. Only the groups returned
   * are diffed.
   */
  listGroups(workstreamId?: string, groupId?: string): Promise<HeldMergeGroup[]>;
  /** Accept a winner: merge it through the integration lane, clean the losers. */
  pickWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult>;
  /** Run the judge over a group's candidates and PROPOSE a winner (never auto-picks here). */
  proposeWinner(groupId: string): Promise<AttemptJudgment>;
}

interface GroupEntry {
  workstreamId: string;
  readonly sourceTitle: string;
  readonly sourceTask: string;
  readonly siblingItemIds: string[];
  readonly autoAccept: boolean;
  judgment: AttemptJudgment | null;
  readyEmitted: boolean;
}

function clampAttempts(n: number | undefined): number {
  if (!n || !Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** The item id of attempt `index` of the item `sourceId`: the contract runner names its attempt units the same way. */
export function attemptItemId(sourceId: string, index: number): string {
  return `${sourceId}#a${index}`;
}

function siblingId(spec: WorkItemSpec, index: number): string {
  return spec.id ? attemptItemId(spec.id, index) : `item-${crypto.randomUUID()}`;
}

export function createAttemptsCoordinator(deps: AttemptsCoordinatorDeps): AttemptsCoordinator {
  const groups = new Map<string, GroupEntry>();
  /** Groups whose picked winner is still being integrated: not listed, not pickable. */
  const resolving = new Set<string>();
  const ownedWork = deps.ownedWork ?? new OwnedScope('orchestration attempts');

  function siblingsOf(workstream: Workstream, entry: GroupEntry): WorkItem[] {
    return entry.siblingItemIds
      .map((id) => workstream.items.find((i) => i.id === id))
      .filter((i): i is WorkItem => i !== undefined);
  }

  function allTerminal(siblings: readonly WorkItem[]): boolean {
    return siblings.length > 0 && siblings.every((s) => s.state === 'held-merge' || s.state === 'failed');
  }

  function expandItems(
    workstreamId: string,
    isolation: WorkstreamIsolation | undefined,
    specs: readonly WorkItemSpec[],
    build: (spec: WorkItemSpec) => WorkItem,
    beforePublish?: (() => void) | undefined,
  ): WorkItem[] {
    const items: WorkItem[] = [];
    const pendingGroups = new Map<string, GroupEntry>();
    for (const spec of specs) {
      const n = clampAttempts(spec.attempts);
      // Attempts need isolated worktrees to compare; under shared isolation (or
      // n<=1) this is an ordinary single item.
      if (n <= 1 || isolation !== 'worktree') {
        const item = build(spec);
        if (spec.budget) item.itemBudget = spec.budget;
        items.push(item);
        continue;
      }
      const groupId = `boN-${crypto.randomUUID()}`;
      if (groups.has(groupId) || pendingGroups.has(groupId)) throw new AttemptError('Attempt group identity already exists');
      const siblingIds: string[] = [];
      for (let i = 0; i < n; i++) {
        const id = siblingId(spec, i);
        // A contract unit's attempt is its own contract unit (the runner adds
        // one per sibling under the same id), so its agent is held and checked
        // on its own.
        const route = spec.attemptRoutes?.[i];
        const sib = build({
          ...spec,
          id,
          title: `${spec.title} (attempt ${i + 1}/${n})`,
          ...(spec.contractUnitId === undefined ? {} : { contractUnitId: id }),
          ...(route === undefined ? {} : { route }),
        });
        sib.attemptGroupId = groupId;
        sib.attemptIndex = i;
        sib.attemptTotal = n;
        // Record the original spec id (when it had one) so a dependent that
        // referenced it can be resolved back to this group by the dependency
        // gate, the seam that makes a NON-LEAF best-of-N item work.
        if (spec.id) sib.attemptSourceId = spec.id;
        if (spec.autoAcceptWinner) sib.autoAcceptWinner = true;
        if (spec.budget) sib.itemBudget = spec.budget;
        siblingIds.push(sib.id);
        items.push(sib);
      }
      pendingGroups.set(groupId, {
        workstreamId,
        sourceTitle: spec.title,
        sourceTask: spec.task,
        siblingItemIds: siblingIds,
        autoAccept: !!spec.autoAcceptWinner,
        judgment: null,
        readyEmitted: false,
      });
    }
    const ids = new Set<string>();
    for (const item of items) {
      if (typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)) throw new AttemptError('Duplicate or invalid work item identity');
      ids.add(item.id);
    }
    assertSynchronousJudgmentGuard(beforePublish, () => new AttemptError('Work item publication restriction must complete synchronously'));
    // Finish validation before any group is visible or a reentrant listener
    // can observe a partly constructed workstream.
    for (const [groupId, group] of pendingGroups) groups.set(groupId, group);
    for (const [groupId, group] of pendingGroups) deps.emit({ type: 'item-attempts-spawned', workstreamId, groupId,
      itemIds: [...group.siblingItemIds], attempts: group.siblingItemIds.length });
    return items;
  }

  function assertImportable(workstream: Workstream): void {
    for (const item of workstream.items) {
      if (item.attemptGroupId === undefined) continue;
      if (typeof item.attemptGroupId !== 'string' || item.attemptGroupId.length === 0) throw new AttemptError('Invalid attempt group identity');
      const existing = groups.get(item.attemptGroupId);
      if (existing && existing.workstreamId !== workstream.id) throw new AttemptError('Attempt group identity belongs to another workstream');
    }
  }

  function reconcileGroups(workstream: Workstream): void {
    assertImportable(workstream);
    const byGroup = new Map<string, WorkItem[]>();
    for (const item of workstream.items) {
      if (!item.attemptGroupId) continue;
      (byGroup.get(item.attemptGroupId) ?? byGroup.set(item.attemptGroupId, []).get(item.attemptGroupId)!).push(item);
    }
    for (const [groupId, siblings] of byGroup) {
      if (groups.has(groupId)) continue;
      // A winner was already picked: the group is resolved. Registering it again
      // would list a finished group as unresolved work that can never be picked.
      if (siblings.some((s) => s.attemptWinner === true)) continue;
      const source = siblings[0]!;
      groups.set(groupId, {
        workstreamId: workstream.id,
        sourceTitle: source.title,
        sourceTask: source.task,
        siblingItemIds: siblings.map((s) => s.id),
        autoAccept: !!source.autoAcceptWinner,
        judgment: null,
        // If every sibling is already terminal in the snapshot, treat readiness
        // as already announced (don't re-emit on resume).
        readyEmitted: allTerminal(siblings),
      });
    }
  }

  function maybeReady(workstream: Workstream, groupId: string): void {
    const entry = groups.get(groupId);
    if (!entry) return;
    const siblings = siblingsOf(workstream, entry);
    if (!allTerminal(siblings) || entry.readyEmitted) return;
    entry.readyEmitted = true;
    const candidateItemIds = siblings.filter((s) => s.state === 'held-merge').map((s) => s.id);
    if (entry.autoAccept && deps.judge && candidateItemIds.length > 0) {
      void ownedWork.run('attempt work', async () => {
        deps.emit({ type: 'attempts-ready', workstreamId: workstream.id, groupId, candidateItemIds });
        await autoJudgeAndPick(groupId);
      }).catch((error) => {
        logger.warn('attempts: auto judge-and-pick did not complete', { groupId, error: summarizeError(error) });
      });
    } else {
      deps.emit({ type: 'attempts-ready', workstreamId: workstream.id, groupId, candidateItemIds });
    }
  }

  function enqueueIntegration(workstream: Workstream, item: WorkItem): void {
    void ownedWork.run('attempt work', () => deps.enqueueIntegration(workstream, item)).catch((error) => {
      logger.warn('attempts: winner integration did not complete', { itemId: item.id, error: summarizeError(error) });
    });
  }

  function onItemPassedTerminal(workstream: Workstream, item: WorkItem): void {
    if (!item.attemptGroupId) {
      enqueueIntegration(workstream, item);
      return;
    }
    // A best-of-N attempt passed: PARK it (do not merge). Its worktree stays put
    // so its diff can be compared; the winner is chosen later.
    item.state = 'held-merge';
    deps.emit({ type: 'item-attempt-held', workstreamId: workstream.id, groupId: item.attemptGroupId, itemId: item.id });
    maybeReady(workstream, item.attemptGroupId);
  }

  function onItemFailedTerminal(workstream: Workstream, item: WorkItem): void {
    if (!item.attemptGroupId) return;
    maybeReady(workstream, item.attemptGroupId);
  }

  function onItemReopened(item: WorkItem): void {
    if (!item.attemptGroupId) return;
    const entry = groups.get(item.attemptGroupId);
    if (entry) entry.readyEmitted = false;
  }

  async function buildCandidate(item: WorkItem, withDiff: boolean): Promise<AttemptCandidate> {
    const state = item.state === 'failed' ? 'failed' : 'held-merge';
    return {
      itemId: item.id,
      attemptIndex: item.attemptIndex ?? 0,
      state,
      title: item.title,
      worktreePath: item.worktreePath ?? null,
      branch: item.worktreeBranch ?? null,
      usage: item.usage,
      failureReason: item.failureReason ?? null,
      diff: state === 'held-merge' && withDiff ? await deps.diffItem(item) : null,
    };
  }

  async function listGroups(workstreamId?: string, onlyGroupId?: string): Promise<HeldMergeGroup[]> {
    const result: HeldMergeGroup[] = [];
    for (const [groupId, entry] of groups) {
      if (onlyGroupId !== undefined && groupId !== onlyGroupId) continue;
      if (workstreamId && entry.workstreamId !== workstreamId) continue;
      if (resolving.has(groupId)) continue;
      const workstream = deps.getWorkstream(entry.workstreamId);
      if (!workstream) continue;
      const siblings = siblingsOf(workstream, entry);
      // A diff is computed only for a group that can be picked now; one still running shows its candidates without.
      const ready = allTerminal(siblings);
      const candidates = await Promise.all(siblings.filter(item => item.state === 'held-merge' || item.state === 'failed').map((item) => buildCandidate(item, ready)));
      result.push({
        groupId,
        workstreamId: entry.workstreamId,
        sourceTitle: entry.sourceTitle,
        ready,
        attemptCount: siblings.length,
        selectableCandidateCount: siblings.filter(item => item.state === 'held-merge').length,
        unresolved: siblings.filter(item => item.state !== 'held-merge' && item.state !== 'failed').map(item => ({
          itemId: item.id, attemptIndex: item.attemptIndex ?? 0, title: item.title,
          state: item.state, reason: item.blockedReason ?? null,
        })),
        candidates,
        autoAccept: entry.autoAccept,
        judgment: entry.judgment,
      });
    }
    return result;
  }

  function resolveReadyGroup(groupId: string): { workstream: Workstream; entry: GroupEntry; siblings: WorkItem[] } {
    const entry = groups.get(groupId);
    if (!entry) throw new AttemptError(`unknown or already-resolved best-of-N group: ${groupId}`);
    if (resolving.has(groupId)) throw new AttemptError(`best-of-N group ${groupId} already has a winner being merged; it is listed again if that merge fails`);
    const workstream = deps.getWorkstream(entry.workstreamId);
    if (!workstream) throw new AttemptError(`best-of-N group ${groupId} references a workstream that no longer exists`);
    return { workstream, entry, siblings: siblingsOf(workstream, entry) };
  }

  async function pick(groupId: string, winnerItemId: string, auto: boolean): Promise<AttemptPickResult> {
    const { workstream, entry, siblings } = resolveReadyGroup(groupId);
    if (!allTerminal(siblings)) {
      throw new AttemptError(`best-of-N group ${groupId} is not ready: some attempts are still running`);
    }
    const winner = siblings.find((s) => s.id === winnerItemId);
    if (!winner || winner.state !== 'held-merge') {
      throw new AttemptError(`winner must be a held (passed) candidate of group ${groupId}: ${winnerItemId}`);
    }
    const missingCommit = deps.commitPending?.(workstream, winner);
    if (missingCommit !== undefined) {
      // Its branch lacks the last phase's work; the integration lane would merge it without that work.
      throw new AttemptMergeError(groupId, winner.id, 'not-merged', [], `attempt ${winner.id}'s last commit did not land (${missingCommit}); its changes are still in ${winner.worktreePath ?? 'its worktree'}. Retry its commit, then pick it again`);
    }
    const losers = siblings.filter((s) => s.id !== winnerItemId);
    // Winner returns to 'passed' and merges through the existing lane. Mark it the
    // group winner so a dependent (non-leaf best-of-N) can gate on THIS sibling's
    // merge rather than any passed sibling (losers are set 'passed' too, below).
    winner.state = 'passed';
    winner.attemptWinner = true;
    resolving.add(groupId);
    // The pick answers with the merge outcome. The losers' work is discarded
    // only once the winner merged; a conflict or a merge that did not complete
    // puts the winner back among the candidates, and the group stays pickable.
    const reopen = (): void => {
      winner.state = 'held-merge';
      winner.attemptWinner = undefined;
      resolving.delete(groupId);
      deps.emit({ type: 'item-attempt-held', workstreamId: entry.workstreamId, groupId, itemId: winner.id });
    };
    try {
      await ownedWork.run('attempt work', () => deps.enqueueIntegration(workstream, winner));
    } catch (error) {
      logger.warn('attempts: winner integration did not complete; the group stays pickable', { groupId, itemId: winner.id, error: summarizeError(error) });
      reopen();
      throw new AttemptMergeError(groupId, winner.id, 'not-merged', [], summarizeError(error));
    }
    if (winner.mergeState === 'conflict') {
      // The real lane never rejects: a merge that threw is recorded as a conflict with no conflicting files.
      const files = winner.conflictFiles ?? [];
      reopen();
      throw new AttemptMergeError(groupId, winner.id, files.length > 0 ? 'conflict' : 'not-merged', files, winner.blockedReason ?? 'the winner merge did not complete');
    }
    // Losers: discard their work (clean the worktree) and mark terminal. A held
    // loser passed its gates, it is 'passed' with an honest "not selected" note,
    // not a failure; a failed loser is left failed.
    // Each loser's clean-up is awaited up to a deadline and reported as seen: cleaned only when its
    // worktree is observed gone; still cleaning (with the check to run) past the deadline; failed with why.
    const cleanups = losers.map((loser) => {
      if (loser.state === 'held-merge') {
        loser.state = 'passed';
        (loser.warnings ??= []).push('best-of-N: not selected (loser worktree cleaned)');
      }
      return cleanLoser(workstream, loser);
    });
    groups.delete(groupId);
    resolving.delete(groupId);
    const loserItemIds = losers.map((l) => l.id);
    deps.emit({ type: 'attempt-winner-picked', workstreamId: entry.workstreamId, groupId, winnerItemId, loserItemIds, auto });
    const loserOutcomes = await Promise.all(cleanups);
    return { groupId, winnerItemId, loserItemIds, losers: loserOutcomes, auto };
  }

  async function cleanLoser(workstream: Workstream, loser: WorkItem): Promise<AttemptLoserOutcome> {
    const path = loser.worktreePath;
    const since = Date.now();
    const cleanup = ownedWork.run('attempt work', () => deps.cleanupWorktree(workstream, loser));
    const settled = cleanup.then(async (): Promise<EffectOutcome> => {
      const seen = await observe('loser worktree removed', () => loser.worktreePath === undefined && (path === undefined || !existsSync(path)) ? true : undefined);
      if (seen !== undefined) return done({ value: undefined, observed: seen.observed });
      return failedOutcome(refusal({
        code: 'LOSER_WORKTREE_KEPT',
        state: `the worktree of ${loser.id} was kept at ${path ?? loser.worktreePath ?? 'its path'}`,
        reason: `The worktree of ${loser.id} still holds work that exists nowhere else, so it was kept instead of cleaned.`,
        next: ['Inspect the kept worktree; remove it with `git worktree remove` once its work is not needed.'],
        retryable: false,
      }));
    }, (error: unknown): EffectOutcome => {
      logger.warn('attempts: loser worktree cleanup did not complete', { itemId: loser.id, error: summarizeError(error) });
      return failedOutcome(refusal({
        code: 'LOSER_CLEANUP_FAILED',
        state: `the worktree of ${loser.id} was not cleaned`,
        reason: `Cleaning the worktree of ${loser.id} did not complete: ${summarizeError(error)}`,
        next: ['Run `git worktree list` to see whether it is still there, and remove it by hand if it is.'],
        retryable: false,
      }));
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<EffectOutcome>((resolve) => {
      timer = setTimeout(() => resolve(pending('git worktree list', since)), LOSER_CLEANUP_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      return { id: loser.id, outcome: await Promise.race([settled, late]) };
    } finally { clearTimeout(timer); }
  }

  function pickWinner(groupId: string, winnerItemId: string): Promise<AttemptPickResult> {
    return pick(groupId, winnerItemId, false);
  }

  async function proposeWinner(groupId: string): Promise<AttemptJudgment> {
    if (!deps.judge) {
      throw new AttemptError('no judge is configured on this engine; pick a best-of-N winner explicitly (fleet.attempts.pick)', 'judge-unavailable');
    }
    const { entry, siblings } = resolveReadyGroup(groupId);
    if (!allTerminal(siblings)) throw new AttemptError(`best-of-N group ${groupId} is not ready: some attempts are unresolved`);
    const candidates = await Promise.all(
      siblings.map(async (s) => ({
        itemId: s.id,
        attemptIndex: s.attemptIndex ?? 0,
        state: (s.state === 'failed' ? 'failed' : 'held-merge') as 'held-merge' | 'failed',
        diff: s.state === 'held-merge' ? await deps.diffItem(s) : null,
        usage: s.usage,
      })),
    );
    const verdict = await deps.judge({ task: entry.sourceTask, candidates });
    const judgment: AttemptJudgment = {
      proposedWinnerItemId: verdict.winnerItemId,
      reasons: [...verdict.reasons],
      model: verdict.model ?? null,
      scoredBy: 'model',
    };
    entry.judgment = judgment;
    deps.emit({
      type: 'attempt-judge-proposed',
      workstreamId: entry.workstreamId,
      groupId,
      proposedWinnerItemId: judgment.proposedWinnerItemId,
      reasons: judgment.reasons,
    });
    return judgment;
  }

  async function autoJudgeAndPick(groupId: string): Promise<void> {
    const judgment = await proposeWinner(groupId);
    if (judgment.proposedWinnerItemId) {
      await pick(groupId, judgment.proposedWinnerItemId, true);
    }
  }

  return {
    expandItems, assertImportable, reconcileGroups, onItemPassedTerminal, onItemFailedTerminal, onItemReopened,
    listGroups: (workstreamId, groupId) => ownedWork.run('list groups', () => listGroups(workstreamId, groupId)),
    pickWinner: (groupId, winnerItemId) => ownedWork.run('pick winner', () => pickWinner(groupId, winnerItemId)),
    proposeWinner: (groupId) => ownedWork.run('propose winner', () => proposeWinner(groupId)),
    join: () => ownedWork.join(),
  };
}
