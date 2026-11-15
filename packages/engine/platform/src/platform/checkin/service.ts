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
 */
import type { JudgmentRetryProgress } from '@goodvibes-jev/judgment';
import { DecisionModelsDisabledError, decisionModelPolicyState } from '@goodvibes-jev/engine/errors';
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
  /** Pre-mutation invalidation fences even disable/re-enable and same-value rewrites. */
  onDidInvalidate?(listener: () => void): () => void;
  /** Fires after a key changes, including edits made outside this service (settings file, CLI). */
  subscribe?(key: string, listener: () => void): () => void;
}

export interface CheckinServiceDeps {
  readonly config: CheckinConfigAccess;
  readonly stateReader: CheckinStateReader;
  readonly judge: CheckinJudge;
  readonly deliverer: CheckinDeliverer;
  readonly receipts: CheckinReceiptStore;
  /** The automation manager the scheduled check-in job is synced onto (optional in tests). */
  readonly automation?: Pick<AutomationManager, 'listJobs' | 'createJob' | 'updateJob' | 'setEnabled' | 'attachCheckinEvaluator'> | undefined;
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
 * than storing a value that silently does nothing.
 */
export class CheckinConfigError extends Error {
  readonly status = 400;
  readonly code = 'INVALID_ARGUMENT';
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'CheckinConfigError';
  }
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
  private schedule: CheckinScheduleStatus = { state: 'not-needed' };
  private readonly activeRuns = new Set<AbortController>();
  private revision = 0;
  private disposed = false;
  private unsubscribers: Array<() => void> = [];
  constructor(private readonly deps: CheckinServiceDeps) {}

  /** The host owns cancellation; retiring the service cannot leave retrying readers behind. */
  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.invalidate();
  }

  private invalidate(): void {
    this.revision++;
    for (const controller of this.activeRuns) controller.abort();
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
        throw new CheckinConfigError(`cadence "${cadence}" is not a valid cron expression (${detail}). Example: "0 */4 * * *".`, 'cadence');
      }
    }
    const quietHours = input.quietHours?.trim();
    if (quietHours && !parseQuietHours(quietHours)) {
      throw new CheckinConfigError(`quietHours "${quietHours}" is not a valid window. Use 24-hour HH:MM-HH:MM in local time, for example "22:00-08:00", or an empty string for none.`, 'quietHours');
    }
    if (input.enabled === true || input.deliveryChannel !== undefined) {
      const current = this.getConfig();
      const enabled = input.enabled ?? current.enabled;
      const channel = (input.deliveryChannel ?? current.deliveryChannel).trim();
      if (enabled && !channel) {
        throw new CheckinConfigError('deliveryChannel is required to enable check-ins: name the channel the check-in is delivered to, for example "slack:C123". Nothing was changed.', 'deliveryChannel');
      }
    }
  }

  async setConfig(input: SetCheckinConfigInput): Promise<CheckinConfig> {
    this.validate(input);
    this.invalidate();
    const set = this.deps.config.set.bind(this.deps.config);
    if (input.enabled !== undefined) set(CHECKIN_CONFIG_KEYS.enabled, input.enabled);
    if (input.cadence !== undefined) set(CHECKIN_CONFIG_KEYS.cadence, input.cadence.trim());
    if (input.deliveryChannel !== undefined) set(CHECKIN_CONFIG_KEYS.deliveryChannel, input.deliveryChannel.trim());
    if (input.quietHours !== undefined) set(CHECKIN_CONFIG_KEYS.quietHours, input.quietHours.trim());
    await this.syncScheduledJob();
    return this.getConfig();
  }

  async listReceipts(limit?: number): Promise<CheckinReceipt[]> {
    return this.deps.receipts.list(limit);
  }

  /** Wire this service as the automation manager's check-in evaluator, then sync the job. */
  async attach(): Promise<void> {
    this.deps.automation?.attachCheckinEvaluator((job) => this.evaluate('scheduled', job.id));
    // A settings edit made outside setConfig must reach the scheduler too. Syncs are
    // serialized and idempotent, so the extra sync after a setConfig finds the job and
    // does not create a second one.
    if (this.deps.config.subscribe && this.unsubscribers.length === 0 && !this.disposed) {
      // Enabling the automation subsystem later must install a job that could not be created while it was off.
      for (const key of [...Object.values(CHECKIN_CONFIG_KEYS), AUTOMATION_ENABLED_KEY]) {
        this.unsubscribers.push(this.deps.config.subscribe(key, () => { void this.syncScheduledJob(); }));
      }
    }
    await this.syncScheduledJob();
  }

  /**
   * Keep a single kind:'checkin' automation job in step with the config: create
   * it (enabled) when missing, update its cadence, and toggle enabled to match.
   * The automation subsystem must be enabled for a job to exist; when it is off
   * the result is `failed` with the reason, and `attach()` or the next
   * `setConfig` retries. Calls run one at a time so two syncs cannot both see no
   * job and create two.
   */
  syncScheduledJob(): Promise<CheckinScheduleStatus> {
    const run = this.syncChain.then(() => this.syncOnce());
    this.syncChain = run;
    return run;
  }

  private async syncOnce(): Promise<CheckinScheduleStatus> {
    const automation = this.deps.automation;
    if (!automation) return this.schedule = { state: 'not-needed', reason: 'no scheduler is attached' };
    const config = this.getConfig();
    try {
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
      await automation.updateJob(job.id, {
        kind: 'checkin',
        schedule: { kind: 'cron', expression: config.cadence },
        enabled: config.enabled,
      });
      await automation.setEnabled(job.id, config.enabled);
      return this.schedule = config.enabled ? { state: 'scheduled' } : { state: 'not-needed' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('check-in: the schedule was not installed', { error: summarizeError(error) });
      return this.schedule = { state: 'failed', reason: `The check-in schedule was not installed: ${reason}` };
    }
  }

  /**
   * Run one check-in evaluation and record its receipt. Returns the terminal
   * outcome the automation run records. A scheduled run binds the current job
   * revision as well as the check-in config; deletion or ownership changes cannot revive it.
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
      return await this.runEvaluation(trigger, jobId, callerSignal, assertAuthority);
    } finally {
      this.evaluating = false;
    }
  }

  private runEvaluation(trigger: 'scheduled' | 'manual', jobId?: string, callerSignal?: AbortSignal, assertAuthority?: () => void): Promise<AutomationCheckinOutcome> {
    return withConfiguredDecisionModelPolicy(async () => {
      const ranAt = this.now();
      const controller = new AbortController();
      const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
      const revision = this.revision;
      let invalidated = false;
      const unsubscribe = this.deps.config.onDidInvalidate?.(() => { invalidated = true; controller.abort(); });
      this.activeRuns.add(controller);
      const config = this.getConfig();
      let jobRevision: string | undefined;
      const readJob = () => jobId === undefined ? undefined : this.deps.automation?.listJobs().find(job => job.id === jobId);
      let jobIdentity: ReturnType<typeof readJob>;
      const current = () => {
        signal.throwIfAborted();
        decisionModelPolicyState();
        assertAuthority?.();
        if (this.disposed || invalidated || revision !== this.revision || JSON.stringify(this.getConfig()) !== JSON.stringify(config)) {
          invalidated = true;
          controller.abort();
          throw new Error('Check-in configuration or authority changed');
        }
        if (jobId !== undefined) {
          const job = readJob();
          if (!job || job !== jobIdentity || job.kind !== 'checkin' || !job.enabled || job.status !== 'enabled' || !job.source.enabled || JSON.stringify(job) !== jobRevision) {
            invalidated = true;
            controller.abort();
            throw new Error('Scheduled check-in job or ownership changed');
          }
        }
        if (!config.enabled || isQuietHours(this.now(), config.quietHours)) throw new Error('Check-in is no longer eligible');
      };
      let briefingSummary = 'unavailable';
      let judgment: CheckinJudgmentReceipt | undefined;
      let deliveryEntered = false;
      let confirmedDelivery: { readonly deliveryId: string | undefined } | undefined;
      try {
        if (!config.enabled) return await this.record(trigger, ranAt, 'skipped-disabled', 'check-in disabled', {});
        if (isQuietHours(ranAt, config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', 'quiet hours', {});
        if (jobId !== undefined) { jobIdentity = readJob(); jobRevision = JSON.stringify(jobIdentity); }
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
        current();
        deliveryEntered = true;
        const deliveryId = await this.deps.deliverer.deliver(config.deliveryChannel, message, { signal, assertCurrent: current });
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
        const stale = invalidated || revision !== this.revision || JSON.stringify(this.getConfig()) !== JSON.stringify(config);
        if (stale || signal.aborted || this.disposed) {
          return await this.record(trigger, ranAt, stale ? 'skipped-stale' : 'cancelled', briefingSummary, { judgment });
        }
        if (isQuietHours(this.now(), config.quietHours)) return await this.record(trigger, ranAt, 'skipped-quiet-hours', briefingSummary, { judgment });
        if (error instanceof DecisionModelsDisabledError && isClassicOperation() || activateClassicFallback(error)) {
          current();
          return await this.record(trigger, ranAt, 'skipped-decision-models-disabled', briefingSummary, {
            decisionReason: 'Decision models are unavailable; automatic check-in contact and note verification were not completed.', judgment,
          });
        }
        // Refusal and malformed answers remain failures, never an invented semantic no.
        const detail = error instanceof Error ? error.message : String(error);
        return await this.record(trigger, ranAt, 'error', briefingSummary, { error: detail, judgment });
      } finally {
        unsubscribe?.();
        this.activeRuns.delete(controller);
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
    case 'skipped-stale': return { outcome: 'skipped', summary: 'check-in configuration or authority changed' };
    case 'skipped-decision-models-disabled': return { outcome: 'skipped', summary: receipt.decisionReason ?? 'automatic check-ins require decision models' };
    default:
      return { outcome: 'skipped', summary: outcome === 'skipped-quiet-hours' ? 'quiet hours' : 'check-in disabled' };
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
