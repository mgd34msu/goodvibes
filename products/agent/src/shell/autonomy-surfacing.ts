/**
 * Ambient autonomy surfacing: the launch "While you were away" digest, the
 * Activity view's "Coming up", and the skill-draft pass that follows a digest
 * which found completed work.
 *
 * Both halves of the Activity view read the connected host, where schedules
 * live and run: Coming up lists its enabled schedules, the digest its run
 * outcomes. Local calendar events are merged into Coming up.
 */

import { buildAwayDigest, formatDigestTime, formatRelativeTime } from '../core/away-digest.ts';
import type { AwayDigestScheduleItem } from '../core/away-digest.ts';
import { LastSeenStore } from '../core/last-seen-store.ts';
import type { AutomationRunsSinceResult } from '../agent/automation-runs-source.ts';
import type { UpcomingSchedulesResult } from '../agent/automation-schedules-source.ts';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { AgentCalendarRegistry } from '../agent/calendar-registry.ts';
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
  getFeed(): { push(text: string, priority?: 'high' | 'low', kind?: string): void } | null;
}

export interface AutonomySurfacingOptions {
  readonly shellPaths: Parameters<typeof LastSeenStore.fromShellPaths>[0];
  /**
   * Coming up: the connected host's enabled schedules with a next run after
   * `now` (automation.schedules.list), the same host the digest reads run
   * outcomes from. Never throws; an unreadable host is named in the result.
   */
  readonly listUpcomingSchedules: (now: number, signal: AbortSignal) => Promise<UpcomingSchedulesResult>;
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
   * Optional callback to list upcoming local calendar events.
   * Each item carries a formatted label and a numeric sort key (ms since epoch)
   * so the Coming up section merges calendar and schedule entries chronologically.
   */
  readonly listCalendarEvents?: () => readonly { label: string; start: number }[];
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

const COMING_UP_TTL_MS = 60_000;
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

  // Refresh lastSeenAt every 5 minutes so rapid restarts still detect activity.
  const lastSeenRefreshInterval = setInterval(() => {
    lastSeenStore.save();
  }, LAST_SEEN_REFRESH_MS);
  lastSeenRefreshInterval.unref();

  const comingUpCache: { items: string[]; fetchedAt: number | null; fetching: boolean } = {
    items: [],
    fetchedAt: null,
    fetching: false,
  };

  const readSignal = (): AbortSignal => AbortSignal.any([lifetime.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);

  async function fillComingUp(now: number): Promise<void> {
    let upcoming: UpcomingSchedulesResult;
    try {
      upcoming = await options.listUpcomingSchedules(now, readSignal());
    } catch (error) {
      upcoming = { schedules: [], unavailable: describeError(error), unavailableKind: 'no_answer' };
    }
    if (lifetime.signal.aborted) return;
    const items: Array<{ label: string; sortKey: number }> = upcoming.schedules.map((schedule) => {
      const name = schedule.name.length > 22 ? `${schedule.name.slice(0, 20)}…` : schedule.name;
      return { label: `${name}, ${formatRelativeTime(schedule.nextRunAt, now)}`, sortKey: schedule.nextRunAt };
    });
    if (options.listCalendarEvents) {
      try {
        for (const ev of options.listCalendarEvents()) items.push({ label: ev.label, sortKey: ev.start });
      } catch (error) {
        logger.debug('coming-up calendar read failed (non-fatal)', { error: describeError(error) });
      }
    }
    const soonest = items.sort((a, b) => a.sortKey - b.sortKey).slice(0, 3).map((item) => item.label);
    // A configured host that could not be read is said, not shown as an empty plan.
    comingUpCache.items = upcoming.unavailableKind === 'no_answer'
      ? [`Schedules unavailable: ${upcoming.unavailable ?? 'the connected host did not answer'}`, ...soonest]
      : soonest;
    comingUpCache.fetchedAt = Date.now();
  }

  /** Refill Coming up when its 60 s cache has lapsed; one host request per minute while it is wanted. */
  function refreshComingUp(): void {
    if (comingUpCache.fetching || lifetime.signal.aborted) return;
    const now = Date.now();
    if (comingUpCache.fetchedAt !== null && now - comingUpCache.fetchedAt < COMING_UP_TTL_MS) return;
    comingUpCache.fetching = true;
    void fillComingUp(now).then(() => {
      comingUpCache.fetching = false;
      if (!lifetime.signal.aborted) options.render();
    }, (error: unknown) => {
      comingUpCache.fetching = false;
      logger.debug('coming-up refresh failed (non-fatal)', { error: describeError(error) });
    });
  }

  async function runDraftPass(): Promise<void> {
    const propose = options.onAwayDigest;
    if (!propose || lifetime.signal.aborted) return;
    try {
      const drafted = await propose(lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (drafted > 0) {
        options.router.getFeed()?.push(
          `[Status] I drafted ${drafted} skill${drafted !== 1 ? 's' : ''} from recent work, review them under Memory`,
          'low',
          'schedule',
        );
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
      const runsRead: Promise<AutomationRunsSinceResult> = lastSeenAt === null
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

      const runsSince = await runsRead;
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
        for (const line of lines) {
          options.router.getFeed()?.push(`[Status] ${line}`, 'low', 'schedule');
        }
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
    lastSeenStore.save();
  }

  return {
    refreshComingUp,
    announceAwayDigest,
    stop,
    // Return a defensive copy so callers cannot mutate internal cache state.
    comingUpItems: (): readonly string[] => [...comingUpCache.items],
  };
}

/**
 * Build the skill-draft pass the digest runs: one `agent_harness`
 * `propose_skill_drafts` call through the ordinary tool path, under the
 * configured permission manager. The pass ends with its signal, and is refused
 * as stale when the host, session, configuration or harness it was built for
 * has been replaced (identity and integer compares, nothing re-read).
 */
export function buildSkillDraftProposer(
  registry: ToolRegistry,
  host: { readonly services: Pick<RuntimeServices, 'permissionManager' | 'configManager'>; readonly commandContext: CommandContext; readonly toolRegistry: ToolRegistry },
): (signal: AbortSignal) => Promise<number> {
  const services = host.services, context = host.commandContext;
  const manager = services.permissionManager, config = services.configManager;
  const session = context.session, runtime = session.runtime, sessionId = runtime.sessionId;
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
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (host.services !== services || host.commandContext !== context || host.toolRegistry !== registry
        || services.permissionManager !== manager || services.configManager !== config
        || config.getConfigurationIncarnation() !== incarnation || context.session !== session
        || session.runtime !== runtime || runtime.sessionId !== sessionId || currentHarness() !== tool)
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

/**
 * Build the listCalendarEvents callback for the given shellPaths.
 * Extracts the closure that was previously inlined in main.ts so that
 * file stays under the 800-line cap.
 *
 * The optional `upcomingEvents` parameter is a testability seam: when provided,
 * it replaces the `registry.upcoming(7)` call so unit tests can inject a
 * deterministic event set without mocking the module. Production callers omit
 * this parameter; the default is the real registry lookup.
 */
export function buildCalendarEventsLister(
  shellPaths: Parameters<typeof LastSeenStore.fromShellPaths>[0],
  upcomingEvents?: () => readonly import('../agent/calendar-registry.ts').AgentCalendarEvent[],
): () => readonly { label: string; start: number }[] {
  return () => {
    const now = Date.now();
    const registry = AgentCalendarRegistry.fromShellPaths(shellPaths);
    return (upcomingEvents ?? (() => registry.upcoming(7)))()
      .map((e) => {
        const allDay = e.allDay;
        // Sort key: use local midnight for all-day events so they sort at the
        // correct local calendar date rather than UTC midnight (which would land
        // the previous day for timezones east of UTC).
        // Timed events: parse the ISO string directly; Date.parse handles
        // offset-bearing strings correctly.
        const startMs = allDay
          ? new Date(`${e.start}T00:00:00`).getTime()   // no tz suffix ⇒ local time
          : Date.parse(e.start);
        const sortMs = isNaN(startMs) ? now : startMs;
        // Display: format via local Date methods so the user sees their own
        // timezone, never a raw stored offset or UTC-shifted string.
        const label = e.title.length > 22 ? `${e.title.slice(0, 20)}…` : e.title;
        const when = allDay
          ? e.start   // date-only string, no time component to misformat
          : formatDigestTime(startMs, now);
        return { label: `${label}, ${when}`, start: sortMs };
      });
  };
}
