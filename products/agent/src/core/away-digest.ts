/**
 * Away digest, a friendly "while you were away" summary shown once at launch.
 *
 * This module is intentionally pure: buildAwayDigest() takes a plain snapshot
 * object and returns a structured digest (or null when nothing happened). No
 * side-effects, no imports from the runtime.
 */

export interface AwayDigestScheduleItem {
  readonly name: string;
  readonly lastRunAt?: number;
  readonly runCount: number;
}

export interface AwayDigestTaskItem {
  readonly title: string;
  readonly status: string;
  readonly completedAt?: number;
}

export interface AwayDigestDeliveryItem {
  readonly label: string;
  readonly at?: number;
}

/** A single connected-host automation run outcome (failed or missed) since lastSeenAt. */
export interface AwayDigestRunItem {
  readonly name: string;
  readonly at?: number;
}

export interface AwayDigestInput {
  /** Epoch ms when the user last used the app. null = first run, digest is suppressed. */
  readonly lastSeenAt: number | null;
  /** Schedules that ran since lastSeenAt. */
  readonly schedules: readonly AwayDigestScheduleItem[];
  /** Tasks whose status changed since lastSeenAt. */
  readonly tasks: readonly AwayDigestTaskItem[];
  /**
   * Number of approvals currently waiting, the daemon's record unioned with
   * whatever this process still holds, never one half of that.
   */
  readonly pendingApprovals: number;
  /**
   * Why the daemon's approval record could not be read, when it could not.
   *
   * When set, a count shown is qualified ("more may be waiting on the host");
   * with nothing counted it adds nothing, since an unreadable record is not
   * something that happened. Null (or absent): the count is complete.
   */
  readonly approvalsUnavailableReason?: string | null | undefined;
  /** Optional channel deliveries since lastSeenAt. */
  readonly deliveries?: readonly AwayDigestDeliveryItem[];
  /**
   * Connected-host automation runs that failed since lastSeenAt, read from the
   * host's automation.runs.list outcome, never the agent's local automation
   * manager (local execution is disabled by design).
   */
  readonly failedRuns?: readonly AwayDigestRunItem[];
  /**
   * Connected-host automation runs that were missed (the host was asleep past
   * the scheduled time) since lastSeenAt, same wire source as failedRuns.
   */
  readonly missedRuns?: readonly AwayDigestRunItem[];
}

export interface AwayDigest {
  readonly headline: string;
  /** One plain sentence: "While you were away, the scheduled run nightly failed (03:00)." */
  readonly text: string;
}

/** At most this many things are named in the sentence; the rest are counted. */
const MAX_CLAUSES = 3;

/**
 * Format a relative time from `from` to `at`, e.g. "9:00" or "yesterday 9:00".
 * Keeps language simple and avoids raw timestamps in user-facing copy.
 */
export function formatDigestTime(at: number, from: number = Date.now()): string {
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  const fromDate = new Date(from);
  const sameDay =
    d.getFullYear() === fromDate.getFullYear() &&
    d.getMonth() === fromDate.getMonth() &&
    d.getDate() === fromDate.getDate();

  if (sameDay) return time;

  const yesterday = new Date(from);
  yesterday.setDate(yesterday.getDate() - 1);
  const wasYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  if (wasYesterday) return `yesterday ${time}`;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/**
 * Format a relative duration label for an upcoming item, e.g. "in 2h" or "in 30m".
 */
export function formatRelativeTime(targetMs: number, nowMs: number = Date.now()): string {
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return 'soon';
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return `in ${diffMin}m`;
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) return `in ${diffHours}h`;
  const diffDays = Math.round(diffMs / 86_400_000);
  return `in ${diffDays}d`;
}

/**
 * Build the digest from a plain snapshot: one sentence naming what happened
 * while the owner was away, or null when nothing did (or on a first run).
 * Only things that happened are said. A source that could not be read is not
 * news here: the caller posts that once as a notice.
 */
export function buildAwayDigest(input: AwayDigestInput): AwayDigest | null {
  if (input.lastSeenAt === null) return null;
  const now = Date.now();
  const at = (when: number | undefined): string => (when ? ` (${formatDigestTime(when, now)})` : '');
  const clauses: string[] = [];

  // Asks first: they are waiting on the owner now.
  if (input.pendingApprovals > 0) {
    const n = input.pendingApprovals;
    const more = input.approvalsUnavailableReason ? ' (more may be waiting on the host)' : '';
    clauses.push(`${n} ${n === 1 ? 'ask is' : 'asks are'} waiting for you${more}`);
  }

  const doneTasks = input.tasks.filter((t) => t.status === 'done' || t.status === 'completed' || t.status === 'finished');
  const failedTasks = input.tasks.filter((t) => t.status === 'failed' || t.status === 'error');
  if (failedTasks.length === 1) clauses.push(`${failedTasks[0]!.title} needs attention`);
  else if (failedTasks.length > 1) clauses.push(`${failedTasks.length} tasks need attention`);

  const failedRuns = input.failedRuns ?? [];
  if (failedRuns.length === 1) clauses.push(`the scheduled run ${failedRuns[0]!.name} failed${at(failedRuns[0]!.at)}`);
  else if (failedRuns.length > 1) clauses.push(`${failedRuns.length} scheduled runs failed`);

  const missedRuns = input.missedRuns ?? [];
  if (missedRuns.length === 1) clauses.push(`the scheduled run ${missedRuns[0]!.name} was missed while this computer slept${at(missedRuns[0]!.at)}`);
  else if (missedRuns.length > 1) clauses.push(`${missedRuns.length} scheduled runs were missed while this computer slept`);

  if (doneTasks.length === 1) clauses.push(`${doneTasks[0]!.title} finished${at(doneTasks[0]!.completedAt)}`);
  else if (doneTasks.length > 1) clauses.push(`${doneTasks.length} tasks finished`);

  const fired = input.schedules.reduce((sum, s) => sum + Math.max(1, s.runCount), 0);
  if (input.schedules.length === 1) clauses.push(`${input.schedules[0]!.name} ran${fired > 1 ? ` ${fired} times` : ''}${at(input.schedules[0]!.lastRunAt)}`);
  else if (input.schedules.length > 1) clauses.push(`${input.schedules.length} schedules ran`);

  const deliveries = input.deliveries ?? [];
  if (deliveries.length === 1) clauses.push(`a message was delivered to ${deliveries[0]!.label}`);
  else if (deliveries.length > 1) clauses.push(`${deliveries.length} messages were delivered`);

  if (clauses.length === 0) return null;
  const shown = clauses.length > MAX_CLAUSES
    ? [...clauses.slice(0, MAX_CLAUSES - 1), `${clauses.length - (MAX_CLAUSES - 1)} more things happened`]
    : clauses;
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]!}`;
  return { headline: 'While you were away', text: `While you were away, ${list}.` };
}
