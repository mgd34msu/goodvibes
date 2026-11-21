import { randomUUID } from 'node:crypto';
import type { AutomationJob, ManagedAutomationJob } from './jobs.js';
import type { MutationPublication } from '../utils/file-mutation.js';

const ownedJobs = new WeakSet<AutomationJob>();
function freezeRecord(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeRecord(child, seen);
  Object.freeze(value);
}

export function ownedAutomationJob(job: AutomationJob, revision: string = randomUUID()): ManagedAutomationJob {
  const owned = { ...structuredClone(job), mutationRevision: revision };
  freezeRecord(owned); ownedJobs.add(owned);
  return owned;
}

export function hasOwnedAutomationRevision(job: AutomationJob): boolean { return ownedJobs.has(job); }

/**
 * What the scheduler writes about a job as it runs: when it fires next, when
 * it last ran and the counters. None of it is the job's definition, so the
 * job's revision does not move when only these change, and an edit prepared
 * against the definition stays current while the job keeps running.
 */
export const AUTOMATION_SCHEDULER_STATE_FIELDS = [
  'nextRunAt', 'lastRunAt', 'lastRunId', 'lastOutcome', 'lastOccurrenceAt', 'runCount', 'successCount', 'failureCount', 'updatedAt',
] as const satisfies readonly (keyof AutomationJob)[];

type SchedulerStateField = (typeof AUTOMATION_SCHEDULER_STATE_FIELDS)[number];

function definitionOf(job: AutomationJob): Omit<AutomationJob, SchedulerStateField | 'mutationRevision'> {
  const { mutationRevision: _revision, nextRunAt: _next, lastRunAt: _last, lastRunId: _lastId, lastOutcome: _outcome, lastOccurrenceAt: _occurrence, runCount: _runs,
    successCount: _successes, failureCount: _failures, updatedAt: _updated, ...definition } = job;
  return definition;
}

/** True when the two records differ in anything other than scheduler state. */
export function automationDefinitionChanged(previous: AutomationJob, next: AutomationJob): boolean {
  return JSON.stringify(definitionOf(previous)) !== JSON.stringify(definitionOf(next));
}

/**
 * `next` with the scheduler state the job has now, for every scheduler field
 * the mutation left as it found it in `previous`. A mutation prepared before
 * the job ran must not write back the counters and run time it read then.
 */
export function withCurrentSchedulerState(previous: AutomationJob, next: AutomationJob, current: AutomationJob): AutomationJob {
  let merged: AutomationJob = next;
  for (const field of AUTOMATION_SCHEDULER_STATE_FIELDS) {
    if (next[field] === previous[field] && current[field] !== previous[field]) merged = { ...merged, [field]: current[field] };
  }
  return merged;
}

/**
 * A job an owner or agent selected by revision. The revision is the one fact
 * an approved change needs: the job is still the one that was approved when
 * its revision has not moved.
 */
export interface RetainedAutomationJobTarget {
  readonly jobId: string;
  readonly revision: string;
  /** The job as it was selected, for describing the change to whoever approves it. */
  readonly job: ManagedAutomationJob;
  /** Throws AutomationJobMutationStaleError once the job's revision has moved or the job is gone. */
  readonly assertCurrent: () => void;
}

const SELECTED_JOB_METHODS = new Set([
  'automation.jobs.update', 'automation.jobs.enable', 'automation.jobs.disable', 'automation.jobs.delete',
  'automation.schedules.resume', 'automation.schedules.pause', 'automation.schedules.delete',
]);

/**
 * The request as the approver sees it: the selected job named by id, its
 * revision replaced by a marker (the revision is an opaque id with no meaning
 * to a reader). Refuses a request that names a different job or revision.
 */
export function projectAutomationTargetRequest(target: RetainedAutomationJobTarget, method: string, body: unknown): unknown {
  if (!SELECTED_JOB_METHODS.has(method) || !body || typeof body !== 'object' || Array.isArray(body)) throw new AutomationJobMutationStaleError();
  const request = body as Record<string, unknown>;
  const selector = method.startsWith('automation.schedules.') ? 'scheduleId' : 'jobId';
  if (request[selector] !== target.jobId || request.expectedMutationRevision !== target.revision) throw new AutomationJobMutationStaleError();
  target.assertCurrent();
  return { ...request, expectedMutationRevision: { kind: 'selected-native-revision', target: 'selected-automation-target' } };
}

export interface AutomationJobMutationOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly withPublication?: MutationPublication | undefined;
  /** CHECKIN_JOB_OWNER when the check-in settings are changing their own job; nothing else passes it. */
  readonly owner?: typeof CHECKIN_JOB_OWNER | undefined;
}

/**
 * The check-in settings own the `kind: 'checkin'` job: only CheckinService,
 * keeping the job in step with checkin.*, removes, enables, disables,
 * reschedules or re-kinds it, and it marks those calls with this.
 */
export const CHECKIN_JOB_OWNER: unique symbol = Symbol('check-in settings');

/** A change to the check-in job made other than through the check-in settings. */
export class AutomationCheckinJobOwnedError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  readonly status = 400;
  constructor(change: string) {
    super(`The check-in job is kept by the check-in settings, so it cannot be ${change} here. Use checkin.config.set: enabled false stops check-ins, enabled true starts them, and cadence changes when they run. Nothing was changed.`);
    this.name = 'AutomationCheckinJobOwnedError';
  }
}

export class AutomationJobMutationStaleError extends Error {
  readonly code = 'AUTOMATION_JOB_STALE';
  readonly status = 409;
  constructor() { super('The selected automation job changed. Read its current revision before updating.'); }
}

export class AutomationJobCommitIndeterminateError extends Error {
  readonly code = 'AUTOMATION_COMMIT_INDETERMINATE';
  readonly status = 503;
  constructor(cause: unknown) {
    super('Automation job bytes were published, but commit confirmation failed. Read the job before retrying.', { cause });
  }
}

export function automationJobRevision(job: AutomationJob): string {
  if (!job.mutationRevision) throw new AutomationJobMutationStaleError();
  return job.mutationRevision;
}

/**
 * Internal writers share this map. A replacement that changes the job's
 * definition advances its revision; one that changes only scheduler state
 * keeps it.
 */
export class AutomationJobMap extends Map<string, ManagedAutomationJob> {
  override set(id: string, job: AutomationJob): this {
    const previous = super.get(id);
    if (previous === job) return this;
    if (previous && !automationDefinitionChanged(previous, job)) {
      return super.set(id, ownedAutomationJob(job, previous.mutationRevision));
    }
    return super.set(id, ownedAutomationJob(job));
  }
  restore(job: AutomationJob): void {
    super.set(job.id, ownedAutomationJob(job, automationJobRevision(job)));
  }
  publish(job: ManagedAutomationJob): void { super.set(job.id, job); }
}

/** The caller's still-wanted check: its signal, then its own currency check. */
export function retainAutomationMutation(options: AutomationJobMutationOptions): () => void {
  return () => {
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
  };
}
