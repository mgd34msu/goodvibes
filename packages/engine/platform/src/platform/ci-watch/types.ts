/**
 * ci-watch/types.ts
 *
 * Watching CI on a repo/PR with an honest, per-job verdict. The load-bearing
 * doctrine, quoted from the recorded decision:
 *
 *   "never report CI green from the run rollup; check per-job conclusions;
 *    continue-on-error jobs banned (2026-07-07 webui incident)"
 *
 * So the report is built from the PER-JOB conclusions, never a single rollup
 * status, and any job marked continue-on-error is surfaced as a violation
 * rather than being allowed to mask a failure.
 */

/** A GitHub job's run state (`status`) and, once complete, its `conclusion`. */
export interface CiJob {
  readonly headSha?: string | undefined;
  readonly runId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  /** null while not yet completed; otherwise the GitHub conclusion string. */
  readonly conclusion: string | null;
  /** True when the job is configured continue-on-error, banned, because it masks a failure. */
  readonly continueOnError?: boolean | undefined;
  readonly url?: string | undefined;
}

/** The overall verdict, DERIVED from the per-job conclusions (never a rollup). */
export type CiOverall = 'passed' | 'failed' | 'pending' | 'unknown';

/** The per-job CI report the tool returns. */
export interface CiReport {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly overall: CiOverall;
  readonly jobs: readonly CiJob[];
  /** Policy violations found while deriving the verdict (e.g. continue-on-error jobs). */
  readonly violations: readonly string[];
  readonly checkedAt: number;
}

/** A conclusion string that counts as a per-job failure. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure',
  'stale',
]);

/** A conclusion string that counts as a per-job pass. */
export const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'skipped', 'neutral']);

/** A workflow run on the watched commit; a verdict waits until every one is completed. */
export interface CiWorkflowRun {
  readonly name: string;
  /** GitHub's run status: `completed` once it ended, anything else while it is queued, waiting or running. */
  readonly status: string;
  readonly conclusion: string | null;
  readonly url?: string | undefined;
}

/**
 * What happened the last time a repair was tried for one failure (one set of
 * failing jobs on one commit). `started` and `denied` are final for that
 * failure; `error` is tried again at `retryAt`.
 */
export interface CiRepairRecord {
  readonly failureKey: string;
  readonly outcome: 'started' | 'denied' | 'error';
  readonly at: number;
  readonly attempts: number;
  readonly retryAt?: number | undefined;
  readonly reason?: string | undefined;
}

/** A standing watch on a repo/PR. */
export interface CiWatchSubscription {
  /** Lookup only; an issued native host record and live private owner remain mandatory. */
  readonly continuationId?: string | undefined;
  readonly id: string;
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  /**
   * The project folder the watch belongs to: for a watch made automatically, the project of the turn whose push made it.
   * Its repair session works there, never in the daemon's own folder.
   */
  readonly project?: string | undefined;
  /**
   * Whose input made it: for a watch made automatically, the party of the turn whose push made it (the owner's own
   * chat: the owner's; anyone else's: theirs; security/turn-input-party.ts). Its repair is decided and runs as that party, so a
   * watch made from someone else's chat repairs nothing. Absent (a watch saved before it was kept, or made by a call
   * outside any turn): someone else's. Kept on the daemon only; never in a list a caller reads.
   */
  readonly party?: import('../security/turn-input-party.js').TurnInputParty | undefined;
  /** Channel to notify on completion ('surfaceKind' or 'surfaceKind:address'). */
  readonly deliveryChannel: string;
  /** Historical standalone-service opt-in; production always requires original-source Jev admission. */
  readonly triggerFixSession: boolean;
  /** The last overall verdict seen, so a watch fires once on transition to a terminal state. */
  readonly lastOverall?: CiOverall | undefined;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * When the watch ends without a verdict. Pushed forward while CI is pending,
   * never past seven days from creation. Absent on watches saved before it
   * existed, which end one day after creation.
   */
  readonly expiresAt?: number | undefined;
  /** The last repair attempt for the current failure. */
  readonly repair?: CiRepairRecord | undefined;
}

/** The source that fetches CI state (a gh-CLI or REST implementation; a fake in tests). */
export interface CiStatusSource {
  fetchJobs(input: { readonly repo: string; readonly ref?: string | undefined; readonly prNumber?: number | undefined }): Promise<readonly CiJob[]>;
  /** Optional: fetch the failing jobs' logs to pre-brief a fix-session. */
  fetchFailureLogs?(input: {
    readonly repo: string;
    readonly ref?: string | undefined;
    readonly prNumber?: number | undefined;
    readonly jobNames: readonly string[];
    readonly jobs?: readonly CiJob[] | undefined;
  }): Promise<string>;
  /**
   * Optional: the workflow runs for one commit. When present, a verdict is
   * `passed` only once every run on the commit has completed, because jobs
   * that wait on earlier ones (and later workflows) have no check run yet.
   */
  fetchWorkflowRuns?(input: { readonly repo: string; readonly headSha: string }): Promise<readonly CiWorkflowRun[]>;
}

/**
 * The watched ref, pull request or repository no longer exists on the forge
 * (or cannot be read with the current login), so no verdict will ever come.
 */
export class CiTargetGoneError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CiTargetGoneError';
    this.status = status;
  }
}

/**
 * The program that reads CI state (gh) refused or could not answer: not signed in, no network, not installed.
 * A refusal from outside this daemon, never the daemon's own fault; `forgeStatus` is the HTTP status the forge
 * answered when it answered.
 */
export class CiSourceError extends Error {
  readonly forgeStatus: number | undefined;
  constructor(message: string, forgeStatus: number | undefined) {
    super(message);
    this.name = 'CiSourceError';
    this.forgeStatus = forgeStatus;
  }
}

/** The brief handed to a fix-session starter when a watched CI run fails. */
export interface FixSessionBrief {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly failingJobs: readonly string[];
  readonly jobs?: readonly CiJob[] | undefined;
  readonly logs: string;
  /** The project folder of the watch (CiWatchSubscription.project): the repair session works there. */
  readonly project?: string | undefined;
}

/**
 * The starter's outcome: the REAL spawned session's id (the id session
 * attach/resume resolves, never a scheduling handle like an automation job
 * id), or the honest failure. The legacy bare string/undefined forms remain
 * accepted and are normalized by the service.
 */
export type FixSessionStartOutcome =
  | { readonly sessionId: string }
  /** `refused`: the same answer would come for this failure every time, so it is not tried again. */
  | { readonly error: string; readonly refused?: boolean | undefined };

/** Starts a fix-session pre-briefed with the failing jobs' context. */
export type FixSessionStarter = (brief: FixSessionBrief) => Promise<FixSessionStartOutcome | string | undefined>;

/** Delivers a channel notification; returns a delivery id when known. */
export type CiNotifier = (channel: string, title: string, body: string) => Promise<string | undefined>;

export type CiWatchErrorCode = 'INVALID_ARGUMENT' | 'NOT_FOUND';

export class CiWatchError extends Error {
  readonly code: CiWatchErrorCode;
  constructor(message: string, code: CiWatchErrorCode) {
    super(message);
    this.name = 'CiWatchError';
    this.code = code;
  }
}
