/**
 * checkin/service.ts
 *
 * The proactive check-in service: it reads the check-in config, gates on
 * enabled + quiet hours, assembles the briefing, asks the judge whether to
 * contact the user, delivers through the channel deliverer when the judgment
 * says yes, and writes a receipt for EVERY run, the loop that makes the
 * platform able to reach out first, accountably.
 *
 * It rides the existing automation scheduler: syncScheduledJob keeps a single
 * `kind: 'checkin'` automation job in step with the config, and attach() wires
 * the manager's check-in evaluator to this.evaluate, so when the scheduler
 * fires the job, this loop runs (checkin-execution.ts records the run).
 *
 * "Is this run still wanted" has one owner: the run's AbortController. A
 * change to one of the four checkin.* settings aborts a run whose settings
 * it changed (and that run is then repeated once on the new settings), and
 * so do disposal and the caller's own signal. Nothing else re-reads the
 * settings during a run. The scheduled job is compared once, at the send.
 */
import type { JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
import { activateClassicFallback, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import type { CheckinJudgmentReceipt } from './types.js';
import type { AutomationManager } from '../automation/index.js';
import type { AutomationCheckinOutcome } from '../automation/index.js';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { assembleCheckinBriefing, summarizeCheckinState } from './briefing.js';
import { validateSchedule } from '../automation/schedules.js';
import { isQuietHours, parseQuietHours } from './quiet-hours.js';
import { CHANNEL_DELIVERY_SURFACE_KINDS, parseChannelDeliveryTarget } from '../channels/delivery/types.js';
import type { CheckinReceiptStore } from './receipts.js';
import {
  CHECKIN_CONFIG_KEYS,
  type CheckinConfig,
  type CheckinDeliverer,
  type CheckinJudge,
  type CheckinReceipt,
  type CheckinReceiptOutcome,
  type CheckinStateReader,
} from './types.js';

const DEFAULT_CADENCE = '0 */4 * * *';

/**
 * The narrow config surface the check-in reads/writes. Intentionally string-
 * keyed rather than typed against the ConfigKey union: the checkin.* keys live
 * in the config DEFAULTS tree (schema-domain-runtime.ts) and flat settings, and
 * the daemon binds this via a small adapter over its ConfigManager, this keeps
 * the (grandfathered, shrink-only) schema-types.ts ConfigKey union untouched.
 */
export interface CheckinConfigAccess {
  get(key: string): unknown;
  set(key: string, value: string | boolean): void;
  /**
   * Writes several keys as one update (one settings write). Throws when the
   * update is refused, and then nothing was written. Absent: `set` per key.
   */
  setMany?(changes: readonly CheckinConfigChange[]): void;
  /** Fires after a key changes, including edits made outside this service (settings file, CLI). */
  subscribe?(key: string, listener: () => void): () => void;
}

export interface CheckinConfigChange {
  readonly key: string;
  readonly value: string | boolean;
}

export interface CheckinServiceDeps {
  readonly config: CheckinConfigAccess;
  readonly stateReader: CheckinStateReader;
  readonly judge: CheckinJudge;
  readonly deliverer: CheckinDeliverer;
  readonly receipts: CheckinReceiptStore;
  /** The automation manager the scheduled check-in job is synced onto (optional in tests). */
  readonly automation?: Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'attachCheckinEvaluator'> | undefined;
  /** Injectable clock for quiet-hours tests. */
  readonly now?: (() => number) | undefined;
  readonly onRetry?: ((progress: JudgmentRetryProgress) => void) | undefined;
}

export interface SetCheckinConfigInput {
  readonly enabled?: boolean | undefined;
  readonly cadence?: string | undefined;
  readonly deliveryChannel?: string | undefined;
  readonly quietHours?: string | undefined;
}

/**
 * A refusal of a check-in setting the owner supplied. It carries the wire
 * status, code and field, so the gateway answers 400 naming the field rather
 * than storing a value that silently does nothing. The message is the reason
 * followed by the next step, because the gateway sends the message; `state`
 * and `next` are the same facts for a refusal reader (`readRefusal`).
 */
export class CheckinConfigError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_ARGUMENT';
  readonly state = 'nothing was changed';
  readonly next: readonly string[];
  constructor(reason: string, readonly field: string, next: string) {
    super(`${reason} ${next} Nothing was changed.`);
    this.name = 'CheckinConfigError';
    this.next = [next];
  }
}

/** Why a delivery channel names no surface a check-in can be delivered to; undefined when it does. */
function deliveryChannelProblem(channel: string): string | undefined {
  const { surfaceKind } = parseChannelDeliveryTarget(channel);
  if ((CHANNEL_DELIVERY_SURFACE_KINDS as readonly string[]).includes(surfaceKind ?? '')) return undefined;
  return `deliveryChannel "${channel}" names no delivery surface ("${surfaceKind ?? ''}" is not one of ${CHANNEL_DELIVERY_SURFACE_KINDS.join(', ')})`;
}

const DELIVERY_CHANNEL_EXAMPLE = 'Set deliveryChannel to a surface, optionally with an address, for example "slack:C123" or "telegram".';

/** A run in flight, and why it was stopped from outside when it was. */
interface ActiveRun {
  readonly controller: AbortController;
  readonly config: CheckinConfig;
  stoppedBy?: 'settings' | 'job' | 'disposed';
  /** Set when the run recorded that it was stopped by a settings change and will run again. */
  rerun?: boolean;
}

function sameConfig(a: CheckinConfig, b: CheckinConfig): boolean {
  return a.enabled === b.enabled && a.cadence === b.cadence && a.deliveryChannel === b.deliveryChannel && a.quietHours === b.quietHours;
}

/** A job record the manager issued carries its revision; any other record stands for itself. */
function jobRevisionOf(job: { readonly mutationRevision?: string | undefined }): unknown {
  return job.mutationRevision ?? job;
}

const AUTOMATION_ENABLED_KEY = 'automation.enabled';

/** Whether the scheduler really holds a check-in job matching the config. */
export interface CheckinScheduleStatus {
  readonly state: 'scheduled' | 'not-needed' | 'failed';
  /** Why the job could not be installed or updated, when `state` is `failed`. */
  readonly reason?: string | undefined;
}

export class CheckinService {
  private evaluating = false;
  private syncChain: Promise<unknown> = Promise.resolve();
  /** A sync that is queued and has not read the config yet; later requests join it. */
  private queuedSync: Promise<CheckinScheduleStatus> | null = null;
  private schedule: CheckinScheduleStatus = { state: 'not-needed' };
  private readonly activeRuns = new Set<ActiveRun>();
  private attached = false;
  private disposed = false;
  private unsubscribers: Array<() => void> = [];
  constructor(private readonly deps: CheckinServiceDeps) {}

  /** The host owns cancellation; retiring the service cannot leave retrying readers behind. */
  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    for (const run of this.activeRuns) this.stop(run, 'disposed', 'The check-in service was shut down');
  }

  private stop(run: ActiveRun, by: NonNullable<ActiveRun['stoppedBy']>, reason: string): void {
    if (run.stoppedBy) return;
    run.stoppedBy = by;
    run.controller.abort(new Error(reason));
  }

  /** Stop every run whose settings no longer match the stored ones. */
  private settingsChanged(): void {
    if (this.activeRuns.size === 0) return;
    const config = this.getConfig();
    for (const run of this.activeRuns) {
      if (!sameConfig(run.config, config)) this.stop(run, 'settings', 'The check-in settings changed during this run');
    }
  }

  /**
   * One subscription per key for the life of the service. A check-in key
   * stops the runs it changed and, once attached, re-syncs the schedule; the
   * automation switch only re-syncs, so enabling the subsystem later installs
   * a job that could not be created while it was off.
   */
  private watchConfig(): void {
    const subscribe = this.deps.config.subscribe?.bind(this.deps.config);
    if (!subscribe || this.unsubscribers.length > 0 || this.disposed) return;
    for (const key of Object.values(CHECKIN_CONFIG_KEYS)) {
      this.unsubscribers.push(subscribe(key, () => {
        this.settingsChanged();
        if (this.attached) void this.syncScheduledJob();
      }));
    }
    this.unsubscribers.push(subscribe(AUTOMATION_ENABLED_KEY, () => { if (this.attached) void this.syncScheduledJob(); }));
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  getConfig(): CheckinConfig {
    const get = this.deps.config.get.bind(this.deps.config);
    return {
      enabled: get(CHECKIN_CONFIG_KEYS.enabled) === true,
      cadence: asString(get(CHECKIN_CONFIG_KEYS.cadence)) || DEFAULT_CADENCE,
      deliveryChannel: asString(get(CHECKIN_CONFIG_KEYS.deliveryChannel)),
      quietHours: asString(get(CHECKIN_CONFIG_KEYS.quietHours)),
    };
  }

  /** The outcome of the last attempt to put the config on the scheduler. */
  scheduleStatus(): CheckinScheduleStatus {
    return this.schedule;
  }

  /** Refuse values that would be stored and then do nothing, before anything is written. */
  private validate(input: SetCheckinConfigInput): void {
    const cadence = input.cadence?.trim();
    if (cadence) {
      try {
        validateSchedule({ kind: 'cron', expression: cadence });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CheckinConfigError(`cadence "${cadence}" is not a valid cron expression (${detail}).`, 'cadence',
          'Use a five-field cron expression, for example "0 */4 * * *" for every four hours.');
      }
    }
    const quietHours = input.quietHours?.trim();
    if (quietHours && !parseQuietHours(quietHours)) {
      throw new CheckinConfigError(`quietHours "${quietHours}" is not a valid window.`, 'quietHours',
        'Use 24-hour HH:MM-HH:MM in local time, for example "22:00-08:00", or an empty string for none.');
    }
    const named = input.deliveryChannel?.trim();
    const channelProblem = named ? deliveryChannelProblem(named) : undefined;
    if (channelProblem) throw new CheckinConfigError(`${channelProblem}.`, 'deliveryChannel', DELIVERY_CHANNEL_EXAMPLE);
    if (input.enabled === true || input.deliveryChannel !== undefined) {
      const current = this.getConfig();
      const enabled = input.enabled ?? current.enabled;
      const channel = (input.deliveryChannel ?? current.deliveryChannel).trim();
      if (enabled && !channel) {
        throw new CheckinConfigError('deliveryChannel is required to enable check-ins.', 'deliveryChannel',
          'Name the channel the check-in is delivered to, for example "slack:C123", in the same update.');
      }
    }
  }

  async setConfig(input: SetCheckinConfigInput): Promise<CheckinConfig> {
    this.validate(input);
    const changes: CheckinConfigChange[] = [];
    if (input.enabled !== undefined) changes.push({ key: CHECKIN_CONFIG_KEYS.enabled, value: input.enabled });
    if (input.cadence !== undefined) changes.push({ key: CHECKIN_CONFIG_KEYS.cadence, value: input.cadence.trim() });
    if (input.deliveryChannel !== undefined) changes.push({ key: CHECKIN_CONFIG_KEYS.deliveryChannel, value: input.deliveryChannel.trim() });
    if (input.quietHours !== undefined) changes.push({ key: CHECKIN_CONFIG_KEYS.quietHours, value: input.quietHours.trim() });
    if (changes.length > 0) {
      if (this.deps.config.setMany) this.deps.config.setMany(changes);
      else for (const change of changes) this.deps.config.set(change.key, change.value);
    }
    // The key subscriptions already did this when the config access has them.
    this.settingsChanged();
    // Joins the sync the subscriptions queued for these writes: one sync per update.
    await this.syncScheduledJob();
    return this.getConfig();
  }

  async listReceipts(limit?: number): Promise<CheckinReceipt[]> {
    return this.deps.receipts.list(limit);
  }

  /** Wire this service as the automation manager's check-in evaluator, then sync the job. */
  async attach(): Promise<void> {
    // A run's signal, when the scheduler passes one, stops the run when its job is removed or the run is cancelled.
    this.deps.automation?.attachCheckinEvaluator((job, signal?: AbortSignal) => this.evaluate('scheduled', job.id, signal));
    // A settings edit made outside setConfig must reach the scheduler too.
    this.attached = true;
    this.watchConfig();
    await this.syncScheduledJob();
  }

  /**
   * Keep a single kind:'checkin' automation job in step with the config: create
   * it (enabled) when missing, update its cadence, and toggle enabled to match.
   * The automation subsystem must be enabled for a job to exist; when it is off
   * the result is `failed` with the reason, and `attach()` or the next
   * `setConfig` retries. Calls run one at a time so two syncs cannot both see no
   * job and create two, and a request made while a sync is queued and has not
   * read the config yet joins that sync, so the four writes of one update cost
   * one sync.
   */
  syncScheduledJob(): Promise<CheckinScheduleStatus> {
    if (this.queuedSync) return this.queuedSync;
    const run = this.syncChain.then(() => {
      this.queuedSync = null;
      return this.syncOnce();
    });
    this.queuedSync = run;
    this.syncChain = run;
    return run;
  }

  private async syncOnce(): Promise<CheckinScheduleStatus> {
    const automation = this.deps.automation;
    if (!automation) return this.schedule = { state: 'not-needed', reason: 'no scheduler is attached' };
    try {
      const config = this.getConfig();
      const job = automation.listJobs().find((j) => j.kind === 'checkin');
      if (!job) {
        if (!config.enabled) return this.schedule = { state: 'not-needed' };
        await automation.createJob({
          name: 'Proactive check-in',
          kind: 'checkin',
          prompt: '(proactive check-in, briefing assembled at run time)',
          schedule: { kind: 'cron', expression: config.cadence },
          target: { kind: 'isolated', createIfMissing: true },
          enabled: true,
        });
        return this.schedule = { state: 'scheduled' };
      }
      const inStep = job.enabled === config.enabled && job.schedule.kind === 'cron' && job.schedule.expression === config.cadence;
      // One update carries the cadence and the enabled state; a job already in step is not written.
      if (!inStep) {
        await automation.updateJob(job.id, {
          kind: 'checkin',
          schedule: { kind: 'cron', expression: config.cadence },
          enabled: config.enabled,
        });
      }
      return this.schedule = config.enabled ? { state: 'scheduled' } : { state: 'not-needed' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('check-in: the schedule was not installed', { error: summarizeError(error) });
      return this.schedule = { state: 'failed', reason: `The check-in schedule was not installed: ${reason}` };
    }
  }

  /**
   * Run one check-in evaluation and record its receipt. Returns the terminal
   * outcome the automation run records. A run whose check-in settings change
   * while it is in flight is stopped and run once more on the new settings; a
   * scheduled run whose job was removed, disabled or redefined sends nothing.
   */
  async evaluate(trigger: 'scheduled' | 'manual', jobId?: string, callerSignal?: AbortSignal, assertAuthority?: () => void): Promise<AutomationCheckinOutcome> {
    // One run at a time: a manual run overlapping a scheduled one would each judge
    // and deliver, contacting the owner twice about the same state.
    if (this.evaluating) {
      return this.record(trigger, this.now(), 'cancelled', 'not assembled', {
        decisionReason: 'Another check-in run was already in progress, so this one did not run.',
      });
    }
    this.evaluating = true;
    try {
      this.watchConfig();
      const first = this.beginRun();
      const outcome = await this.runEvaluation(first, true, trigger, jobId, callerSignal, assertAuthority);
      if (first.rerun !== true) return outcome;
      return await this.runEvaluation(this.beginRun(), false, trigger, jobId, callerSignal, assertAuthority);
    } finally {
      this.evaluating = false;
    }
  }

  private beginRun(): ActiveRun {
    const run: ActiveRun = { controller: new AbortController(), config: this.getConfig() };
    if (this.disposed) this.stop(run, 'disposed', 'The check-in service was shut down');
    return run;
  }

  private runEvaluation(run: ActiveRun, mayRerun: boolean, trigger: 'scheduled' | 'manual', jobId?: string, callerSignal?: AbortSignal, assertAuthority?: () => void): Promise<AutomationCheckinOutcome> {
    return withConfiguredDecisionModelPolicy(async () => {
      const ranAt = this.now();
      const { config } = run;
      const signal = callerSignal ? AbortSignal.any([run.controller.signal, callerSignal]) : run.controller.signal;
      this.activeRuns.add(run);
      const readJob = () => jobId === undefined ? undefined : this.deps.automation?.listJobs().find(job => job.id === jobId);
      let jobRevision: unknown;
      // Called before every judgment attempt: the run's own signal and the quiet-hours window.
      const current = () => {
        signal.throwIfAborted();
        if (isQuietHours(this.now(), config.quietHours)) throw new Error('Quiet hours began during this check-in run');
      };
      // The send cannot be undone: the scheduled job and the caller's authority are compared once more here.
      const beforeSend = () => {
        current();
        if (jobId !== undefined) {
          const job = readJob();
          if (!job || jobRevisionOf(job) !== jobRevision) {
            this.stop(run, 'job', 'The scheduled check-in job was removed, disabled or changed during this run');
            signal.throwIfAborted();
          }
        }
        assertAuthority?.();
      };
      let briefingSummary = 'unavailable';
      let judgment: CheckinJudgmentReceipt | undefined;
      let deliveryEntered = false;
      let confirmedDelivery: { readonly deliveryId: string | undefined } | undefined;
      try {
        if (!config.enabled) return await this.record(trigger, ranAt, 'skipped-disabled', 'check-in disabled', {});
        if (isQuietHours(ranAt, config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', 'quiet hours', {});
        const channel = config.deliveryChannel.trim();
        const channelProblem = channel ? deliveryChannelProblem(channel) : undefined;
        if (channelProblem) {
          // Refused before any model is asked: no judgment can be delivered to a surface that does not exist.
          return await this.record(trigger, ranAt, 'error', 'not assembled', { error: `${channelProblem}. ${DELIVERY_CHANNEL_EXAMPLE}` });
        }
        if (jobId !== undefined) {
          const job = readJob();
          if (!job || job.kind !== 'checkin' || !job.enabled) this.stop(run, 'job', 'The scheduled check-in job is no longer enabled');
          else jobRevision = jobRevisionOf(job);
        }
        current();
        if (isClassicOperation()) return await this.record(trigger, ranAt, 'skipped-decision-models-disabled', 'not assembled', {
          decisionReason: 'Automatic check-ins require decision models; no contact judgment or message was produced.',
        });
        const snapshot = await this.deps.stateReader.snapshot();
        current();
        briefingSummary = summarizeCheckinState(snapshot);
        const decision = await this.deps.judge.decide(assembleCheckinBriefing(snapshot), {
          signal, beforeAttempt: current, onJudgment: (receipt) => { judgment = receipt; }, ...(this.deps.onRetry ? { onRetry: this.deps.onRetry } : {}),
        });
        judgment = decision.judgment;
        current();
        if (!decision.contact) {
          return await this.record(trigger, ranAt, 'quiet', briefingSummary, { decisionReason: decision.reason, judgment });
        }
        const message = decision.message?.trim() ?? '';
        if (!message) return await this.record(trigger, ranAt, 'quiet', briefingSummary, { decisionReason: 'No verified note to deliver', judgment });
        // Settles "certainly not sent" before the transport is entered; the router calls it again at its own send boundary.
        beforeSend();
        deliveryEntered = true;
        const deliveryId = await this.deps.deliverer.deliver(config.deliveryChannel, message, { signal, assertCurrent: beforeSend });
        confirmedDelivery = { deliveryId };
        // Once the transport accepted a send, later revocation cannot erase its delivery receipt.
        return await this.record(trigger, ranAt, 'delivered', briefingSummary, {
          decisionReason: decision.reason, judgment, deliveredMessage: message,
          deliveryChannel: config.deliveryChannel, deliveryId,
        });
      } catch (error) {
        // A persistence failure must not erase known acceptance or fabricate an unknown send.
        if (confirmedDelivery) {
          const unrecorded: AutomationCheckinOutcome = { outcome: 'delivered', summary: 'Check-in delivery was confirmed, but its receipt could not be persisted',
            error: 'Check-in receipt persistence failed',
            ...(confirmedDelivery.deliveryId ? { deliveryId: confirmedDelivery.deliveryId } : {}),
          };
          return unrecorded;
        }
        // An interrupted response cannot prove that an already-entered transport did not send.
        if (deliveryEntered) return await this.record(trigger, ranAt, 'error', briefingSummary, {
          error: 'Check-in delivery outcome was not confirmed; delivery may have begun', judgment,
        });
        if (run.stoppedBy === 'settings' || run.stoppedBy === 'job') {
          // A run the settings stopped is repeated once, unless the caller or the service is done.
          run.rerun = mayRerun && run.stoppedBy === 'settings' && !this.disposed && callerSignal?.aborted !== true;
          return await this.record(trigger, ranAt, 'skipped-stale', briefingSummary, {
            decisionReason: staleReason(run.stoppedBy, run.rerun), judgment,
          });
        }
        if (signal.aborted || this.disposed) return await this.record(trigger, ranAt, 'cancelled', briefingSummary, { judgment });
        if (isQuietHours(this.now(), config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', briefingSummary, { judgment });
        if (error instanceof DecisionModelsDisabledError && isClassicOperation() || activateClassicFallback(error)) {
          return await this.record(trigger, ranAt, 'skipped-decision-models-disabled', briefingSummary, {
            decisionReason: 'Decision models are unavailable; automatic check-in contact and note verification were not completed.', judgment,
          });
        }
        // Refusal and malformed answers remain failures, never an invented semantic no.
        const detail = error instanceof Error ? error.message : String(error);
        return await this.record(trigger, ranAt, 'error', briefingSummary, { error: detail, judgment });
      } finally {
        this.activeRuns.delete(run);
      }
    });
  }

  private async record(
    trigger: 'scheduled' | 'manual',
    ranAt: number,
    outcome: CheckinReceiptOutcome,
    briefingSummary: string,
    extra: {
      readonly decisionReason?: string | undefined;
      readonly judgment?: CheckinJudgmentReceipt | undefined;
      readonly deliveredMessage?: string | undefined;
      readonly deliveryChannel?: string | undefined;
      readonly deliveryId?: string | undefined;
      readonly error?: string | undefined;
    },
  ): Promise<AutomationCheckinOutcome> {
    const receipt: CheckinReceipt = {
      id: `checkin-${ranAt}-${randomUUID().slice(0, 6)}`,
      ranAt,
      trigger,
      outcome,
      briefingSummary,
      ...(extra.judgment ? { judgment: extra.judgment } : {}),
      ...(extra.decisionReason ? { decisionReason: extra.decisionReason } : {}),
      ...(extra.deliveredMessage ? { deliveredMessage: extra.deliveredMessage } : {}),
      ...(extra.deliveryChannel ? { deliveryChannel: extra.deliveryChannel } : {}),
      ...(extra.deliveryId ? { deliveryId: extra.deliveryId } : {}),
      ...(extra.error ? { error: extra.error } : {}),
    };
    await this.deps.receipts.append(receipt);
    return toOutcome(outcome, receipt);
  }
}

function toOutcome(outcome: CheckinReceiptOutcome, receipt: CheckinReceipt): AutomationCheckinOutcome {
  switch (outcome) {
    case 'delivered':
      return { outcome: 'delivered', summary: `delivered: ${receipt.decisionReason ?? 'contacted user'}`, ...(receipt.deliveryId ? { deliveryId: receipt.deliveryId } : {}) };
    case 'quiet':
      return { outcome: 'quiet', summary: `quiet: ${receipt.decisionReason ?? 'nothing warranted contact'}` };
    case 'error':
      return { outcome: 'error', summary: 'check-in evaluation failed', ...(receipt.error ? { error: receipt.error } : {}) };
    case 'cancelled': return { outcome: 'skipped', summary: receipt.decisionReason ?? 'check-in cancelled' };
    case 'skipped-stale': return { outcome: 'skipped', summary: receipt.decisionReason ?? 'the check-in settings or its job changed during the run' };
    case 'skipped-decision-models-disabled': return { outcome: 'skipped', summary: receipt.decisionReason ?? 'automatic check-ins require decision models' };
    default:
      return { outcome: 'skipped', summary: outcome === 'skipped-quiet-hours' ? 'quiet hours' : 'check-in disabled' };
  }
}

/** What a stopped run's receipt says: what changed, and what happens next. */
function staleReason(by: 'settings' | 'job', rerun: boolean): string {
  if (by === 'job') {
    return 'The scheduled check-in job was removed, disabled or changed during this run, so nothing was sent. The schedule follows the job as it is now; checkin.run runs a check-in at once.';
  }
  return rerun
    ? 'The check-in settings changed during this run, so nothing was sent; it runs again now on the new settings.'
    : 'The check-in settings changed during this run, so nothing was sent. The next scheduled check-in uses the new settings; checkin.run runs one at once.';
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
