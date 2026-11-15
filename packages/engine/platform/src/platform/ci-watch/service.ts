import { nativeCiWatchOwner } from './native-owner.js';
import { captureCiWatchOwner, type CiRepairRequest } from './autonomous.js';
import { currentExternalOperationSource } from '../permissions/external-operation-scope.js';
import type { ExternalOperationSource } from '../permissions/external-request.js';
import { PASSING_CONCLUSIONS } from './types.js';
/**
 * ci-watch/service.ts
 *
 * The CI-watch service: the one-shot per-job status tool, plus the standing
 * subscription mechanism. A standing watch, when checked, fires a channel
 * notification on transition to a terminal verdict; on a RED verdict it
 * production composition obtains recorded Jev admission from the original
 * source owner. The low-level starter callback remains an explicit
 * compatibility API; the daemon and platform do not compose it. A watch whose
 * terminal verdict has been delivered retires itself, checks come from the
 * daemon poller (ci-watch/poller.ts) or the manual ci.watches.run verb.
 */
import { randomUUID } from 'node:crypto';
import { isGitHubRepoName, isGitRefName } from './git-names.js';
import { deriveCiReport, failingJobNames, renderCiReportLines } from './report.js';
import type { CiWatchStore } from './subscriptions.js';
import {
  CiWatchError,
  type CiNotifier,
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

export interface CiWatchServiceDeps {
  /** Trusted composition lookup; saved watch fields alone cannot create ownership. */
  readonly revokeOwner?: ((watch: CiWatchSubscription) => Promise<void>) | undefined;
  readonly recoverOwner?: ((watch: CiWatchSubscription) => ExternalOperationSource | undefined | Promise<ExternalOperationSource | undefined>) | undefined;
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
  /** The watch was retired: its terminal verdict was delivered, so its job is done. */
  readonly retired?: boolean | undefined;
}

/** Normalize the starter's legacy string/undefined forms into the honest outcome shape. */
function normalizeStartOutcome(result: FixSessionStartOutcome | string | undefined): FixSessionStartOutcome {
  if (result === undefined) return { error: 'the fix session failed to start' };
  return typeof result === 'string' ? { sessionId: result } : result;
}

/** Refuse a repo or ref that could never be polled, so it is not stored as a watch that fails on every pass. */
function requireValidTarget(repo: string, ref: string | undefined): void {
  if (!isGitHubRepoName(repo)) {
    throw new CiWatchError(`repo "${repo}" is not a GitHub owner/name (for example "acme/widgets")`, 'INVALID_ARGUMENT');
  }
  if (ref !== undefined && !isGitRefName(ref)) {
    throw new CiWatchError(`ref "${ref}" is not a valid git ref name`, 'INVALID_ARGUMENT');
  }
}

export class CiWatchService {
  private subscriptions: CiWatchSubscription[] | null = null;
  private loading: Promise<CiWatchSubscription[]> | undefined;
  private readonly owners = new Map<string, ExternalOperationSource>();
  private readonly lifetimes = new Map<string, AbortController>();
  private readonly checking = new Map<string, Promise<CiWatchCheckResult>>();
  private readonly repairClaims = new Set<string>();
  // Watches whose terminal verdict is being delivered. They are still stored until the
  // delivery finishes but will not be watched again, so listWatches hides them and a
  // push to the same branch in that window mints a fresh watch instead of being deduped.
  private readonly retiring = new Set<string>();
  /**
   * Verdicts whose notification went out but whose recorded state has not been
   * saved yet. A failed save (or a failed owner revoke on a passed run) makes
   * the next poll start over; without this it would notify again every time.
   */
  private readonly notifiedVerdicts = new Map<string, CiReport['overall']>();
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(private readonly deps: CiWatchServiceDeps) {}

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
    requireValidTarget(repo, input.ref);
    const jobs = await this.deps.source.fetchJobs({ repo, ref: input.ref, prNumber: input.prNumber });
    return deriveCiReport({ repo, ref: input.ref, prNumber: input.prNumber, jobs, now: this.now() });
  }

  async listWatches(): Promise<CiWatchSubscription[]> {
    return (await this.all()).filter((watch) => !this.retiring.has(watch.id));
  }

  async createWatch(input: CreateCiWatchInput, operation: ExternalOperationSource | undefined = currentExternalOperationSource()): Promise<CiWatchSubscription> {
    const owner = captureCiWatchOwner(operation);
    const repo = input.repo?.trim();
    if (!repo) throw new CiWatchError('repo is required (owner/name)', 'INVALID_ARGUMENT');
    if (input.ref === undefined && input.prNumber === undefined) {
      throw new CiWatchError('a ref or prNumber is required', 'INVALID_ARGUMENT');
    }
    requireValidTarget(repo, input.ref);
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
    });
    const subs = await this.all();
    owner?.assertCurrent();
    await nativeCiWatchOwner(owner)?.bindWatch(subscription);
    owner?.assertCurrent();
    this.lifetimes.set(subscription.id, new AbortController());
    if (owner) this.owners.set(subscription.id, owner);
    subs.push(subscription);
    try {
      await this.save(subs);
    } catch (error) {
      // The caller is told the watch was not created, so it must not keep
      // polling, and a retry must not leave a second copy beside it.
      const index = subs.indexOf(subscription);
      if (index !== -1) subs.splice(index, 1);
      this.lifetimes.delete(subscription.id); this.owners.delete(subscription.id);
      throw error;
    }
    return subscription;
  }

  async deleteWatch(id: string): Promise<boolean> {
    const subs = await this.all();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) return false;
    const lifetime = this.lifetimes.get(id);
    lifetime?.abort();
    try {
      const owner = nativeCiWatchOwner(this.owners.get(id));
      if (owner) await owner.revoke();
      else if (subs[index]!.continuationId && this.deps.revokeOwner) await this.deps.revokeOwner(subs[index]!);
      else await nativeCiWatchOwner(await this.deps.recoverOwner?.(subs[index]!))?.revoke();
    } catch (error) {
      // The watch is still listed, so it must keep working: drop the aborted
      // lifetime (the next check makes a fresh one) and let the caller retry the delete.
      if (lifetime && this.lifetimes.get(id) === lifetime) this.lifetimes.delete(id);
      throw error;
    }
    this.lifetimes.delete(id); this.owners.delete(id); this.notifiedVerdicts.delete(id);
    subs.splice(index, 1);
    await this.save(subs);
    return true;
  }

  /**
   * Check one standing watch: poll its per-job status, and if the verdict has
   * transitioned to a terminal state (passed/failed) since last time, fire the
   * channel notification, and, when failed AND the subscription opted in, start
   * a fix-session pre-briefed with the failing jobs' logs.
   */
  checkWatch(id: string): Promise<CiWatchCheckResult> {
    const prior = this.checking.get(id); if (prior) return prior;
    const pending = this.checkOwnedWatch(id); this.checking.set(id, pending);
    void pending.finally(() => { this.retiring.delete(id); if (this.checking.get(id) === pending) this.checking.delete(id); }).catch(() => {});
    return pending;
  }
  private async checkOwnedWatch(id: string): Promise<CiWatchCheckResult> {
    const subs = await this.all();
    const index = subs.findIndex((s) => s.id === id);
    if (index === -1) throw new CiWatchError(`No CI watch with id ${id}`, 'NOT_FOUND');
    const subscription = subs[index]!;
    const lifetime = this.lifetimes.get(id) ?? new AbortController(); this.lifetimes.set(id, lifetime);
    const assertCurrent = () => { lifetime.signal.throwIfAborted(); if (!subs.includes(subscription)) throw new Error('CI watch changed or was removed'); };
    assertCurrent();
    const report = await this.status({ repo: subscription.repo, ...(subscription.ref ? { ref: subscription.ref } : {}), ...(subscription.prNumber !== undefined ? { prNumber: subscription.prNumber } : {}) });

    assertCurrent();
    const terminal = report.overall === 'passed' || report.overall === 'failed';
    const changed = report.overall !== subscription.lastOverall;
    let notified = false;
    let notificationId: string | undefined;
    let fixSessionTriggered = false;
    let fixSessionId: string | undefined;
    let fixSessionError: string | undefined;

    if (terminal && changed && this.deps.notifier && !(subscription.continuationId && report.overall === 'failed')) this.retiring.add(id);
    if (terminal && (changed || (report.overall === 'failed' && subscription.continuationId))) {
      if (changed && this.deps.notifier) {
        if (this.notifiedVerdicts.get(id) !== report.overall) {
          notificationId = await this.deps.notifier(
            subscription.deliveryChannel,
            `CI ${report.overall}, ${report.repo}`,
            renderCiReportLines(report),
          );
          this.notifiedVerdicts.set(id, report.overall);
        }
        notified = true;
      }
      assertCurrent();
      if (report.overall === 'failed') {
        if (this.deps.autonomousRepair) {
          try {
            const brief = Object.freeze(await this.composeFixBrief(subscription, report)); assertCurrent();
            const failureKey = JSON.stringify([subscription.repo, subscription.ref, subscription.prNumber,
              brief.jobs?.map(job => [job.headSha, job.runId, job.jobId]).sort()]);
            const operation = this.owners.get(id) ?? await this.deps.recoverOwner?.(subscription);
            const started = normalizeStartOutcome(await this.deps.autonomousRepair({ subscription, brief,
              operation, signal: lifetime.signal, assertCurrent,
              refreshCurrent: async () => {
                const latest = await this.status({ repo: subscription.repo, ...(subscription.ref ? { ref: subscription.ref } : {}), ...(subscription.prNumber !== undefined ? { prNumber: subscription.prNumber } : {}) });
                assertCurrent();
                if (latest.overall !== report.overall || JSON.stringify(latest.jobs) !== JSON.stringify(report.jobs)) throw new Error('CI commit, run, or jobs changed during admission');
              }, claimRepair: () => {
                assertCurrent();
                // The native owner atomically pins its exact successor in private durable custody.
                // Retry may reconcile partial publication or a lost response, never mint a second lifetime.
                if (nativeCiWatchOwner(operation)) return;
                if (this.repairClaims.has(failureKey)) throw new Error('CI failure repair is already claimed');
                // The oldest claim makes room: a repair that old has long finished, and
                // refusing every new one for the life of the process is the worse failure.
                if (this.repairClaims.size >= 10_000) this.repairClaims.delete(this.repairClaims.values().next().value!);
                this.repairClaims.add(failureKey);
              },
            }));
            if ('sessionId' in started) { fixSessionTriggered = true; fixSessionId = started.sessionId; await this.notifyFixSessionStarted(subscription, report, started.sessionId); }
            else fixSessionError = started.error;
          } catch (error) { fixSessionError = summarizeError(error); }
        } else if (subscription.triggerFixSession) {
          // The auto-start opt-in: no offer, straight to the fix-session. The
          // started session's id rides the verb result AND a follow-up channel
          // notification so a surface can open/attach it.
          fixSessionTriggered = true;
          if (this.deps.fixSessionStarter) {
            // A throw here must not skip recording the verdict below: the
            // notification already went out, and an unsaved verdict re-notifies on every poll.
            try {
              const started = normalizeStartOutcome(await this.deps.fixSessionStarter(await this.composeFixBrief(subscription, report)));
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
    }

    // Retirement: a watch exists to deliver ONE terminal verdict. Once that
    // verdict has been delivered (notified), its job is done and it is
    // removed. Without a notifier the verdict was NOT delivered, so the watch
    // stays (honest fire-once semantics survive missing wiring).
    const retired = terminal && changed && notified
      && !(subscription.continuationId && report.overall === 'failed' && !fixSessionTriggered);
    const currentIndex = subs.indexOf(subscription);
    if (currentIndex !== -1) {
      if (retired) {
        this.retiring.add(id);
        if (report.overall === 'passed') {
          const owner = nativeCiWatchOwner(this.owners.get(id));
          if (owner) await owner.revoke();
          else if (subscription.continuationId && this.deps.revokeOwner) await this.deps.revokeOwner(subscription);
          else await nativeCiWatchOwner(await this.deps.recoverOwner?.(subscription))?.revoke();
        }
        subs.splice(currentIndex, 1); this.owners.delete(id); this.lifetimes.delete(id); }
      else subs[currentIndex] = Object.freeze({ ...subscription, lastOverall: report.overall, updatedAt: this.now() });
      await this.save(subs);
      // The verdict is on record now, so the next poll sees it as delivered.
      this.notifiedVerdicts.delete(id);
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
   * Deliver the started fix-session's id to the watch's channel so a surface
   * can open/attach the session. The id is the payload's machine-readable
   * tail line (sessionId: <id>), mirroring how surfaces parse other
   * structured notification lines. Failure to notify never fails the start.
   */
  private async notifyFixSessionStarted(subscription: CiWatchSubscription, report: CiReport, sessionId: string): Promise<void> {
    if (!this.deps.notifier) return;
    try {
      await this.deps.notifier(
        subscription.deliveryChannel,
        `CI fix session started, ${report.repo}`,
        [
          `A fix session is working on the failing jobs (${failingJobNames(report).join(', ') || 'unknown'}).`,
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
  private async composeFixBrief(subscription: CiWatchSubscription, report: CiReport): Promise<FixSessionBrief> {
    const jobs = Object.freeze(report.jobs.filter(job => job.status === 'completed' && (job.continueOnError || !PASSING_CONCLUSIONS.has(job.conclusion ?? ''))));
    const failing = jobs.map(job => job.name);
    const logs = this.deps.source.fetchFailureLogs
      ? await this.deps.source.fetchFailureLogs({ repo: subscription.repo, ref: subscription.ref, prNumber: subscription.prNumber, jobNames: failing, jobs })
      : `Failing jobs: ${failing.join(', ')}`;
    return {
      repo: subscription.repo,
      ref: subscription.ref,
      prNumber: subscription.prNumber,
      failingJobs: Object.freeze(failing),
      jobs,
      logs,
    };
  }
}
