import { nativeCiWatchOwner } from './native-owner.js';
import { captureCiWatchOwner, type CiRepairRequest } from './autonomous.js';
import { currentExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { ExternalOperationSource } from '../permissions/external-request.js';
/**
 * ci-watch/service.ts
 *
 * The CI-watch service: the one-shot per-job status tool, plus the standing
 * subscription mechanism. A standing watch, when checked, fires a channel
 * notification on transition to a terminal verdict; on a RED verdict the
 * production composition obtains recorded Jev admission from the original
 * source owner. The low-level starter callback remains an explicit
 * compatibility API; the daemon and platform do not compose it. Checks come
 * from the daemon poller (ci-watch/poller.ts) or the manual ci.watches.run verb.
 *
 * Every watch ends. It retires once its terminal verdict is delivered or its
 * repair has started or been refused, and otherwise ends with a "no verdict"
 * notice when the ref is gone or `expiresAt` passes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { isGitHubRepoName, isGitRefName } from './git-names.js';
import { deriveCiReport, failingJobNames, failingJobs, hasActionsIdentity, renderCiReportLines } from './report.js';
import type { CiWatchStore } from './subscriptions.js';
import {
  CiTargetGoneError,
  CiWatchError,
  type CiJob,
  type CiNotifier,
  type CiOverall,
  type CiRepairRecord,
  type CiReport,
  type CiStatusSource,
  type CiWatchSubscription,
  type FixSessionBrief,
  type FixSessionStartOutcome,
  type FixSessionStarter,
} from './types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';

/** A watch with no terminal verdict ends this long after it was created or last seen pending. */
export const CI_WATCH_IDLE_MS = 24 * 60 * 60_000;
/** No watch outlives this, pending or not (a third-party check can stay in progress for good). */
export const CI_WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** A repair that failed to start is tried again after this, doubled per attempt... */
const REPAIR_RETRY_BASE_MS = 60_000;
/** ...up to this. */
const REPAIR_RETRY_MAX_MS = 30 * 60_000;

export interface CiWatchServiceDeps {
  /** Trusted composition lookup; saved watch fields alone cannot create ownership. */
  readonly revokeOwner?: ((watch: CiWatchSubscription) => Promise<void>) | undefined;
  readonly recoverOwner?: ((watch: CiWatchSubscription) => ExternalOperationSource | undefined | Promise<ExternalOperationSource | undefined>) | undefined;
  /** Cancels native continuations whose settings or workspace scope changed since issue; returns each one's id and reason. */
  readonly reconcileOwners?: (() => Promise<readonly { readonly continuationId: string; readonly reason: string }[]>) | undefined;
  readonly autonomousRepair?: ((request: CiRepairRequest) => Promise<FixSessionStartOutcome | string | undefined>) | undefined;
  readonly source: CiStatusSource;
  /**
   * `load` and `save` are the only members CiWatchService calls. Declared as
   * the whole class, every test double had to be cast through `unknown`,
   * CiWatchStore has a private field, so no object literal is structurally
   * assignable to it, and the casts then accepted doubles carrying members the
   * class does not have.
   */
  readonly store: Pick<CiWatchStore, 'load' | 'save'>;
  /** Delivers the completion notification to the subscription's channel (optional in tests). */
  readonly notifier?: CiNotifier | undefined;
  /** Starts the opt-in fix-session; absent → the trigger is recorded but not started. */
  readonly fixSessionStarter?: FixSessionStarter | undefined;
  readonly now?: (() => number) | undefined;
}

export interface CreateCiWatchInput {
  readonly repo: string;
  readonly ref?: string | undefined;
  readonly prNumber?: number | undefined;
  readonly deliveryChannel: string;
  readonly triggerFixSession?: boolean | undefined;
}

export interface CiWatchCheckResult {
  readonly report: CiReport;
  readonly notified: boolean;
  readonly notificationId?: string | undefined;
  readonly fixSessionTriggered: boolean;
  /** The REAL spawned session's id (attach/resume-resolvable), never a scheduling handle. */
  readonly fixSessionId?: string | undefined;
  /** The honest failure when the auto-start fix-session did not produce an attachable session. */
  readonly fixSessionError?: string | undefined;
  /** The watch was retired: its job is done, or it ended without a verdict. */
  readonly retired?: boolean | undefined;
  /** Why the watch ended without delivering a verdict or starting a repair. */
  readonly endedReason?: string | undefined;
}

/** What one watch holds in this process besides its stored row; dropped in one place, `forget`. */
interface WatchRuntime {
  /** Aborted by a delete, so an in-flight check stops before it acts. */
  lifetime: AbortController;
  owner?: ExternalOperationSource | undefined;
  checking?: Promise<CiWatchCheckResult> | undefined;
  /**
   * Its ending is being delivered: still stored until that finishes, but no
   * longer listed, so a push to the same branch in that window mints a fresh watch.
   */
  retiring: boolean;
  /**
   * A verdict announced whose record is not saved yet. A failed save (or a
   * failed owner revoke) makes the next poll start over; without this it
   * would announce again every time.
   */
  announced?: CiOverall | undefined;
}

/** Normalize the starter's legacy string/undefined forms into the honest outcome shape. */
function normalizeStartOutcome(result: FixSessionStartOutcome | string | undefined): FixSessionStartOutcome {
  if (result === undefined) return { error: 'the fix session failed to start' };
  return typeof result === 'string' ? { sessionId: result } : result;
}

/**
 * The one check of a repo, ref and PR number before they are stored or put
 * into the path of an authenticated GitHub API call: anything that could
 * change which endpoint is read is refused here, as an invalid argument.
 */
function requireValidTarget(repo: string, ref: string | undefined, prNumber: number | undefined): void {
  if (!isGitHubRepoName(repo)) {
    throw new CiWatchError(`repo "${repo}" is not a GitHub owner/name (for example "acme/widgets")`, 'INVALID_ARGUMENT');
  }
  if (ref !== undefined && !isGitRefName(ref)) {
    throw new CiWatchError(`ref "${ref}" is not a valid git ref name`, 'INVALID_ARGUMENT');
  }
  if (prNumber !== undefined && (!Number.isSafeInteger(prNumber) || prNumber <= 0)) {
    throw new CiWatchError(`prNumber ${prNumber} is not a pull request number`, 'INVALID_ARGUMENT');
  }
}

function watchTarget(watch: CiWatchSubscription): { repo: string; ref?: string; prNumber?: number } {
  return { repo: watch.repo, ...(watch.ref ? { ref: watch.ref } : {}), ...(watch.prNumber !== undefined ? { prNumber: watch.prNumber } : {}) };
}

function describeTarget(watch: CiWatchSubscription): string {
  return `${watch.repo}${watch.ref ? `@${watch.ref}` : ''}${watch.prNumber !== undefined ? ` (PR #${watch.prNumber})` : ''}`;
}

/**
 * The watch as its owner registered it. `expiresAt` and `repair` are this
 * service's scheduling state, not part of the identity a native owner pins.
 */
function watchIdentity(watch: CiWatchSubscription): CiWatchSubscription {
  const { expiresAt: _expiresAt, repair: _repair, ...identity } = watch;
  return identity;
}

/** One failure: the failing jobs, each pinned to its commit, run and job. */
function failureKeyOf(watch: CiWatchSubscription, jobs: readonly CiJob[]): string {
  const identity = JSON.stringify([watch.repo, watch.ref, watch.prNumber, jobs.map(job => [job.headSha, job.runId, job.jobId, job.name]).sort()]);
  return createHash('sha256').update(identity).digest('hex');
}

const NEW_WATCH_HINT = 'To watch it again, create a new watch (/ci watch in the terminal, or ci.watches.create).';
const REPAIR_REFUSED_HINT = 'Repair it in a session of your own; to watch the next push, create a new watch (/ci watch in the terminal, or ci.watches.create).';

/** Thrown by the claim when another watch of the same failure already started its repair. */
class RepairClaimedError extends Error {
  constructor() { super('another watch already started the repair of this failure'); this.name = 'RepairClaimedError'; }
}

/** What a check had done before the watch ended. */
interface CheckProgress {
  readonly notified: boolean;
  readonly notificationId?: string | undefined;
  readonly fixSessionTriggered: boolean;
  readonly fixSessionId?: string | undefined;
  readonly fixSessionError?: string | undefined;
}

export class CiWatchService {
  private subscriptions: CiWatchSubscription[] | null = null;
  private loading: Promise<CiWatchSubscription[]> | undefined;
  private readonly runtimes = new Map<string, WatchRuntime>();
  /**
   * Failures whose repair this process has claimed, across watches: two
   * watches of the same failed jobs start one repair. The oldest claim makes
   * room at the bound.
   */
  private readonly repairClaims = new Set<string>();
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(private readonly deps: CiWatchServiceDeps) {}

  private runtime(id: string): WatchRuntime {
    let runtime = this.runtimes.get(id);
    if (!runtime) { runtime = { lifetime: new AbortController(), retiring: false }; this.runtimes.set(id, runtime); }
    return runtime;
  }

  /** The one place a watch's in-process state is dropped. */
  private forget(id: string): void {
    this.runtimes.delete(id);
  }

  /**
   * Write the subscriptions as they stand at THIS call, after every write
   * already queued has finished.
   *
   * `checkWatch` is the reason this needs ordering rather than luck: it polls
   * the forge over the network and only writes when that returns, so its write
   * is requested long before it lands and routinely overlaps whatever an
   * operator did in the meantime. Unordered, a `deleteWatch` that had already
   * returned true could be undone by the in-flight check's older snapshot, and
   * the deleted watch keeps polling and notifying, or, on the retirement path,
   * a watch that had already delivered its one terminal verdict comes back and
   * delivers it again.
   *
   * The snapshot is taken here, not deferred to write time: every caller mutates
   * the subscription array and then saves.
   */
  private async save(subscriptions: readonly CiWatchSubscription[]): Promise<void> {
    const snapshot = [...subscriptions];
    await this.writes.run(() => this.deps.store.save(snapshot));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private async all(): Promise<CiWatchSubscription[]> {
    if (this.subscriptions !== null) return this.subscriptions;
    const loading = this.loading ??= this.deps.store.load().then(rows => rows.map(row => Object.freeze({ ...row })));
    try {
      this.subscriptions ??= await loading;
    } catch (error) {
      // A failed read (a locked or briefly unreadable file) must not be cached: the next call reads again.
      if (this.loading === loading) this.loading = undefined;
      throw error;
    }
    return this.subscriptions;
  }

  /** One-shot: the per-job CI status report for a repo/ref/PR. */
  async status(input: { repo: string; ref?: string; prNumber?: number }): Promise<CiReport> {
    const repo = input.repo?.trim();
    if (!repo) throw new CiWatchError('repo is required (owner/name)', 'INVALID_ARGUMENT');
    requireValidTarget(repo, input.ref, input.prNumber);
    const target = { repo, ref: input.ref, prNumber: input.prNumber };
    const jobs = await this.deps.source.fetchJobs(target);
    const report = deriveCiReport({ ...target, jobs, now: this.now() });
    const fetchWorkflowRuns = this.deps.source.fetchWorkflowRuns?.bind(this.deps.source);
    if (report.overall !== 'passed' || !fetchWorkflowRuns) return report;
    // Only a green per-job view costs the second call: it is the one verdict a job not yet created could overturn.
    const shas = [...new Set(jobs.map(job => job.headSha).filter((sha): sha is string => Boolean(sha)))];
    if (shas.length === 0) return report;
    const workflowRuns = (await Promise.all(shas.map(headSha => fetchWorkflowRuns({ repo, headSha })))).flat();
    return deriveCiReport({ ...target, jobs, workflowRuns, now: report.checkedAt });
  }

  async listWatches(): Promise<CiWatchSubscription[]> {
    return (await this.all()).filter((watch) => !this.runtimes.get(watch.id)?.retiring);
  }

  async createWatch(input: CreateCiWatchInput, operation: ExternalOperationSource | undefined = currentExternalOperationSource()): Promise<CiWatchSubscription> {
    const owner = captureCiWatchOwner(operation);
    const repo = input.repo?.trim();
    if (!repo) throw new CiWatchError('repo is required (owner/name)', 'INVALID_ARGUMENT');
    if (input.ref === undefined && input.prNumber === undefined) {
      throw new CiWatchError('a ref or prNumber is required', 'INVALID_ARGUMENT');
    }
    requireValidTarget(repo, input.ref, input.prNumber);
    const channel = input.deliveryChannel?.trim();
    if (!channel) throw new CiWatchError('deliveryChannel is required', 'INVALID_ARGUMENT');
    const now = this.now();
    const subscription: CiWatchSubscription = Object.freeze({
      id: `ciwatch-${randomUUID().slice(0, 10)}`,
      ...(nativeCiWatchOwner(owner) ? { continuationId: nativeCiWatchOwner(owner)!.id } : {}),
      repo,
      ...(input.ref ? { ref: input.ref } : {}),
      ...(input.prNumber !== undefined ? { prNumber: input.prNumber } : {}),
      deliveryChannel: channel,
      triggerFixSession: input.triggerFixSession === true,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + CI_WATCH_IDLE_MS,
    });
    const subs = await this.all();
    owner?.assertCurrent();
    await nativeCiWatchOwner(owner)?.bindWatch(watchIdentity(subscription));
    owner?.assertCurrent();
    const runtime = this.runtime(subscription.id);
    runtime.owner = owner;
    subs.push(subscription);
    try {
      await this.save(subs);
    } catch (error) {
      // The caller is told the watch was not created, so it must not keep
      // polling, and a retry must not leave a second copy beside it.
      const index = subs.indexOf(subscription);
      if (index !== -1) subs.splice(index, 1);
      this.forget(subscription.id);
      throw error;
    }
    return subscription;
  }

  /**
   * Release the owner a watch was created under (a native continuation's
   * grant). Only a watch with a continuation id has one.
   */
  private async revokeOwnerOf(watch: CiWatchSubscription): Promise<void> {
    const owner = nativeCiWatchOwner(this.runtimes.get(watch.id)?.owner);
    if (owner) { await owner.revoke(); return; }
    if (!watch.continuationId) return;
    if (this.deps.revokeOwner) await this.deps.revokeOwner(watchIdentity(watch));
    else await nativeCiWatchOwner(await this.deps.recoverOwner?.(watchIdentity(watch)))?.revoke();
  }

  /**
   * Stop auto-repair on watches whose native continuation no longer holds (the
   * settings or workspace scope it was issued under changed): each watch's
   * channel is told why, and the watch keeps reporting CI without repairing.
   * The owner is asked only while some watch carries a continuation; it compares
   * its records only when the settings or scope moved.
   */
  async reconcileOwners(): Promise<number> {
    if (!this.deps.reconcileOwners) return 0;
    const subs = await this.all();
    if (!subs.some((watch) => watch.continuationId)) return 0;
    const stopped = await this.deps.reconcileOwners();
    if (stopped.length === 0) return 0;
    const reasons = new Map(stopped.map((entry) => [entry.continuationId, entry.reason]));
    const told: Array<{ readonly watch: CiWatchSubscription; readonly reason: string }> = [];
    for (const [index, watch] of subs.entries()) {
      const reason = watch.continuationId ? reasons.get(watch.continuationId) : undefined;
      if (reason === undefined) continue;
      const runtime = this.runtimes.get(watch.id);
      if (runtime) runtime.owner = undefined;
      const { continuationId: _cancelled, ...rest } = watch;
      subs[index] = Object.freeze({ ...rest, updatedAt: this.now() });
      told.push({ watch, reason });
    }
    if (told.length === 0) return 0;
    await this.save(subs);
    for (const { watch, reason } of told) {
      if (!this.deps.notifier) break;
      const target = `${watch.repo}${watch.prNumber !== undefined ? ` #${watch.prNumber}` : watch.ref ? ` @ ${watch.ref}` : ''}`;
      try {
        await this.deps.notifier(watch.deliveryChannel, `CI auto-repair stopped, ${watch.repo}`, [
          `Auto-repair for ${target} stopped: ${reason}.`,
          'This watch still reports CI results, but a failure will not start a repair.',
          'To have failures repaired again, create the watch again from the work.',
        ].join('\n'));
      } catch (error) {
        logger.warn('[ci-watch] auto-repair stop notification failed', { repo: watch.repo, watchId: watch.id, error: summarizeError(error) });
      }
    }
    return told.length;
  }

  async deleteWatch(id: string): Promise<boolean> {
    const subs = await this.all();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const runtime = this.runtime(id);
    const lifetime = runtime.lifetime;
    lifetime.abort();
    try {
      await this.revokeOwnerOf(subs[index]!);
    } catch (error) {
      // The watch is still listed, so it must keep working: replace the aborted
      // lifetime and let the caller retry the delete.
      if (runtime.lifetime === lifetime) runtime.lifetime = new AbortController();
      throw error;
    }
    this.forget(id);
    const current = subs.findIndex((s) => s.id === id);
    if (current !== -1) subs.splice(current, 1);
    await this.save(subs);
    return true;
  }

  /**
   * Check one standing watch: poll its per-job status, and if the verdict has
   * transitioned to a terminal state (passed/failed) since last time, fire the
   * channel notification, and, when failed, start the admitted repair (or the
   * opted-in fix-session) pre-briefed with the failing jobs' logs.
   */
  checkWatch(id: string): Promise<CiWatchCheckResult> {
    const runtime = this.runtime(id);
    if (runtime.checking) return runtime.checking;
    const pending = this.checkOwnedWatch(id, runtime);
    runtime.checking = pending;
    void pending.finally(() => {
      if (runtime.checking === pending) { runtime.checking = undefined; runtime.retiring = false; }
      if (!this.subscriptions?.some((s) => s.id === id)) this.forget(id);
    }).catch(() => {});
    return pending;
  }

  private async checkOwnedWatch(id: string, runtime: WatchRuntime): Promise<CiWatchCheckResult> {
    const subs = await this.all();
    const subscription = subs.find((s) => s.id === id);
    if (!subscription) throw new CiWatchError(`No CI watch with id ${id}`, 'NOT_FOUND');
    const lifetime = runtime.lifetime;
    const assertCurrent = () => { lifetime.signal.throwIfAborted(); if (!subs.includes(subscription)) throw new Error('CI watch changed or was removed'); };
    assertCurrent();
    const target = watchTarget(subscription);
    const hardEnd = subscription.createdAt + CI_WATCH_MAX_AGE_MS;
    const storedExpiry = Math.min(subscription.expiresAt ?? subscription.createdAt + CI_WATCH_IDLE_MS, hardEnd);

    let report: CiReport;
    try {
      report = await this.status(target);
    } catch (error) {
      assertCurrent();
      const empty = deriveCiReport({ ...target, jobs: [], now: this.now() });
      if (error instanceof CiTargetGoneError) {
        return this.endWatch({ subs, subscription, row: subscription, runtime, report: empty, reason: error.message, next: NEW_WATCH_HINT });
      }
      // A check that keeps failing (no network, no gh login) ends with the watch's time, not before.
      if (this.now() >= storedExpiry) {
        return this.endWatch({ subs, subscription, row: subscription, runtime, report: empty, next: NEW_WATCH_HINT,
          reason: `no verdict by ${new Date(storedExpiry).toISOString()}, and the last check failed (${summarizeError(error)})` });
      }
      throw error;
    }

    assertCurrent();
    const now = this.now();
    const terminal = report.overall === 'passed' || report.overall === 'failed';
    const changed = report.overall !== subscription.lastOverall;
    // A failed verdict on a watch that owns a repair (a continuation, or an owner held in this
    // process) is not delivered until the repair starts or is refused: an error waits out its backoff.
    const repairOwned = report.overall === 'failed' && Boolean(this.deps.autonomousRepair)
      && (Boolean(subscription.continuationId) || runtime.owner !== undefined);
    let notified = false;
    let notificationId: string | undefined;
    let fixSessionTriggered = false;
    let fixSessionId: string | undefined;
    let fixSessionError: string | undefined;
    let repair = subscription.repair;

    if (terminal && changed && this.deps.notifier && !repairOwned) runtime.retiring = true;
    if (terminal && changed && this.deps.notifier) {
      if (runtime.announced !== report.overall) {
        notificationId = await this.deps.notifier(
          subscription.deliveryChannel,
          `CI ${report.overall}, ${report.repo}`,
          renderCiReportLines(report),
        );
        runtime.announced = report.overall;
      }
      notified = true;
    }
    assertCurrent();

    if (report.overall === 'failed' && (changed || repairOwned)) {
      if (this.deps.autonomousRepair) {
        const jobs = failingJobs(report);
        const failureKey = failureKeyOf(subscription, jobs);
        const prior = repair?.failureKey === failureKey ? repair : undefined;
        // A started or refused repair is final for this failure; an error waits out its backoff.
        const due = !prior || (prior.outcome === 'error' && now >= (prior.retryAt ?? 0));
        if (due) {
          const attempts = (prior?.attempts ?? 0) + 1;
          const record = (outcome: CiRepairRecord['outcome'], reason?: string): CiRepairRecord => Object.freeze({
            failureKey, outcome, at: now, attempts,
            ...(outcome === 'error' ? { retryAt: now + Math.min(REPAIR_RETRY_BASE_MS * 2 ** (attempts - 1), REPAIR_RETRY_MAX_MS) } : {}),
            ...(reason ? { reason } : {}),
          });
          try {
            const operation = runtime.owner ?? await this.deps.recoverOwner?.(watchIdentity(subscription)); assertCurrent();
            // A continuation's owner can be briefly unavailable (the daemon still starting): try again
            // later, before any log is downloaded, instead of refusing the failure for good.
            if (subscription.continuationId && !operation) throw new Error('the owner of this watch is not available yet');
            const brief = Object.freeze(await this.composeFixBrief(subscription, jobs)); assertCurrent();
            const started = normalizeStartOutcome(await this.deps.autonomousRepair({ subscription: watchIdentity(subscription), brief,
              operation, signal: lifetime.signal, assertCurrent,
              refreshCurrent: async () => {
                const latest = await this.status(target);
                assertCurrent();
                if (latest.overall !== report.overall || JSON.stringify(latest.jobs) !== JSON.stringify(report.jobs)) throw new Error('CI commit, run, or jobs changed during admission');
              }, claimRepair: () => {
                assertCurrent();
                // The native owner atomically pins its exact successor in private durable custody.
                // Retry may reconcile partial publication or a lost response, never mint a second lifetime.
                if (nativeCiWatchOwner(operation)) return;
                if (this.repairClaims.has(failureKey)) throw new RepairClaimedError();
                if (this.repairClaims.size >= 10_000) this.repairClaims.delete(this.repairClaims.values().next().value!);
                this.repairClaims.add(failureKey);
              },
            }));
            if ('sessionId' in started) {
              fixSessionTriggered = true; fixSessionId = started.sessionId; repair = record('started');
              await this.notifyFixSessionStarted(subscription, report, started.sessionId);
            } else {
              fixSessionError = started.error;
              repair = record(started.refused ? 'denied' : 'error', started.error);
            }
          } catch (error) {
            fixSessionError = summarizeError(error);
            repair = record(error instanceof RepairClaimedError ? 'denied' : 'error', fixSessionError);
          }
        } else if (prior?.outcome === 'error') {
          fixSessionError = `${prior.reason ?? 'the repair did not start'}; it is tried again after ${new Date(prior.retryAt ?? now).toISOString()}`;
        }
      } else if (subscription.triggerFixSession) {
        // The auto-start opt-in: no offer, straight to the fix-session. The
        // started session's id rides the verb result AND a follow-up channel
        // notification so a surface can open/attach it.
        fixSessionTriggered = true;
        if (this.deps.fixSessionStarter) {
          // A throw here must not skip recording the verdict below: the
          // notification already went out, and an unsaved verdict re-notifies on every poll.
          try {
            const started = normalizeStartOutcome(await this.deps.fixSessionStarter(await this.composeFixBrief(subscription, failingJobs(report))));
            if ('sessionId' in started) {
              fixSessionId = started.sessionId;
              await this.notifyFixSessionStarted(subscription, report, started.sessionId);
            } else {
              // The honest failure rides the verb result, never a dead id.
              fixSessionError = started.error;
              logger.warn('[ci-watch] auto-start fix-session failed', { repo: subscription.repo, error: started.error });
            }
          } catch (error) {
            fixSessionError = summarizeError(error);
            logger.warn('[ci-watch] auto-start fix-session failed', { repo: subscription.repo, error: fixSessionError });
          }
        }
      }
    }

    const progress: CheckProgress = { notified, notificationId, fixSessionTriggered, fixSessionId, fixSessionError };
    const expiresAt = report.overall === 'pending' ? Math.min(now + CI_WATCH_IDLE_MS, hardEnd) : storedExpiry;
    const row: CiWatchSubscription = Object.freeze({ ...subscription, lastOverall: report.overall, updatedAt: now, expiresAt, ...(repair ? { repair } : {}) });
    // A refused repair is final for this failure: say so once and end the watch.
    if (repairOwned && repair?.outcome === 'denied') {
      return this.endWatch({ subs, subscription, row, runtime, report, progress, title: 'CI repair not started',
        reason: `the repair was not started: ${repair.reason ?? 'refused'}`, next: REPAIR_REFUSED_HINT });
    }

    // Retirement: a watch exists to deliver ONE terminal verdict (and, for a
    // continuation, to start its repair). Without a notifier the verdict was
    // NOT delivered, so the watch stays until it expires.
    const retired = repairOwned ? fixSessionTriggered : terminal && changed && notified;
    if (!retired && now >= expiresAt) {
      if (repairOwned && repair?.outcome === 'error') {
        return this.endWatch({ subs, subscription, row, runtime, report, progress, title: 'CI repair not started', next: REPAIR_REFUSED_HINT,
          reason: `the repair did not start before the watch's time ran out (${repair.reason ?? 'unknown error'})` });
      }
      return this.endWatch({ subs, subscription, row, runtime, report, progress, next: NEW_WATCH_HINT,
        reason: `no ${terminal ? 'delivered ' : ''}verdict by ${new Date(expiresAt).toISOString()} (last seen: ${report.overall})` });
    }

    const currentIndex = subs.indexOf(subscription);
    if (currentIndex !== -1) {
      if (retired) {
        runtime.retiring = true;
        if (!fixSessionTriggered) await this.revokeOwnerOf(subscription);
        subs.splice(currentIndex, 1);
      } else {
        subs[currentIndex] = row;
      }
      await this.save(subs);
      // The verdict is on record now, so the next poll sees it as delivered.
      runtime.announced = undefined;
    }

    return {
      report,
      notified,
      ...(notificationId ? { notificationId } : {}),
      fixSessionTriggered,
      ...(fixSessionId ? { fixSessionId } : {}),
      ...(fixSessionError ? { fixSessionError } : {}),
      ...(retired ? { retired } : {}),
    };
  }

  /**
   * End a watch that will deliver no (further) verdict: release its owner,
   * tell its channel once why it ended and what to do, and remove it. The
   * notice is best-effort: a channel that cannot be reached must not keep a
   * watch alive past its end.
   */
  private async endWatch(input: {
    subs: CiWatchSubscription[];
    /** The stored row this check started from. */
    subscription: CiWatchSubscription;
    /** The row with what this check learned (verdict, repair), kept when the owner cannot be released yet. */
    row: CiWatchSubscription;
    runtime: WatchRuntime;
    report: CiReport;
    reason: string;
    next: string;
    progress?: CheckProgress | undefined;
    title?: string | undefined;
  }): Promise<CiWatchCheckResult> {
    const { subs, subscription, row, runtime, report, reason } = input;
    const progress = input.progress ?? { notified: false, fixSessionTriggered: false };
    const index = subs.indexOf(subscription);
    // Deleted while this check ran: the delete already released the owner and nothing is left to end.
    if (index === -1) return { report, ...progress };
    subs[index] = row;
    runtime.retiring = true;
    try {
      await this.revokeOwnerOf(row);
    } catch (error) {
      // The watch stays (the next check ends it), with what this check learned
      // on record so the repair is not judged again.
      if (row !== subscription) await this.save(subs);
      throw error;
    }
    let notified = progress.notified;
    let notificationId = progress.notificationId;
    if (this.deps.notifier) {
      try {
        notificationId = await this.deps.notifier(row.deliveryChannel, `${input.title ?? 'CI no verdict'}, ${row.repo}`,
          `The CI watch on ${describeTarget(row)} has ended: ${reason}. ${input.next}`);
        notified = true;
      } catch (error) {
        logger.warn('[ci-watch] end-of-watch notice was not delivered', { watchId: row.id, repo: row.repo, reason, error: summarizeError(error) });
      }
    }
    const current = subs.indexOf(row);
    if (current !== -1) {
      subs.splice(current, 1);
      await this.save(subs);
    }
    logger.info('[ci-watch] watch ended', { watchId: row.id, repo: row.repo, reason });
    return {
      report,
      notified,
      ...(notificationId ? { notificationId } : {}),
      fixSessionTriggered: progress.fixSessionTriggered,
      ...(progress.fixSessionId ? { fixSessionId: progress.fixSessionId } : {}),
      ...(progress.fixSessionError ? { fixSessionError: progress.fixSessionError } : {}),
      retired: true,
      endedReason: reason,
    };
  }

  /**
   * Deliver the started fix-session's id to the watch's channel so a surface
   * can open/attach the session. The id is the payload's machine-readable
   * tail line (sessionId: <id>), mirroring how surfaces parse other
   * structured notification lines. Failure to notify never fails the start.
   */
  private async notifyFixSessionStarted(subscription: CiWatchSubscription, report: CiReport, sessionId: string): Promise<void> {
    if (!this.deps.notifier) return;
    const failing = failingJobs(report);
    const elsewhere = this.deps.autonomousRepair ? failing.filter(job => !hasActionsIdentity(job)).map(job => job.name) : [];
    const working = failing.filter(job => !elsewhere.includes(job.name)).map(job => job.name);
    try {
      await this.deps.notifier(
        subscription.deliveryChannel,
        `CI fix session started, ${report.repo}`,
        [
          `A fix session is working on the failing jobs (${working.join(', ') || failingJobNames(report).join(', ') || 'unknown'}).`,
          ...(elsewhere.length > 0 ? [`Not part of it: ${elsewhere.join(', ')}, checks from another app; fix them in their own system.`] : []),
          `sessionId: ${sessionId}`,
        ].join('\n'),
      );
    } catch (error) {
      logger.warn('[ci-watch] fix-session start notification failed', {
        repo: subscription.repo, sessionId, error: summarizeError(error),
      });
    }
  }

  /** The failing-jobs brief (names + logs) shared by the auto-start and offer paths. */
  private async composeFixBrief(subscription: CiWatchSubscription, failing: readonly CiJob[]): Promise<FixSessionBrief> {
    const jobs = Object.freeze([...failing]);
    const names = jobs.map(job => job.name);
    const logs = this.deps.source.fetchFailureLogs
      ? await this.deps.source.fetchFailureLogs({ repo: subscription.repo, ref: subscription.ref, prNumber: subscription.prNumber, jobNames: names, jobs })
      : `Failing jobs: ${names.join(', ')}`;
    return {
      repo: subscription.repo,
      ref: subscription.ref,
      prNumber: subscription.prNumber,
      failingJobs: Object.freeze(names),
      jobs,
      logs,
    };
  }
}
