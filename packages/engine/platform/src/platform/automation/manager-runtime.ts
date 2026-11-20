import type { ExternalOperationSource } from '../permissions/external-request.js';
import type { UnattendedRuns } from './unattended-runs.js';
import { captureAutomationSource } from './action-source.js';
import { ConfigManager } from '../config/manager.js';
import { logger } from '../utils/logger.js';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { AgentManager } from '../tools/agent/index.js';
import { AgentMessageBus } from '../agents/message-bus.js';
import { computeSchedulerCapacity, scheduleCapacityWaitKey, type AutomationCapacityWait, type SchedulerCapacityReport } from './scheduler-capacity.js';
import { AutomationJobStore } from './store/jobs.js';
import { AutomationRunStore } from './store/runs.js';
import { AutomationJobMap, automationJobRevision, ownedAutomationJob, withCurrentSchedulerState, AutomationJobCommitIndeterminateError, AutomationJobMutationStaleError, retainAutomationMutation, type AutomationJobMutationOptions, type RetainedAutomationJobTarget } from './job-mutations.js';
import { AutomationDeliveryManager } from './delivery-manager.js';
import { RouteBindingManager } from '../channels/index.js';
import type { AutomationJob, ManagedAutomationJob } from './jobs.js';
import type { AutomationCheckinEvaluator } from './checkin-execution.js';
import type { AutomationRun, AutomationRunContinuationMode, AutomationRunTelemetry } from './runs.js';
import type { AutomationRunTrigger, AutomationSurfaceKind } from './types.js';
import { SharedSessionBroker } from '../control-plane/index.js';
import type {
  CreateAutomationJobInput,
  SpawnAutomationTaskInput,
  UpdateAutomationJobInput,
} from './manager-runtime-helpers.js';
import {
  applyFailureToJob as applyAutomationFailureToJob,
  executeAutomationJob,
  resolveAutomationExecution,
  resolveRouteForTarget as resolveAutomationRouteForTarget,
  resolveSharedSessionExecution as resolveAutomationSharedSessionExecution,
  syncExecutionRoute as syncAutomationExecutionRoute,
  toResolvedExecution as toAutomationResolvedExecution,
} from './manager-runtime-execution.js';
import {
  formatExternalContentSource,
  normalizeExternalTelemetry,
  normalizeJobRecord,
  normalizeRunRecord,
  normalizeRunTelemetry,
  normalizeSourceRecord,
  sortJobs,
  sortRuns,
} from './manager-runtime-helpers.js';
import {
  advanceScheduledHeartbeatAutomationJob,
  cancelAutomationTimer,
  queueDueHeartbeatAutomationJobs,
  queueHeartbeatWake,
  scheduleAutomationJob,
  type AutomationHeartbeatWake,
} from './manager-runtime-scheduling.js';
import {
  automationFailureAnswer,
  maybeDeliverAutomationFailureNotice,
  maybeDeliverAutomationRun,
  scheduleAutomationFailureFollowUp,
  type AutomationFailureFollowUpContext,
} from './manager-runtime-delivery.js';
import {
  emitAutomationManagerJobAutoDisabled,
  emitAutomationManagerJobCreated,
  emitAutomationManagerJobUpdated,
  emitAutomationManagerRunCompleted,
  emitAutomationManagerRunFailed,
  emitAutomationManagerRunStarted,
} from './manager-runtime-events.js';
import {
  removeAutomationJobFromRuntime,
  syncAutomationJobToRuntime,
  syncAutomationRunToRuntime,
  syncAutomationRuntimeSnapshot,
} from './manager-runtime-sync.js';
import { reconcileAutomationActiveRuns, settleAutomationRun, type AutomationRunSettleContext, type AutomationRunSettlement } from './manager-runtime-reconcile.js';
import { recordAutomationMissedRun } from './manager-runtime-missed.js';
import { summarizeError } from '../utils/error-display.js';
import {
  createAutomationJobRecord,
  toggleAutomationJobEnabled,
  updateAutomationJobRecord,
} from './manager-runtime-job-mutations.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import { GroupJobFamily, type GroupJobItem, type GroupWorkLink } from '../cluster/group-work.js';
import { FenceIssuer } from '../utils/owner-fence.js';
import { OwnedScope, type CloseReport } from '../utils/owned-work.js';

export type {
  CreateAutomationJobInput,
  UpdateAutomationJobInput,
  SpawnAutomationTaskInput,
} from './manager-runtime-helpers.js';
export type { AutomationHeartbeatWake } from './manager-runtime-scheduling.js';

interface AutomationManagerConfig {
  readonly jobStore?: AutomationJobStore | undefined;
  readonly runStore?: AutomationRunStore | undefined;
  readonly spawnTask?: ((input: SpawnAutomationTaskInput) => string) | undefined;
  readonly cancelTask?: ((agentId: string) => void) | undefined;
  readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'> | undefined;
  readonly runtimeStore?: RuntimeStore | undefined;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  readonly deliveryManager?: AutomationDeliveryManager | undefined;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly defaultSurfaceKind?: AutomationSurfaceKind | undefined;
  readonly defaultSurfaceId?: string | undefined;
  /**
   * The live provider registry, when the caller has one wired up. Enables
   * bare model id resolution for job `model`/`fallbackModels` fields
   * (unique -> auto-qualify; ambiguous/unknown -> a rich error naming real
   * candidates). Omitted callers keep the prior format-only validation.
   */
  readonly providerRegistry?: Pick<import('../providers/registry.js').ProviderRegistry, 'listModels'> | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
  /** Where a run's answer goes when its job names no delivery target or every target failed: the owner inbox. */
  readonly unattendedRuns?: UnattendedRuns | undefined;
}

export interface AutomationHeartbeatResult {
  readonly processed: readonly AutomationRun[];
  readonly failed: readonly {
    readonly jobId: string;
    readonly error: string;
  }[];
  readonly pending: readonly AutomationHeartbeatWake[];
  readonly checkedAt: number;
}

export class AutomationManager {
  private readonly jobStore: AutomationJobStore;
  private readonly runStore: AutomationRunStore;
  private readonly spawnTask?: ((input: SpawnAutomationTaskInput) => string) | undefined;
  private readonly cancelTask?: ((agentId: string) => void) | undefined;
  private readonly agentStatusProvider?: Pick<AgentManager, 'getStatus'> | undefined;
  private readonly configManager: ConfigManager;
  private readonly routeBindings: RouteBindingManager;
  private readonly sessionBroker: SharedSessionBroker;
  private readonly defaultSurfaceKind?: AutomationSurfaceKind | undefined;
  private readonly defaultSurfaceId?: string | undefined;
  private readonly providerRegistry?: Pick<import('../providers/registry.js').ProviderRegistry, 'listModels'> | undefined;
  private readonly jobs = new AutomationJobMap();
  private mutationLifetime = {};
  private readonly runs = new Map<string, AutomationRun>();
  /** Running runs read back from disk that the first reconcile pass has not looked at yet. */
  private readonly restoredRunIds = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly heartbeatWakes = new Map<string, AutomationHeartbeatWake>();
  /** Scheduled occurrences and retries put off at the concurrency limit. */
  private readonly capacityWaits = new Map<string, AutomationCapacityWait>();
  private deliveryManager: AutomationDeliveryManager | null;
  private readonly unattendedRuns: UnattendedRuns | undefined;
  private readonly deliveryInFlight = new Set<string>();
  // Attached post-construction by the CheckinService (attachCheckinEvaluator);
  // runs the briefing→judgment→delivery loop for kind:'checkin' jobs.
  private checkinEvaluator?: AutomationCheckinEvaluator | undefined;
  // runtimeDispatch and runtimeBus are wired lazily via attachRuntime() after
  // construction; null-init here avoids a required-constructor-arg dependency.
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly featureFlags: FeatureFlagReader;
  private loaded = false;
  private running = false;
  private startPromise: Promise<void> | null = null;
  /** The mutationLifetime the in-flight startPromise was begun under. */
  private startLifetime: object | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  // Jobs already logged as having no reachable failure-notice target (reported once per job).
  private readonly warnedDeliveryGapJobs = new Set<string>();
  /** The group's copy of the jobs (cluster/group-work.ts), once attached; it acts only while this machine is in a group. */
  private group: GroupJobFamily | null = null;
  /**
   * The runs this manager is starting, owned until their start settles. `stop()` closes it: its fence is retired,
   * so a start still in flight spawns and saves nothing; a later `start()` opens a new one.
   */
  private scope = new OwnedScope('automation manager');
  /** The last stop's close report: what was still starting when the manager stopped. */
  private closing: Promise<CloseReport> | null = null;
  /**
   * The group's automation role as this machine holds it: losing the role moves its epoch, so a run of a shared job
   * started while it was held is refused at its next effect (a job never runs on two machines).
   */
  private readonly roleIssuer = new FenceIssuer('automation role');
  /** The fence of each run being started, by run id, so cancelling the run retires its fence too. */
  private readonly runFences = new Map<string, FenceIssuer>();

  constructor(config: AutomationManagerConfig) {
    this.configManager = config.configManager;
    this.jobStore = config.jobStore ?? new AutomationJobStore({ configManager: this.configManager });
    this.runStore = config.runStore ?? new AutomationRunStore({ configManager: this.configManager });
    this.routeBindings = config.routeBindings;
    this.sessionBroker = config.sessionBroker;
    this.defaultSurfaceKind = config.defaultSurfaceKind;
    this.defaultSurfaceId = config.defaultSurfaceId;
    this.providerRegistry = config.providerRegistry;
    this.agentStatusProvider = config.agentStatusProvider;
    this.spawnTask = config.spawnTask;
    this.cancelTask = config.cancelTask;
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    }
    this.runtimeBus = config.runtimeBus ?? null;
    this.deliveryManager = config.deliveryManager ?? null;
    this.unattendedRuns = config.unattendedRuns;
    this.featureFlags = config.featureFlags ?? null;
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'automation-domain');
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, 'automation-domain', operation);
  }

  private requireSpawnTask(): (input: SpawnAutomationTaskInput) => string {
    if (!this.spawnTask) {
      throw new Error('AutomationManager requires an explicit spawnTask callback.');
    }
    return this.spawnTask;
  }

  private requireCancelTask(): (agentId: string) => void {
    if (!this.cancelTask) {
      throw new Error('AutomationManager requires an explicit cancelTask callback.');
    }
    return this.cancelTask;
  }

  private runtimeExecutionContext() {
    return {
      configManager: this.configManager,
      routeBindings: this.routeBindings,
      sessionBroker: this.sessionBroker,
      defaultSurfaceKind: this.defaultSurfaceKind,
      defaultSurfaceId: this.defaultSurfaceId,
      spawnTask: (input: SpawnAutomationTaskInput) => this.requireSpawnTask()(input),
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      pruneRunHistory: (jobId?: string) => this.pruneRunHistory(jobId),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      syncExecutionRoute: (job: AutomationJob, run: AutomationRun) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run: AutomationRun, source: string) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitRunStarted: (job: AutomationJob, run: AutomationRun) => this.emitRunStarted(job, run),
      emitRunCompleted: (
        job: AutomationJob,
        run: AutomationRun,
        outcome: 'success' | 'partial' | 'failed' | 'cancelled',
        failure?: { readonly error: string; readonly retryable: boolean },
      ) => this.emitRunCompleted(job, run, outcome, failure),
      emitRunFailed: (job: AutomationJob, run: AutomationRun, error: string, retryable: boolean) => emitAutomationManagerRunFailed(this.runtimeBus, job, run, error, retryable),
      maybeDeliverRun: (job: AutomationJob, run: AutomationRun) => this.maybeDeliverRun(job, run),
      followUpStartFailure: (job: AutomationJob, run: AutomationRun, retryable: boolean) => scheduleAutomationFailureFollowUp(this.failureFollowUpContext(), job, run, retryable),
      emitJobAutoDisabled: (job: AutomationJob, reason: string) => this.emitJobAutoDisabled(job, reason),
      cancelTask: this.cancelTask,
      applyFailureToJob: (job: AutomationJob, timestamp: number, countRun = true) => this.applyFailureToJob(job, timestamp, countRun),
      settleRun: (run: AutomationRun, settlement: AutomationRunSettlement, source: string) => settleAutomationRun(this.runSettleContext(), run, settlement, source),
      jobs: this.jobs,
      runs: this.runs,
      checkinEvaluator: this.checkinEvaluator,
    };
  }

  private jobMutationContext() {
    return {
      configManager: this.configManager,
      jobs: this.jobs,
      commitJob: (previous: AutomationJob | undefined, next: AutomationJob, options?: AutomationJobMutationOptions) => this.commitJob(previous, next, options),
      scheduleJob: (job: AutomationJob) => this.scheduleJob(job),
      syncJobToRuntime: (job: AutomationJob, source: string) => this.syncJobToRuntime(job, source),
      emitJobCreated: (job: AutomationJob) => this.emitJobCreated(job),
      emitJobUpdated: (job: AutomationJob, changedFields: string[]) => this.emitJobUpdated(job, changedFields),
      ...(this.providerRegistry ? { listModels: () => this.providerRegistry!.listModels() } : {}),
    };
  }

  private retainJobMutation(options: AutomationJobMutationOptions): () => void {
    const restrictions = retainAutomationMutation(options), lifetime = this.mutationLifetime;
    const current = () => {
      restrictions();
      this.requireEnabled('mutate automation job');
      if (this.mutationLifetime !== lifetime) throw new AutomationJobMutationStaleError();
    };
    current();
    return current;
  }

  /** The revision a job has now, or null when there is no such job. */
  private jobRevision(jobId: string): string | null {
    const job = this.jobs.get(jobId);
    return job ? automationJobRevision(job) : null;
  }

  /**
   * Select a job by the revision its caller read. The returned target stays
   * current for as long as the job's revision does; the scheduler running the
   * job does not move it.
   */
  retainJobTarget(jobId: string, expectedMutationRevision: string): RetainedAutomationJobTarget {
    const selected = this.jobs.get(jobId);
    if (!selected || automationJobRevision(selected) !== expectedMutationRevision) throw new AutomationJobMutationStaleError();
    const lifetime = this.mutationLifetime;
    const assertCurrent = () => {
      this.requireEnabled('update automation job');
      if (this.mutationLifetime !== lifetime || this.jobRevision(jobId) !== expectedMutationRevision) throw new AutomationJobMutationStaleError();
    };
    return Object.freeze({ jobId, revision: expectedMutationRevision, job: selected, assertCurrent });
  }

  private commitJob(previous: AutomationJob | undefined, next: AutomationJob, options?: AutomationJobMutationOptions): Promise<ManagedAutomationJob>;
  private commitJob(previous: AutomationJob, next: null, options?: AutomationJobMutationOptions): Promise<null>;
  private async commitJob(previous: AutomationJob | undefined, next: AutomationJob | null, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const jobId = next?.id ?? previous?.id;
    if (!jobId) throw new Error('An automation mutation requires a job id.');
    const restrictions = retainAutomationMutation(options);
    const lifetime = this.mutationLifetime;
    const expectedRevision = previous ? automationJobRevision(previous) : null;
    // The revision covers the definition only; scheduler state written while
    // this mutation was prepared is carried into the record it commits.
    const live = this.jobs.get(jobId);
    const candidate = next ? ownedAutomationJob(previous && live ? withCurrentSchedulerState(previous, next, live) : next) : null;
    const current = () => {
      restrictions();
      if (this.jobRevision(jobId) !== expectedRevision) throw new AutomationJobMutationStaleError();
    };
    current();
    try {
      await this.jobStore.commit(jobId, expectedRevision, candidate, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
      current();
    } catch (error) {
      // A stale error can mean the jobs file was changed by someone else: the
      // store has re-read it, so this job's in-memory copy is refreshed from it
      // and the caller's next attempt starts from the current revision.
      const reconcile = error instanceof AutomationJobCommitIndeterminateError || error instanceof AutomationJobMutationStaleError;
      if (reconcile && this.jobRevision(jobId) === expectedRevision && this.mutationLifetime === lifetime) {
        // Reconcile the observed bytes, without scheduling or emitting a
        // successful mutation after its authority has gone away.
        const loaded = error instanceof AutomationJobMutationStaleError ? await this.jobStore.load().catch(() => undefined) : await this.jobStore.load();
        const persisted = loaded?.jobs.find(job => job.id === jobId);
        if (loaded && this.jobRevision(jobId) === expectedRevision && this.mutationLifetime === lifetime) {
          if (persisted) this.jobs.restore(persisted);
          else this.jobs.delete(jobId);
        }
      }
      throw error;
    }
    if (!candidate) return null;
    const latest = this.jobs.get(jobId);
    const published = previous && next && latest && latest !== live
      ? ownedAutomationJob(withCurrentSchedulerState(previous, next, latest), candidate.mutationRevision)
      : candidate;
    this.jobs.publish(published);
    await this.publishToGroup([published]).catch((error: unknown) => {
      logger.warn('AutomationManager: a job change could not be written to the group\'s record; the next save tries again', { jobId, error: summarizeError(error) });
    });
    return published;
  }

  /**
   * The one way a job leaves the manager, whoever removes it (an owner, an
   * agent, a one-shot job finishing): its record, timers and queued wakes go,
   * and a run of it still in flight is cancelled rather than left to finish
   * against a job that no longer exists.
   */
  private removeJobRecord(jobId: string, reason: string): void {
    this.cancelTimer(jobId);
    this.heartbeatWakes.delete(jobId);
    for (const [key, wait] of this.capacityWaits) if (wait.jobId === jobId) this.capacityWaits.delete(key);
    for (const [key, timer] of this.retryTimers) {
      if (!key.startsWith(`${jobId}:`)) continue;
      clearTimeout(timer);
      this.retryTimers.delete(key);
    }
    let cancelled = false;
    for (const run of [...this.runs.values()]) {
      if (run.jobId !== jobId || run.status !== 'running') continue;
      // The run is detached from the removed job either way; when its agent
      // cannot be stopped the run record says so.
      let detail = reason;
      try { if (run.agentId) this.requireCancelTask()(run.agentId); }
      catch (error) {
        detail = `${reason}; its agent could not be stopped`;
        logger.warn('AutomationManager: the agent of a removed job\'s run could not be stopped', { jobId, runId: run.id, agentId: run.agentId, error: summarizeError(error) });
      }
      settleAutomationRun(this.runSettleContext(), run, { status: 'cancelled', endedAt: Date.now(), reason: detail }, 'automation.job-removed');
      cancelled = true;
    }
    const removed = this.jobs.get(jobId);
    this.jobs.delete(jobId);
    removeAutomationJobFromRuntime(this.runtimeDispatch, jobId, `automation.${reason}`);
    // Removed in the group, for good: no machine runs or lists it again.
    if (removed && this.sharedWithGroup(removed) && this.group?.shared()) {
      void this.group.remove(jobId, 'automation-manager', reason).catch((error: unknown) => {
        logger.warn('AutomationManager: a job removal could not be written to the group\'s record', { jobId, error: summarizeError(error) });
      });
    }
    if (cancelled) {
      void this.saveRuns().catch((error: unknown) => {
        logger.warn('AutomationManager: run persistence failed', { reason: 'job-removed', jobId, error: summarizeError(error) });
      });
    }
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) {
      this.stop();
      return;
    }
    if (this.running) return;
    // stop() replaces mutationLifetime. A start that was still loading when
    // stop() ran belongs to the lifetime that ended: it must not mark the
    // manager running or arm its timers afterwards, and a start() made after
    // that stop() must not mistake the stale load for its own.
    const lifetime = this.mutationLifetime;
    if (this.startPromise) {
      const pending = this.startPromise, pendingLifetime = this.startLifetime;
      await pending;
      if (pendingLifetime !== lifetime && this.mutationLifetime === lifetime) return await this.start();
      return;
    }
    this.startLifetime = lifetime;
    this.startPromise = this.load()
      .then(() => {
        if (this.mutationLifetime !== lifetime) return;
        this.running = true;
        this.reconcileActiveRuns();
        this.deliverOwedRuns();
        this.reconcileTimer = setInterval(() => {
          this.reconcileActiveRuns();
        }, 2_000);
        this.reconcileTimer.unref?.();
        this.reconcileSchedules();
      })
      .finally(() => {
        this.startPromise = null;
      });
    return await this.startPromise;
  }

  stop(): void {
    this.mutationLifetime = {};
    // Every run still starting is refused at its next effect; the report says what had not settled by the deadline.
    const scope = this.scope;
    this.scope = new OwnedScope('automation manager');
    this.closing = scope.close('automation manager stopped');
    void this.closing.then((report) => {
      if (report.stillRunning.length > 0) logger.warn('AutomationManager: run starts still settling after stop; they save nothing', { stillRunning: report.stillRunning.map((entry) => entry.label) });
    });
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.capacityWaits.clear();
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.running = false;
  }

  /**
   * Attach the check-in evaluator that runs when a `kind: 'checkin'` job fires.
   * Called once by the CheckinService after construction (the service needs the
   * manager to schedule the check-in job, so the manager cannot depend on it at
   * construction). Idempotent-ish: the last attached evaluator wins.
   */
  attachCheckinEvaluator(evaluator: AutomationCheckinEvaluator): void {
    this.checkinEvaluator = evaluator;
  }

  /** The report of the last `stop()`: run starts that ended inside the deadline, and any still settling. */
  closed(): Promise<CloseReport> {
    return this.closing ?? Promise.resolve({ stopped: [], killed: [], stillRunning: [] });
  }

  /**
   * Keep the jobs on the group's record (cluster/group-work.ts). In a group, a
   * job made, changed, disabled or removed on any machine is the same on
   * every machine, and its timer is armed only on the machine holding the
   * automation role. The check-in job is not shared: every machine makes it
   * from the replicated check-in settings and the check-in role decides where
   * it runs. Outside a group this changes nothing.
   */
  attachGroupWork(link: GroupWorkLink): void {
    if (this.group) return;
    const group = new GroupJobFamily(link, 'automation');
    this.group = group;
    group.onRemoteChange((ids, caughtUp) => {
      if (ids.length > 0) this.takeFromGroup(ids);
      // Back in step with the group after being away: arm what it now holds.
      if (caughtUp && group.holdsRole()) this.reconcileSchedules();
    });
    link.roles.onRoleChange('automation', (held) => {
      if (!held) {
        // Runs of shared jobs started while the role was held are refused from here on.
        this.roleIssuer.issue();
        this.dropGroupTimers();
        return;
      }
      // Taken over: start from what the group last wrote, then arm the timers.
      this.takeFromGroup();
      this.reconcileSchedules();
    });
  }

  /** A job the group shares: every job but the check-in, which each machine makes for itself. */
  private sharedWithGroup(job: AutomationJob): boolean {
    return job.kind !== 'checkin';
  }

  /** Whether this machine arms the job's timer: always outside a group, else where the automation role is held. */
  private runsHere(job: AutomationJob): boolean {
    const group = this.group;
    if (!group || !this.sharedWithGroup(job) || !group.shared()) return true;
    return group.holdsRole();
  }

  private groupItem(job: AutomationJob): GroupJobItem {
    const { lastOccurrenceAt, ...definition } = job;
    return { id: job.id, definition: definition as unknown as Readonly<Record<string, unknown>>, lastOccurrenceAt: lastOccurrenceAt ?? 0 };
  }

  /** The job a record entry describes, or null when the entry is not a readable job. */
  private jobFromGroup(item: GroupJobItem): AutomationJob | null {
    const definition = item.definition as unknown as Partial<AutomationJob>;
    if (definition.id !== item.id || typeof definition.mutationRevision !== 'string' || !definition.mutationRevision
      || typeof definition.name !== 'string' || !definition.schedule || typeof definition.schedule !== 'object') return null;
    try {
      const job = normalizeJobRecord(definition as AutomationJob, this.configManager);
      return { ...job, mutationRevision: definition.mutationRevision, ...(item.lastOccurrenceAt > 0 ? { lastOccurrenceAt: item.lastOccurrenceAt } : {}) };
    } catch {
      return null;
    }
  }

  private async publishToGroup(jobs: Iterable<AutomationJob>): Promise<void> {
    const group = this.group;
    if (!group?.shared()) return;
    const items: GroupJobItem[] = [];
    for (const job of jobs) if (this.sharedWithGroup(job)) items.push(this.groupItem(job));
    await group.publish(items);
  }

  /**
   * Take in what the group's record holds: jobs made or changed on another
   * machine, and removals (a removal is terminal, so a machine that slept
   * through one drops the job rather than bringing it back). With `only`,
   * just those jobs; without, every job, and jobs this machine had before it
   * joined go onto the record.
   */
  private takeFromGroup(only?: readonly string[]): void {
    const group = this.group;
    if (!group || !this.loaded || !group.shared()) return;
    const local = new Map<string, GroupJobItem>();
    for (const job of this.jobs.values()) if (this.sharedWithGroup(job)) local.set(job.id, this.groupItem(job));
    const difference = group.difference(local, only);
    for (const id of difference.remove) this.removeJobRecord(id, 'job-removed-in-group');
    for (const item of difference.adopt) {
      const job = this.jobFromGroup(item);
      if (!job) {
        logger.warn('AutomationManager: a job on the group\'s record could not be read; it is left out here', { jobId: item.id });
        continue;
      }
      const existed = this.jobs.has(job.id);
      this.jobs.restore(job);
      group.adopted(item);
      const adopted = this.jobs.get(job.id)!;
      this.syncJobToRuntime(adopted, 'automation.group');
      if (existed) this.emitJobUpdated(adopted, ['group']);
      else this.emitJobCreated(adopted);
      // Re-armed here when this machine runs it; dropped when it no longer does.
      this.scheduleJob(adopted);
    }
    if (difference.remove.length > 0 || difference.adopt.length > 0) {
      void this.saveJobs().catch((error: unknown) => {
        logger.warn('AutomationManager: jobs taken from the group could not be saved here', { error: summarizeError(error) });
      });
    }
    if (difference.seed.length > 0) {
      void group.publish(difference.seed).catch((error: unknown) => {
        logger.warn('AutomationManager: this machine\'s jobs could not be written to the group\'s record; the next save tries again', { error: summarizeError(error) });
      });
    }
  }

  /** The automation role went to another machine: drop every timer of a job the group shares. */
  private dropGroupTimers(): void {
    for (const job of this.jobs.values()) {
      if (!this.sharedWithGroup(job)) continue;
      this.cancelTimer(job.id);
      this.heartbeatWakes.delete(job.id);
      for (const [key, wait] of this.capacityWaits) if (wait.jobId === job.id) this.capacityWaits.delete(key);
      for (const [key, timer] of this.retryTimers) {
        if (!key.startsWith(`${job.id}:`)) continue;
        clearTimeout(timer);
        this.retryTimers.delete(key);
      }
    }
  }

  /**
   * In a group, write the occurrence about to start onto the group's record
   * BEFORE it starts: a holder that dies mid-run leaves the next holder an
   * occurrence it knows was started, so it is neither run twice nor skipped.
   * Null when it must not run here (the record could not be written, or the
   * job was disabled meanwhile); the next reconcile pass tries again.
   */
  private async claimOccurrence(job: AutomationJob): Promise<AutomationJob | null> {
    const group = this.group;
    if (!group || !this.sharedWithGroup(job) || !group.shared()) return job;
    if (!group.holdsRole()) return null;
    const current = this.jobs.get(job.id);
    if (!current?.enabled) return null;
    const plannedAt = Math.max(current.nextRunAt ?? Date.now(), current.lastOccurrenceAt ?? 0);
    try {
      await group.publish([this.groupItem({ ...current, lastOccurrenceAt: plannedAt })]);
    } catch (error) {
      logger.warn('AutomationManager: a scheduled occurrence was not started, because the group\'s record could not be written', { jobId: job.id, error: summarizeError(error) });
      return null;
    }
    if (group.occurrenceOnRecord(job.id) < plannedAt) {
      // Another machine changed the job first; take its version and let the next pass decide.
      this.takeFromGroup([job.id]);
      return null;
    }
    const latest = this.jobs.get(job.id);
    if (!latest?.enabled) return null;
    this.jobs.set(job.id, { ...latest, lastOccurrenceAt: plannedAt });
    return this.jobs.get(job.id) ?? null;
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
    readonly deliveryManager?: AutomationDeliveryManager | null | undefined;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      this.syncRuntimeSnapshot();
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.deliveryManager) {
      this.deliveryManager = config.deliveryManager;
      this.deliveryManager.attachRuntime({
        runtimeStore: config.runtimeStore,
        runtimeBus: config.runtimeBus,
      });
    }
  }

  listJobs(): ManagedAutomationJob[] {
    if (!this.isEnabled()) return [];
    this.reconcileActiveRuns();
    return [...this.jobs.values()].sort((a, b) => a.name.localeCompare(b.name) || a.createdAt - b.createdAt);
  }

  listRuns(jobId?: string): AutomationRun[] {
    if (!this.isEnabled()) return [];
    this.reconcileActiveRuns();
    const runs = jobId
      ? [...this.runs.values()].filter((run) => run.jobId === jobId)
      : this.runs.values();
    return sortRuns(runs);
  }

  listHeartbeatWakes(): AutomationHeartbeatWake[] {
    if (!this.isEnabled()) return [];
    this.queueDueHeartbeatJobs('inspect');
    return [...this.heartbeatWakes.values()].sort((a, b) => a.queuedAt - b.queuedAt || a.jobId.localeCompare(b.jobId));
  }

  getRun(runId: string): AutomationRun | undefined {
    if (!this.isEnabled()) return undefined;
    this.reconcileActiveRuns();
    return this.runs.get(runId);
  }

  getJob(jobId: string): ManagedAutomationJob | undefined {
    if (!this.isEnabled()) return undefined;
    this.reconcileActiveRuns();
    return this.jobs.get(jobId);
  }

  async createJob(input: CreateAutomationJobInput, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob> {
    const current = this.retainJobMutation(options);
    this.requireEnabled('create automation job');
    await this.start();
    current();
    // A create that names its id is repeatable: sent again after a lost reply,
    // or for a job this manager already holds, it returns that job instead of
    // making a second copy.
    const existing = input.id?.trim() ? this.jobs.get(input.id.trim()) : undefined;
    if (existing) return existing;
    return await createAutomationJobRecord(this.jobMutationContext(), input, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
  }

  async removeJob(jobId: string, options: AutomationJobMutationOptions = {}): Promise<boolean> {
    const current = this.retainJobMutation(options);
    this.requireEnabled('remove automation job');
    await this.start();
    current();
    const selected = this.jobs.get(jobId);
    if (!selected) return false;
    await this.commitJob(selected, null, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
    this.removeJobRecord(jobId, 'job-removed');
    return true;
  }

  async setEnabled(jobId: string, enabled: boolean, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const current = this.retainJobMutation(options);
    this.requireEnabled('set automation job enabled state');
    await this.start();
    current();
    const updated = await toggleAutomationJobEnabled(this.jobMutationContext(), jobId, enabled, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
    if (!enabled) this.cancelTimer(jobId);
    return updated;
  }

  async updateJob(jobId: string, patch: UpdateAutomationJobInput, options: AutomationJobMutationOptions = {}): Promise<ManagedAutomationJob | null> {
    const current = this.retainJobMutation(options);
    this.requireEnabled('update automation job');
    await this.start();
    current();
    const selected = this.jobs.get(jobId);
    if (patch.expectedMutationRevision !== undefined && (!selected || automationJobRevision(selected) !== patch.expectedMutationRevision)) throw new AutomationJobMutationStaleError();
    return await updateAutomationJobRecord(this.jobMutationContext(), jobId, patch, { signal: options.signal, assertCurrent: current, withPublication: options.withPublication });
  }

  private readonly sourceClaims = new Set<string>();
  async runNow(jobId: string, operation?: ExternalOperationSource): Promise<AutomationRun> {
    const source = operation ? captureAutomationSource(operation) : undefined;
    this.requireEnabled('run automation job');
    await this.start();
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`Automation job not found: ${jobId}`);
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    source?.assertCurrent();
    if (job.execution.requiresSourceOwner) {
      if (!source) throw new Error('Automation original source owner is unavailable');
      if (this.sourceClaims.has(jobId)) throw new Error('Automation source owner is already claimed');
      this.sourceClaims.add(jobId);
      // A run that started consumes the original source owner's claim. A start
      // that failed did not use it, so it is released for the next attempt.
      try { return await this.executeJob(job, 'manual', false, 1, source); }
      catch (error) { this.sourceClaims.delete(jobId); throw error; }
    }
    return await this.executeJob(job, 'manual', false, 1, source);
  }

  async triggerHeartbeat(_input: { readonly source?: string } = {}): Promise<AutomationHeartbeatResult> {
    this.requireEnabled('trigger automation heartbeat');
    await this.start();
    this.queueDueHeartbeatJobs('heartbeat');
    const queued = this.listHeartbeatWakes();
    const processed: AutomationRun[] = [];
    const failed: Array<{ jobId: string; error: string }> = [];
    for (const wake of queued) {
      if (this.activeRunCount() >= this.maxConcurrentRuns()) break;
      const job = this.jobs.get(wake.jobId);
      // One run of a job at a time, as for timers: the wake stays queued and is
      // processed by a later heartbeat once the running run has finished.
      if (job?.enabled && this.hasRunningRun(job.id)) continue;
      this.heartbeatWakes.delete(wake.jobId);
      if (!job?.enabled) continue;
      try {
        const claimed = wake.trigger === 'scheduled' ? await this.claimOccurrence(job) : job;
        if (!claimed) continue;
        const run = await this.executeJob(claimed, wake.trigger, wake.dueRun, wake.attempt);
        processed.push(run);
        this.advanceScheduledHeartbeatJob(job.id);
      } catch (error) {
        failed.push({
          jobId: wake.jobId,
          error: summarizeError(error),
        });
      }
    }
    return {
      processed,
      failed,
      pending: this.listHeartbeatWakes(),
      checkedAt: Date.now(),
    };
  }

  async retryRun(runId: string): Promise<AutomationRun> {
    this.requireEnabled('retry automation run');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Automation run not found: ${runId}`);
    const job = this.jobs.get(run.jobId);
    if (!job) throw new Error(`Automation job not found: ${run.jobId}`);
    if (run.status !== 'failed' && run.status !== 'cancelled' && run.status !== 'missed') {
      throw new Error(`Automation run ${runId} is ${run.status}; only a failed, cancelled or missed run can be retried. Start a new run of job ${job.id} instead.`);
    }
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    return await this.executeJob(job, 'manual', false, run.attempt + 1);
  }

  async cancelRun(runId: string, reason = 'operator-cancelled'): Promise<AutomationRun | null> {
    this.requireEnabled('cancel automation run');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    const updatedRun = this.cancelRunNow(run, reason);
    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  /** Stop a running run's agent and settle the run as cancelled. */
  private cancelRunNow(run: AutomationRun, reason: string): AutomationRun {
    // A run still starting (a check-in evaluating) is stopped through its fence: it delivers and saves nothing more.
    this.runFences.get(run.id)?.retire(reason);
    if (run.agentId) {
      this.requireCancelTask()(run.agentId);
    }
    return settleAutomationRun(this.runSettleContext(), run, { status: 'cancelled', endedAt: Date.now(), reason }, 'automation.cancel');
  }

  async recordExternalRunResult(
    runId: string,
    input: {
      readonly status: 'completed' | 'failed' | 'cancelled';
      readonly result?: unknown | undefined;
      readonly error?: string | undefined;
      readonly telemetry?: AutomationRunTelemetry | undefined;
      readonly metadata?: Record<string, unknown> | undefined;
    },
  ): Promise<AutomationRun | null> {
    this.requireEnabled('record automation run result');
    await this.start();
    const run = this.runs.get(runId);
    if (!run) return null;
    if (run.status !== 'running') return run;

    const endedAt = Date.now();
    const telemetry = input.telemetry ? normalizeExternalTelemetry(input.telemetry, run, input.metadata) : undefined;
    const updatedRun = settleAutomationRun(this.runSettleContext(), run, input.status === 'completed'
      ? { status: 'completed', endedAt, result: input.result, telemetry }
      : input.status === 'failed'
        ? { status: 'failed', endedAt, error: input.error ?? 'Remote work failed', failure: { error: input.error ?? '' }, telemetry }
        : { status: 'cancelled', endedAt, reason: input.error ?? 'Remote work cancelled', telemetry }, 'automation.external');
    await this.saveRuns();
    await this.saveJobs();
    return updatedRun;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let [jobSnapshot, runSnapshot] = await Promise.all([
      this.jobStore.load(),
      this.runStore.load(),
    ]);
    for (const job of jobSnapshot.jobs) {
      const normalizedJob = normalizeJobRecord(job, this.configManager);
      this.jobs.restore({ ...normalizedJob, mutationRevision: automationJobRevision(job) });
    }
    for (const run of runSnapshot.runs) {
      const normalizedRun = normalizeRunRecord(run, this.jobs.get(run.jobId));
      this.runs.set(normalizedRun.id, normalizedRun);
      if (normalizedRun.status === 'running') this.restoredRunIds.add(normalizedRun.id);
    }
    this.loaded = true;
    this.pruneRunHistory();
    this.syncRuntimeSnapshot();
    this.takeFromGroup();
  }

  private scheduleJob(job: AutomationJob): void {
    scheduleAutomationJob({
      configManager: this.configManager,
      jobs: this.jobs,
      timers: this.timers,
      heartbeatWakes: this.heartbeatWakes,
      capacityWaits: this.capacityWaits,
      running: () => this.running,
      saveJobs: () => this.saveJobs(),
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
      recordMissedRun: (missedJob, plannedRunAt) => this.recordMissedRun(missedJob, plannedRunAt),
      hasRunningRun: (jobId) => this.hasRunningRun(jobId),
      runsHere: (scheduledJob) => this.runsHere(scheduledJob),
      claimOccurrence: (scheduledJob) => this.claimOccurrence(scheduledJob),
    }, job);
  }

  private recordMissedRun(job: AutomationJob, plannedRunAt: number): void {
    recordAutomationMissedRun({
      runs: this.runs,
      saveRuns: () => this.saveRuns(),
      syncRunToRuntime: (run, source) => this.syncRunToRuntime(run, source),
      deliverFailureNotice: (deliveryJob, run) => this.maybeDeliverFailureNotice(deliveryJob, run),
      pruneRunHistory: (jobId) => this.pruneRunHistory(jobId),
    }, job, plannedRunAt);
  }

  /**
   * Reconcile every live job's schedule against the wall clock: mint a `missed`
   * run for any occurrence that slipped past the catch-up window, and (re)arm
   * each timer. Runs at daemon boot and on the reachability heartbeat so drift
   * renders as recorded outcomes, not a user chore. Idempotent per occurrence.
   */
  reconcileSchedules(): void {
    if (!this.running) return;
    for (const job of this.jobs.values()) {
      this.scheduleJob(job);
    }
  }

  private cancelTimer(jobId: string): void {
    cancelAutomationTimer(this.timers, jobId);
  }

  private queueDueHeartbeatJobs(reason: string): void {
    const jobs = this.group?.shared() ? [...this.jobs.values()].filter((job) => this.runsHere(job)) : this.jobs.values();
    queueDueHeartbeatAutomationJobs(jobs, this.heartbeatWakes, reason);
  }

  private advanceScheduledHeartbeatJob(jobId: string): void {
    advanceScheduledHeartbeatAutomationJob(
      {
        jobs: this.jobs,
        saveJobs: () => this.saveJobs(),
      },
      this.timers,
      jobId,
      (job) => this.scheduleJob(job),
    );
  }

  private readonly startingRuns = new Set<symbol>();

  private async executeJob(
    job: AutomationJob,
    trigger: AutomationRunTrigger,
    dueRun: boolean,
    attempt = 1,
    operation?: ExternalOperationSource,
  ): Promise<AutomationRun> {
    if (this.activeRunCount() >= this.maxConcurrentRuns()) {
      throw new Error(`Automation concurrency limit reached (${this.maxConcurrentRuns()})`);
    }
    const reservation = Symbol(job.id);
    this.startingRuns.add(reservation);
    const release = () => { this.startingRuns.delete(reservation); };
    // The run's fence: its own generation, under the manager's scope and, for a job the group shares, the role.
    const issuer = new FenceIssuer(`automation job ${job.id}`);
    const shared = this.group !== null && this.sharedWithGroup(job) && this.group.shared();
    let runId: string | undefined;
    const scope = this.scope;
    try {
      return await scope.run(`run of automation job ${job.id}`, (scopeFence) => {
        const runFence = issuer.issue({ parent: scopeFence.signal });
        const fence = shared ? runFence.narrow({ signal: this.roleIssuer.peek().signal }) : runFence;
        return executeAutomationJob(fence, {
          ...this.runtimeExecutionContext(),
          onRunRecorded: release,
          onRunMinted: (id) => { runId = id; this.runFences.set(id, issuer); },
        }, job, trigger, dueRun, attempt, operation);
      });
    } finally {
      release();
      if (runId !== undefined && this.runFences.get(runId) === issuer) this.runFences.delete(runId);
    }
  }

  private async syncExecutionRoute(job: AutomationJob, run: AutomationRun): Promise<void> {
    await syncAutomationExecutionRoute(this.runtimeExecutionContext(), job, run);
  }

  private applyFailureToJob(job: AutomationJob, timestamp: number, countRun = true): AutomationJob {
    return applyAutomationFailureToJob(job, timestamp, countRun);
  }

  private reconcileActiveRuns(): void {
    if (!this.agentStatusProvider) {
      return;
    }
    reconcileAutomationActiveRuns({
      ...this.runSettleContext(),
      configManager: this.configManager,
      agentStatusProvider: this.agentStatusProvider,
      cancelTask: this.cancelTask,
      restoredRunIds: this.restoredRunIds,
      saveJobs: () => this.saveJobs(),
      saveRuns: () => this.saveRuns(),
      pruneRunHistory: () => this.pruneRunHistory(),
    });
  }

  private runSettleContext(): AutomationRunSettleContext {
    return {
      sessionBroker: this.sessionBroker,
      jobs: this.jobs,
      runs: this.runs,
      syncExecutionRoute: (job, run) => this.syncExecutionRoute(job, run),
      syncRunToRuntime: (run, source) => this.syncRunToRuntime(run, source),
      syncJobToRuntime: (job, source) => this.syncJobToRuntime(job, source),
      emitRunCompleted: (job, run, outcome, failure) => this.emitRunCompleted(job, run, outcome, failure),
      followUp: this.failureFollowUpContext(),
      emitJobAutoDisabled: (job, reason) => this.emitJobAutoDisabled(job, reason),
      maybeDeliverRun: (job, run) => this.maybeDeliverRun(job, run),
      applyFailureToJob: (job, timestamp, countRun) => this.applyFailureToJob(job, timestamp, countRun),
      removeJobRecord: (jobId, reason) => this.removeJobRecord(jobId, reason),
    };
  }

  private async saveJobs(): Promise<void> {
    await this.jobStore.save(sortJobs(this.jobs.values()));
    await this.publishToGroup(this.jobs.values()).catch((error: unknown) => {
      logger.warn('AutomationManager: job state could not be written to the group\'s record; the next save tries again', { error: summarizeError(error) });
    });
  }

  private async saveRuns(): Promise<void> {
    this.pruneRunHistory();
    await this.runStore.save(sortRuns(this.runs.values()));
  }

  private maxConcurrentRuns(): number {
    return Math.max(1, Number(this.configManager.get('automation.maxConcurrentRuns') ?? 4));
  }

  private hasRunningRun(jobId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.jobId === jobId && run.status === 'running') return true;
    }
    return false;
  }

  private activeRunCount(): number {
    let total = this.startingRuns.size;
    for (const run of this.runs.values()) {
      if (run.status === 'running') total += 1;
    }
    return total;
  }

  /**
   * Run slots in use and the work waiting for one: pending heartbeat wakes,
   * and scheduled occurrences and retries put off at the concurrency limit.
   * A wait whose job was disabled, edited to another time or removed, or whose
   * retry was cleared, is dropped here.
   */
  getSchedulerCapacity(): SchedulerCapacityReport {
    const waitingSince: number[] = [];
    for (const wake of this.heartbeatWakes.values()) waitingSince.push(wake.queuedAt);
    for (const [key, wait] of this.capacityWaits) {
      const job = this.jobs.get(wait.jobId);
      const current = wait.kind === 'retry'
        ? this.retryTimers.has(wait.retryKey)
        : key === scheduleCapacityWaitKey(wait.jobId) && job?.enabled === true && job.nextRunAt === wait.nextRunAt;
      if (current) waitingSince.push(wait.since);
      else this.capacityWaits.delete(key);
    }
    return computeSchedulerCapacity(this.maxConcurrentRuns(), this.activeRunCount(), waitingSince);
  }

  private pruneRunHistory(jobId?: string): void {
    const limit = Math.max(1, Number(this.configManager.get('automation.runHistoryLimit') ?? 100));
    const allRuns = sortRuns(this.runs.values());
    const keep = new Set(allRuns.filter((run) => run.status === 'running').map((run) => run.id));
    const runs = allRuns.filter((run) => run.status !== 'running');
    if (jobId) {
      const scoped = runs.filter((run) => run.jobId === jobId).slice(0, limit);
      for (const run of scoped) keep.add(run.id);
      for (const run of runs) {
        if (run.jobId !== jobId) keep.add(run.id);
      }
    } else {
      const grouped = new Map<string, number>();
      for (const run of runs) {
        const count = grouped.get(run.jobId) ?? 0;
        if (count < limit) {
          grouped.set(run.jobId, count + 1);
          keep.add(run.id);
        }
      }
    }
    for (const runId of [...this.runs.keys()]) {
      if (!keep.has(runId)) this.runs.delete(runId);
    }
  }

  private failureFollowUpContext(): AutomationFailureFollowUpContext {
    return {
      jobs: this.jobs,
      retryTimers: this.retryTimers,
      capacityWaits: this.capacityWaits,
      deliveryManager: this.deliveryManager,
      activeRunCount: () => this.activeRunCount(),
      maxConcurrentRuns: () => this.maxConcurrentRuns(),
      executeJob: (scheduledJob, trigger, dueRun, attempt) => this.executeJob(scheduledJob, trigger, dueRun, attempt),
      saveJobs: () => this.saveJobs(),
      scheduleJob: (scheduledJob) => this.scheduleJob(scheduledJob),
      deliverFailureNotice: (failureJob, failureRun) => this.maybeDeliverFailureNotice(failureJob, failureRun),
      emitRunFailed: (failureJob, failureRun, error, retryable) => emitAutomationManagerRunFailed(this.runtimeBus, failureJob, failureRun, error, retryable),
    };
  }

  private maybeDeliverFailureNotice(job: AutomationJob, run: AutomationRun): void {
    maybeDeliverAutomationFailureNotice(this.deliveryManager, job, run, (gapJob, gapRun) => {
      // No target: the notice goes to the owner inbox, so a failed or missed unattended run is never silent.
      if (this.unattendedRuns) {
        void this.unattendedRuns.postToInbox(automationFailureAnswer(gapJob, gapRun));
        return;
      }
      if (this.warnedDeliveryGapJobs.has(gapJob.id)) return;
      this.warnedDeliveryGapJobs.add(gapJob.id);
      logger.warn('AutomationManager: failure notice has no delivery target', { jobId: gapJob.id, jobName: gapJob.name, runId: gapRun.id, status: gapRun.status });
    });
  }

  private syncRuntimeSnapshot(): void {
    syncAutomationRuntimeSnapshot(this.runtimeDispatch, this.jobs.values(), this.runs.values());
  }

  private syncJobToRuntime(job: AutomationJob, source: string): void {
    syncAutomationJobToRuntime(this.runtimeDispatch, job, source);
  }

  private syncRunToRuntime(run: AutomationRun, source: string): void {
    syncAutomationRunToRuntime(this.runtimeDispatch, run, source);
  }

  private emitJobCreated(job: AutomationJob): void {
    emitAutomationManagerJobCreated(this.runtimeBus, job);
  }

  private emitJobUpdated(job: AutomationJob, changedFields: string[]): void {
    emitAutomationManagerJobUpdated(this.runtimeBus, job, changedFields);
  }

  private emitJobAutoDisabled(job: AutomationJob, reason: string): void {
    emitAutomationManagerJobAutoDisabled(this.runtimeBus, job, reason);
  }

  private emitRunStarted(job: AutomationJob, run: AutomationRun): void {
    emitAutomationManagerRunStarted(this.runtimeBus, job, run);
  }

  private emitRunCompleted(
    job: AutomationJob,
    run: AutomationRun,
    outcome: 'success' | 'partial' | 'failed' | 'cancelled',
    failure?: { readonly error: string; readonly retryable: boolean },
  ): void {
    emitAutomationManagerRunCompleted(this.runtimeBus, job, run, outcome, failure);
  }

  /**
   * At start: a run that ended and still owes its answer (the daemon stopped
   * between the run's end and the write that records its delivery) is
   * delivered now, under the same identity as the first attempt. Once per
   * start; a run whose job is gone is logged and left owed.
   */
  private deliverOwedRuns(): void {
    for (const run of [...this.runs.values()]) {
      if (run.delivery?.state !== 'owed' || run.status === 'running' || run.status === 'queued') continue;
      const job = this.jobs.get(run.jobId);
      if (!job) {
        logger.warn('AutomationManager: a run owes its answer but its job is gone; it was not delivered', { runId: run.id, jobId: run.jobId });
        continue;
      }
      this.maybeDeliverRun(job, run);
    }
  }

  private maybeDeliverRun(job: AutomationJob, run: AutomationRun): boolean {
    return maybeDeliverAutomationRun({
      runs: this.runs,
      deliveryInFlight: this.deliveryInFlight,
      deliveryManager: this.deliveryManager,
      unattendedRuns: this.unattendedRuns,
      syncRunToRuntime: (nextRun, source) => this.syncRunToRuntime(nextRun, source),
      saveRuns: () => this.saveRuns(),
      noteJobOutcome: (jobId, outcome) => this.noteJobOutcome(jobId, outcome),
      removeOneShotJob: (jobId) => {
        if (!this.jobs.has(jobId)) return;
        this.removeJobRecord(jobId, 'one-shot-complete');
        void this.saveJobs().catch((error: unknown) => {
          logger.warn('AutomationManager: job persistence failed', { reason: 'one-shot job removed after its delivery', jobId, error: summarizeError(error) });
        });
      },
    }, job, run);
  }

  /** How the last run's answer reached the person, on the job record: one job write per scheduled run, never per turn. */
  private noteJobOutcome(jobId: string, outcome: NonNullable<AutomationJob['lastOutcome']>): void {
    const job = this.jobs.get(jobId);
    if (!job || job.lastOutcome === outcome) return;
    const updated: AutomationJob = { ...job, lastOutcome: outcome };
    this.jobs.set(jobId, updated);
    this.syncJobToRuntime(updated, 'automation.delivery');
    void this.saveJobs().catch((error: unknown) => {
      logger.warn('AutomationManager: job persistence failed', { reason: 'last outcome', jobId, error: summarizeError(error) });
    });
  }
}

