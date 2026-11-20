/**
 * Ambient autonomy surfacing: the launch "While you were away" digest and the
 * skill-draft pass that follows a digest which found completed work.
 *
 * The digest reads the connected host, where schedules live and run, for its
 * run outcomes. What is scheduled next is in Your agents (Ctrl+O), read from
 * the same host's fleet.
 */

import { buildAwayDigest } from '../core/away-digest.ts';
import type { AwayDigestScheduleItem } from '../core/away-digest.ts';
import { LastSeenStore } from '../core/last-seen-store.ts';
import type { AutomationRunsSinceResult } from '../agent/automation-runs-source.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { executeToolCalls, toolBudgetFromConfig } from '@goodvibes-jev/engine/platform/platform/core';
import type { RuntimeServices } from '../runtime/services.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';

interface ApprovalLike {
  readonly status: string;
}

interface AutonomyMessageRouter {
  high(message: string): void;
  /** A line to look up later: the notices, not the conversation. */
  low(message: string): void;
}

export interface AutonomySurfacingOptions {
  readonly shellPaths: Parameters<typeof LastSeenStore.fromShellPaths>[0];
  /**
   * The away digest's automation source of truth: connected-host runs
   * (completed/failed/missed) since the given epoch-ms timestamp, read over
   * the wire via automation.runs.list.
   */
  readonly listAutomationRunsSince: (since: number, signal: AbortSignal) => Promise<AutomationRunsSinceResult>;
  /**
   * Every ask waiting for this owner, the daemon's record unioned with the
   * asks still held in this process, NOT the local broker alone. A surface
   * counting only its own broker reports zero while the daemon holds three.
   */
  readonly listApprovals: () => readonly ApprovalLike[];
  /**
   * Why the daemon's approval record could not be read, when it could not, so
   * the digest can say that instead of counting an unreadable list as zero.
   * Returns null when the record WAS read. See runtime/client/approvals-view.ts.
   */
  readonly describeApprovalsUnavailable?: (() => string | null) | undefined;
  readonly getTasksSnapshot: () => readonly unknown[];
  readonly router: AutonomyMessageRouter;
  readonly render: () => void;
  /**
   * The skill-draft pass: returns the count of drafts created; when > 0 a feed
   * line says so. Run at most once per launch, only when the digest found
   * completed work since the person was last here, and only once the shell is idle.
   */
  readonly onAwayDigest?: (signal: AbortSignal) => Promise<number>;
  /** False while a turn runs or something waits on the person. Absent means always idle. */
  readonly isIdle?: (() => boolean) | undefined;
  /**
   * Starts `run` once the shell is idle. The default checks `isIdle` every
   * IDLE_CHECK_MS until it holds; a test passes a scheduler that runs it at once.
   */
  readonly scheduleIdle?: ((run: () => Promise<void>) => void) | undefined;
}

const FETCH_TIMEOUT_MS = 2500;
const LAST_SEEN_REFRESH_MS = 5 * 60_000;
const IDLE_CHECK_MS = 20_000;
const NO_RUNS: AutomationRunsSinceResult = { runs: [], deliveries: [] };

const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Group completed connected-host runs by job name into the digest's
 * { name, lastRunAt, runCount } shape, counting only runs that completed
 * since lastSeenAt on the connected host.
 */
function aggregateFiredSchedules(
  completedRuns: readonly { readonly jobName: string; readonly endedAt?: number }[],
): readonly AwayDigestScheduleItem[] {
  const byJob = new Map<string, { lastRunAt?: number; runCount: number }>();
  for (const run of completedRuns) {
    const existing = byJob.get(run.jobName) ?? { lastRunAt: undefined, runCount: 0 };
    byJob.set(run.jobName, {
      runCount: existing.runCount + 1,
      lastRunAt: existing.lastRunAt === undefined
        ? run.endedAt
        : run.endedAt === undefined ? existing.lastRunAt : Math.max(existing.lastRunAt, run.endedAt),
    });
  }
  return [...byJob.entries()].map(([name, agg]) => ({ name, lastRunAt: agg.lastRunAt, runCount: agg.runCount }));
}

/**
 * Ambient autonomy surfacing for the shell. Everything here is best-effort and
 * never blocks a render; each source degrades on its own and an unreadable one
 * is named where its absence would otherwise read as "nothing happened".
 */
export function createAutonomySurfacing(options: AutonomySurfacingOptions) {
  const lifetime = new AbortController();
  const lastSeenStore = LastSeenStore.fromShellPaths(options.shellPaths);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let draftPassArmed = false;

  // The last-seen time moves forward only over runs that were read: while the
  // digest's read of the host's runs is under way, or after it failed, it stays
  // where it was, so the next digest asks for those runs again.
  let runsRead: 'not-asked' | 'reading' | 'read' | 'failed' = 'not-asked';
  const saveLastSeen = (): void => {
    if (runsRead === 'reading' || runsRead === 'failed') return;
    lastSeenStore.save();
  };
  // Refresh lastSeenAt every 5 minutes so rapid restarts still detect activity.
  const lastSeenRefreshInterval = setInterval(saveLastSeen, LAST_SEEN_REFRESH_MS);
  lastSeenRefreshInterval.unref();


  const readSignal = (): AbortSignal => AbortSignal.any([lifetime.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);

  async function runDraftPass(): Promise<void> {
    const propose = options.onAwayDigest;
    if (!propose || lifetime.signal.aborted) return;
    try {
      const drafted = await propose(lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (drafted > 0) {
        options.router.low(`[Status] I drafted ${drafted} skill${drafted !== 1 ? 's' : ''} from recent work, review them under Memory`);
        options.render();
      }
    } catch (err) {
      // A failed draft pass adds no digest line, but the cause stays in the log.
      logger.debug('away-digest skill-draft hook failed (non-fatal)', { error: describeError(err) });
    }
  }

  function scheduleWhenIdle(run: () => Promise<void>): void {
    const check = (): void => {
      idleTimer = undefined;
      if (lifetime.signal.aborted) return;
      if (options.isIdle?.() === false) { arm(); return; }
      void run();
    };
    const arm = (): void => {
      idleTimer = setTimeout(check, IDLE_CHECK_MS);
      idleTimer.unref?.();
    };
    arm();
  }

  function armDraftPass(): void {
    if (draftPassArmed || !options.onAwayDigest || lifetime.signal.aborted) return;
    draftPassArmed = true;
    (options.scheduleIdle ?? scheduleWhenIdle)(runDraftPass);
  }

  /**
   * Announce what happened while the person was away. Resolves when the pass
   * has finished; callers on the render path discard the promise.
   */
  async function announceAwayDigest(): Promise<void> {
    if (lifetime.signal.aborted) return;
    try {
      const lastSeenAt = lastSeenStore.read();
      // Started first so the synchronous reads below overlap the host request.
      // Only asked once there is a lastSeenAt; a first run suppresses the digest.
      if (lastSeenAt !== null) runsRead = 'reading';
      const runsReading: Promise<AutomationRunsSinceResult> = lastSeenAt === null
        ? Promise.resolve(NO_RUNS)
        : options.listAutomationRunsSince(lastSeenAt, readSignal()).catch((error: unknown) => (
          { runs: [], deliveries: [], unavailable: describeError(error), unavailableKind: 'no_answer' as const }));

      let allTasks: readonly unknown[] = [];
      let tasksUnavailableReason: string | null = null;
      try { allTasks = options.getTasksSnapshot(); } catch (error) { tasksUnavailableReason = describeError(error); }

      let pendingApprovals = 0;
      let approvalsUnavailableReason: string | null = null;
      try {
        pendingApprovals = options.listApprovals().filter((approval) => approval.status === 'pending').length;
        approvalsUnavailableReason = options.describeApprovalsUnavailable?.() ?? null;
      } catch (error) {
        approvalsUnavailableReason = describeError(error);
      }

      const runsSince = await runsReading;
      if (lastSeenAt !== null) runsRead = runsSince.unavailableKind === 'no_answer' ? 'failed' : 'read';
      lifetime.signal.throwIfAborted();

      const completedRuns = runsSince.runs.filter((run) => run.status === 'completed');
      const firedSchedules = aggregateFiredSchedules(completedRuns);
      const failedRuns = runsSince.runs
        .filter((run) => run.status === 'failed')
        .map((run) => ({ name: run.jobName, at: run.endedAt }));
      const missedRuns = runsSince.runs
        .filter((run) => run.status === 'missed')
        .map((run) => ({ name: run.jobName, at: run.endedAt }));

      const changedTasks = lastSeenAt !== null
        ? allTasks
          .filter((task) => {
            const completedAt = (task as { completedAt?: number }).completedAt;
            return completedAt !== undefined ? completedAt > lastSeenAt : false;
          })
          .map((task) => ({
            title: (task as { title?: string; name?: string }).title
              ?? (task as { name?: string }).name
              ?? 'Task',
            status: (task as { status?: string }).status ?? 'done',
            completedAt: (task as { completedAt?: number }).completedAt,
          }))
        : [];

      const digest = buildAwayDigest({
        lastSeenAt,
        schedules: firedSchedules,
        tasks: changedTasks,
        pendingApprovals,
        approvalsUnavailableReason,
        deliveries: runsSince.deliveries,
        failedRuns,
        missedRuns,
        runsUnavailableReason: runsSince.unavailableKind === 'no_answer' ? runsSince.unavailable : null,
      });

      if (digest !== null) {
        const lines = tasksUnavailableReason
          ? [...digest.lines, `Tasks could not be read, so finished tasks may be missing above: ${tasksUnavailableReason}`]
          : digest.lines;
        options.router.high(`[Status] ${[digest.headline, ...lines].join('\n  ')}`);
        options.render();
      }

      // Drafting skills only has material when something finished since the
      // person was last here; it waits for an idle shell so it never competes
      // with the first keystrokes.
      if (completedRuns.length > 0 || changedTasks.length > 0) armDraftPass();
    } catch (err) {
      logger.debug('away-digest failed (non-fatal)', { error: describeError(err) });
    }
  }

  /**
   * Abort every pending read and the draft pass, and record the last-seen
   * time. Synchronous: an exit saves the session without waiting on any of it.
   */
  function stop(): void {
    lifetime.abort();
    clearInterval(lastSeenRefreshInterval);
    if (idleTimer !== undefined) { clearTimeout(idleTimer); idleTimer = undefined; }
    saveLastSeen();
  }

  return {
    announceAwayDigest,
    stop,
  };
}

/**
 * Build the skill-draft pass the digest runs: one `agent_harness`
 * `propose_skill_drafts` call through the ordinary tool path, under the
 * configured permission manager. The pass ends with its signal, and is refused
 * as stale when the services, session or configuration it was built for have
 * been replaced (one identity and two value compares, nothing re-read).
 */
export function buildSkillDraftProposer(
  registry: ToolRegistry,
  host: { readonly services: Pick<RuntimeServices, 'permissionManager' | 'configManager'>; readonly commandContext: CommandContext; readonly toolRegistry: ToolRegistry },
): (signal: AbortSignal) => Promise<number> {
  const services = host.services, context = host.commandContext;
  const manager = services.permissionManager, config = services.configManager;
  const sessionId = context.session.runtime.sessionId;
  const incarnation = config.getConfigurationIncarnation();
  // Looked up per pass, not at construction, so launch never depends on the
  // harness being registered; a missing harness ends that pass only.
  const currentHarness = () => registry.list().find((candidate) => candidate.definition.name === 'agent_harness');
  // This is the existing configured background operation's source, not a user
  // request or an admission. The configured manager still owns every effect.
  const source = Object.freeze({
    goal: 'Review Agent-local learning sources and propose supported reusable skill drafts during the away digest.',
    criteria: Object.freeze([
      'Use complete current native learning evidence and the canonical learning judgments.',
      'Create only fresh disabled skill drafts for later review; do not enable skills or change other behavior.',
      'Preserve configured admission, privacy, cancellation and source currentness throughout the operation.',
    ]),
  });
  let sequence = 0;
  return async signal => {
    signal.throwIfAborted();
    const tool = currentHarness();
    if (!tool) throw new ToolInputProjectionError('unavailable');
    // The four facts that can change under a pass: it was stopped, the runtime
    // services were rebuilt, the configuration moved on, or the session changed.
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (host.services !== services || config.getConfigurationIncarnation() !== incarnation
        || context.session.runtime.sessionId !== sessionId)
        throw new ToolInputProjectionError('stale');
    };
    assertCurrent();
    const callId = `ambient-skill-drafts:${++sequence}`;
    const results = await executeToolCalls({
      toolRegistry: registry, permissionManager: manager, autonomousSource: () => { assertCurrent(); return source; },
      turnSignal: signal, assertCurrent, sessionId, hookDispatcher: null, runtimeBus: null,
      toolBudget: () => toolBudgetFromConfig(config),
      emitterContext: () => ({ sessionId, traceId: callId, source: 'agent-away-digest' }),
    }, callId, [{ id: callId, name: 'agent_harness', arguments: { mode: 'propose_skill_drafts' } }]);
    assertCurrent();
    const result = results[0];
    if (results.length !== 1 || !result) throw new ToolInputProjectionError('held');
    if (!result.success) return 0;
    const output: unknown = typeof result.output === 'string' ? JSON.parse(result.output) : undefined;
    if (!output || typeof output !== 'object' || !('proposed' in output) || typeof output.proposed !== 'number'
      || !Number.isSafeInteger(output.proposed) || output.proposed < 0) throw new ToolInputProjectionError('held');
    return output.proposed;
  };
}
