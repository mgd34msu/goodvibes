import { randomUUID } from 'node:crypto';
import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { getNextAutomationOccurrence, ensureAutomationCronPhase, normalizeCronSchedule, normalizeEverySchedule, validateSchedule, type AutomationScheduleDefinition } from '../automation/schedules.js';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { KnowledgeStore } from './store.js';
import { KnowledgeStoreConflictError } from './store-conflict.js';
import { knowledgeJobRunLifecycle, type KnowledgeJobMode, type KnowledgeJobRecord, type KnowledgeJobRunRecord, type KnowledgeJobStatus, type KnowledgeScheduleRecord } from './types.js';
import { emitKnowledgeJobCompleted, emitKnowledgeJobFailed, emitKnowledgeJobQueued, emitKnowledgeJobStarted } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { isPidAlive } from '../runtime/session-liveness-marker.js';
import { tryAcquireCrossProcessLock } from '../workspace/checkpoint/cross-process-lock.js';

/** The refusal for a job id the scheduler does not know; the daemon answers it 404. */
function unknownKnowledgeJob(id: string): GoodVibesError {
  return new GoodVibesError(`Unknown knowledge job: ${id}`, {
    category: 'not_found', code: 'KNOWLEDGE_JOB_NOT_FOUND', status: 404, source: 'runtime', recoverable: false,
  });
}

/** The refusal for a cancel that cannot stop the run; the daemon answers it 409. */
function runNotCancellable(run: KnowledgeJobRunRecord, reason: string, next: string): GoodVibesError {
  return new GoodVibesError(`Knowledge job run ${run.id} (${run.jobId}) is ${run.status}: ${reason}. ${next}`, {
    category: 'bad_request', code: 'KNOWLEDGE_JOB_RUN_NOT_CANCELLABLE', status: 409, source: 'runtime', recoverable: false,
  });
}

function unknownKnowledgeJobRun(id: string): GoodVibesError {
  return new GoodVibesError(`Unknown knowledge job run: ${id}`, {
    category: 'not_found', code: 'KNOWLEDGE_JOB_RUN_NOT_FOUND', status: 404, source: 'runtime', recoverable: false,
  });
}

/** A deleted default schedule is kept as this marker so start-up does not create it again. */
function isRemovedSchedule(record: KnowledgeScheduleRecord): boolean {
  return typeof record.metadata.removedAt === 'number';
}

/** How long a job run with no live recorded owner must have been outstanding before it is treated as abandoned. */
const INTERRUPTED_RUN_MIN_AGE_MS = 6 * 60 * 60 * 1000;

/** Stamped on every run this process starts, so another process can tell a dead owner's run from a live one's. */
interface KnowledgeJobRunOwner {
  readonly instanceId: string;
  readonly pid: number;
}

function readRunOwner(run: KnowledgeJobRunRecord): KnowledgeJobRunOwner | null {
  const owner = run.metadata.owner;
  if (!owner || typeof owner !== 'object' || Array.isArray(owner)) return null;
  const { instanceId, pid } = owner as Record<string, unknown>;
  return typeof instanceId === 'string' && typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { instanceId, pid } : null;
}

/** Local health checks and rendering do not infer new semantic facts. */
function classicJob(kind: KnowledgeJobRecord['kind']): boolean {
  return kind === 'lint' || kind === 'reindex' || kind === 'refresh-stale' || kind === 'refresh-bookmarks' || kind === 'rebuild-projections';
}
function assertJobPolicy(job: KnowledgeJobRecord): void {
  if (!classicJob(job.kind)) requireDecisionFeature(`knowledge job: ${job.title}`);
}

export interface KnowledgeSchedulingContext {
  readonly store: KnowledgeStore;
  readonly emitIfReady: (
    fn: (bus: RuntimeEventBus, ctx: { readonly traceId: string; readonly sessionId: string; readonly source: string }) => void,
    sessionId?: string,
  ) => void;
  readonly runJobByKind: (
    kind: KnowledgeJobRecord['kind'],
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

export class KnowledgeScheduleService {
  private readonly jobs: readonly KnowledgeJobRecord[];
  private readonly scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private schedulesInitialized = false;
  /**
   * Set by dispose(). Schedule arming is an async path started fire-and-forget
   * from the constructor, so it can still be mid-`await` when a host tears the
   * graph down; without this flag it re-armed bootstrap timers AFTER dispose()
   * had cleared the map, leaving three pending every time a short-lived process
   * composed a graph, answered one question and disposed.
   */
  private disposed = false;
  private readonly initialization: Promise<void>;
  /** Run ids this process started and has not yet settled; never reconciled as interrupted. */
  private readonly inFlightRunIds = new Set<string>();
  /** Runs requested at or after this were requested by this process, whatever the in-flight set says. */
  private readonly startedAt = Date.now();
  private readonly owner: KnowledgeJobRunOwner = Object.freeze({ instanceId: randomUUID(), pid: process.pid });
  /** Held while this process owns schedule execution for the store file; see ownsSchedules(). */
  private scheduleOwnership: (() => void) | null = null;
  /** Reconciles run one at a time; overlapping ones each armed a timer and orphaned the other's. */
  private reconciling: Promise<void> = Promise.resolve();
  /** Schedules whose run is in progress; a timer re-armed meanwhile must not start a second run. */
  private readonly runningSchedules = new Set<string>();
  /**
   * Runs this process has queued or started and not yet finished, by job and
   * input. A second request for the same work (a double click, a retry after a
   * timeout, a schedule firing mid-run) joins it instead of repeating it.
   */
  private readonly activeRuns = new Map<string, {
    readonly jobId: string;
    readonly queued: Promise<KnowledgeJobRunRecord>;
    readonly finished: Promise<void>;
  }>();
  /** One controller per run this process queued and has not settled; cancel and dispose abort it. */
  private readonly runControllers = new Map<string, AbortController>();
  /** Resolves when the run this process queued has settled, by run id. */
  private readonly runSettled = new Map<string, Promise<void>>();

  constructor(private readonly context: KnowledgeSchedulingContext) {
    this.jobs = [
      { id: 'knowledge-lint', kind: 'lint', title: 'Lint Knowledge Store', description: 'Run knowledge health checks and refresh the issue queue.', defaultMode: 'inline', metadata: { category: 'quality' } },
      { id: 'knowledge-reindex', kind: 'reindex', title: 'Reindex Knowledge', description: 'Re-run compile and structured memory sync across the current store.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-refresh-stale', kind: 'refresh-stale', title: 'Refresh Stale Sources', description: 'Recrawl stale, failed, or aging remote sources.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-refresh-bookmarks', kind: 'refresh-bookmarks', title: 'Refresh Bookmarks', description: 'Recrawl bookmark and URL-list sources to refresh summaries and links.', defaultMode: 'background', metadata: { category: 'maintenance' } },
      { id: 'knowledge-sync-browser-history', kind: 'sync-browser-history', title: 'Sync Browser History', description: 'Index local browser history and bookmarks as metadata-first structured knowledge.', defaultMode: 'background', metadata: { category: 'ingest', localOnly: true } },
      { id: 'knowledge-rebuild-projections', kind: 'rebuild-projections', title: 'Rebuild Projections', description: 'Render and materialize the major derived markdown/wiki projections.', defaultMode: 'background', metadata: { category: 'projection' } },
      { id: 'knowledge-semantic-enrichment', kind: 'semantic-enrichment', title: 'Semantic Enrichment', description: 'Extract durable facts, entities, wiki pages, and gaps from indexed sources.', defaultMode: 'background', metadata: { category: 'semantic' } },
      { id: 'knowledge-semantic-self-improvement', kind: 'semantic-self-improvement', title: 'Semantic Self-Improvement', description: 'Classify semantic gaps and repair eligible concrete subjects with corroborated source-backed ingest.', defaultMode: 'background', metadata: { category: 'semantic' } },
      { id: 'knowledge-light-consolidation', kind: 'light-consolidation', title: 'Light Consolidation', description: 'Score recent usage, refresh candidate promotions, and write a deterministic consolidation report.', defaultMode: 'background', metadata: { category: 'consolidation' } },
      { id: 'knowledge-deep-consolidation', kind: 'deep-consolidation', title: 'Deep Consolidation', description: 'Run the full consolidation loop, including high-confidence memory promotion and deterministic reporting.', defaultMode: 'background', metadata: { category: 'consolidation' } },
    ];
    this.initialization = this.initializeSchedules();
    void this.initialization.catch((error) => {
      logger.warn('Knowledge schedule initialization failed', { error: summarizeError(error) });
    });
  }

  /** Completes after bootstrap writes and initial timer reconciliation. */
  whenReady(): Promise<void> { return this.initialization; }

  private async readyForMutation(): Promise<void> {
    await this.initialization;
    if (this.disposed) throw new Error('Knowledge scheduler is closed');
  }

  listJobs(): readonly KnowledgeJobRecord[] {
    return this.jobs;
  }

  getJob(id: string): KnowledgeJobRecord | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }

  async saveSchedule(input: {
    readonly id?: string | undefined;
    readonly jobId: string;
    readonly label?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly schedule: AutomationScheduleDefinition;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<KnowledgeScheduleRecord> {
    await this.readyForMutation();
    const job = this.getJob(input.jobId);
    if (!job) throw unknownKnowledgeJob(input.jobId);
    if (input.enabled ?? true) assertJobPolicy(job);
    const previous = input.id ? this.context.store.getSchedule(input.id) : null;
    const schedule = ensureAutomationCronPhase(input.schedule, previous?.schedule);
    // Checked whether or not it is enabled now: a disabled schedule is stored to be enabled later.
    try {
      validateSchedule(schedule);
    } catch (error) {
      throw new GoodVibesError(`Invalid schedule: ${error instanceof Error ? error.message : String(error)}`, {
        category: 'bad_request', code: 'INVALID_SCHEDULE', status: 400, source: 'contract', recoverable: false,
      });
    }
    const wanted = input.enabled ?? true;
    const nextRunAt = wanted ? getNextAutomationOccurrence(schedule, Date.now()) : undefined;
    const record = await this.context.store.upsertSchedule({
      id: input.id,
      jobId: input.jobId,
      label: input.label?.trim() || job.title,
      // A one-time schedule whose time has passed has nothing left to run.
      enabled: wanted && nextRunAt !== undefined,
      schedule,
      nextRunAt: nextRunAt ?? null,
      metadata: {
        ...(input.metadata ?? {}),
        // Saving over a deleted default brings it back.
        ...(previous && isRemovedSchedule(previous) ? { removedAt: undefined } : {}),
      },
    });
    await this.reconcileSchedules();
    return record;
  }

  /** Schedules a person or agent can see; a deleted default is kept only as a marker. */
  listSchedules(limit = 100): readonly KnowledgeScheduleRecord[] {
    return this.context.store.listSchedules(limit + 8).filter((record) => !isRemovedSchedule(record)).slice(0, limit);
  }

  getSchedule(id: string): KnowledgeScheduleRecord | null {
    const record = this.context.store.getSchedule(id);
    return record && !isRemovedSchedule(record) ? record : null;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    await this.readyForMutation();
    const schedule = this.getSchedule(id);
    if (!schedule) return false;
    this.clearScheduleTimer(id);
    if (schedule.metadata.bootstrap === true) {
      // Start-up creates a missing default schedule; keeping a disabled marker is
      // what makes the owner's delete stick across restarts.
      await this.context.store.upsertSchedule({
        id: schedule.id,
        jobId: schedule.jobId,
        label: schedule.label,
        enabled: false,
        schedule: schedule.schedule,
        lastRunAt: schedule.lastRunAt,
        nextRunAt: null,
        metadata: { ...schedule.metadata, removedAt: Date.now() },
      });
      return true;
    }
    return this.context.store.deleteSchedule(id);
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    await this.readyForMutation();
    const schedule = this.getSchedule(id);
    if (!schedule) return null;
    const job = this.getJob(schedule.jobId);
    if (enabled && job) assertJobPolicy(job);
    const nextRunAt = enabled ? getNextAutomationOccurrence(schedule.schedule, Date.now()) : undefined;
    const updated = await this.context.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled: enabled && nextRunAt !== undefined,
      schedule: schedule.schedule,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: nextRunAt ?? null,
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
    return updated;
  }

  /**
   * Stops a queued or running job this process started: its signal is aborted
   * and the run is settled `failed` with the cancel reason at once. A run another
   * process owns, or one that already settled, is refused with what to do instead.
   */
  async cancelJobRun(runId: string): Promise<KnowledgeJobRunRecord> {
    const run = this.context.store.getJobRun(runId);
    if (!run) throw unknownKnowledgeJobRun(runId);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw runNotCancellable(run, 'it has already finished', 'Nothing was changed.');
    }
    const controller = this.runControllers.get(runId);
    if (!controller) {
      const owner = readRunOwner(run);
      throw runNotCancellable(run, owner ? `it belongs to process ${owner.pid}` : 'no running process owns it',
        owner ? 'Cancel it from the daemon or terminal that started it.' : 'It is settled as interrupted when the knowledge store next starts.');
    }
    controller.abort(new Error('cancelled: the job run was cancelled by request'));
    await this.runSettled.get(runId);
    return this.context.store.getJobRun(runId) ?? run;
  }

  listJobRuns(limit = 100, jobId?: string): readonly KnowledgeJobRunRecord[] {
    return this.context.store.listJobRuns(limit, jobId);
  }

  async runJob(
    id: string,
    input: {
      readonly mode?: KnowledgeJobMode | undefined;
      readonly sourceIds?: readonly string[] | undefined;
      readonly limit?: number | undefined;
    } = {},
  ): Promise<KnowledgeJobRunRecord> {
    return withConfiguredDecisionModelPolicy(() => this.runOwnedJob(id, input));
  }

  private async runOwnedJob(id: string, input: {
    readonly mode?: KnowledgeJobMode | undefined;
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
  }): Promise<KnowledgeJobRunRecord> {
    if (this.disposed) throw new Error('Knowledge scheduler is closed');
    const job = this.getJob(id);
    if (!job) throw unknownKnowledgeJob(id);
    assertJobPolicy(job);
    const mode = input.mode ?? job.defaultMode;
    const flightKey = JSON.stringify([job.id, [...(input.sourceIds ?? [])].sort(), input.limit ?? null]);
    const active = this.activeRuns.get(flightKey);
    if (active) {
      const joined = await active.queued;
      // An inline caller expects the finished run; a background caller gets the run as it stands.
      if (mode === 'inline') await active.finished;
      return this.context.store.getJobRun(joined.id) ?? joined;
    }
    const finished = Promise.withResolvers<void>();
    const queued = this.queueJobRun(job, mode, input);
    const entry = { jobId: job.id, queued, finished: finished.promise };
    this.activeRuns.set(flightKey, entry);
    const release = (): void => {
      if (this.activeRuns.get(flightKey) === entry) this.activeRuns.delete(flightKey);
      finished.resolve();
    };
    let run: KnowledgeJobRunRecord;
    try {
      run = await queued;
    } catch (error) {
      release();
      throw error;
    }
    this.runSettled.set(run.id, finished.promise);
    void finished.promise.then(() => this.runSettled.delete(run.id));
    if (mode === 'inline') {
      try {
        return await this.executeJobRun(job, run.id, input);
      } finally {
        release();
      }
    }
    queueMicrotask(() => {
      void this.executeJobRun(job, run.id, input).catch((error: unknown) => {
        logger.warn('Queued knowledge job failed before run record completion', {
          jobId: job.id,
          runId: run.id,
          error: summarizeError(error),
        });
      }).finally(release);
    });
    return run;
  }

  private async queueJobRun(
    job: KnowledgeJobRecord,
    mode: KnowledgeJobMode,
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined },
  ): Promise<KnowledgeJobRunRecord> {
    const run = await this.context.store.upsertJobRun({
      jobId: job.id,
      status: 'queued',
      mode,
      requestedAt: Date.now(),
      result: {},
      metadata: {
        ...(input.sourceIds?.length ? { sourceIds: [...input.sourceIds] } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
        owner: { ...this.owner },
      },
    });
    this.inFlightRunIds.add(run.id);
    this.runControllers.set(run.id, new AbortController());
    if (this.disposed) {
      // dispose() settled only the runs it saw; this one was written after.
      await this.settleRun(run.id, 'failed', 'interrupted: the process shut down before this job started');
      this.inFlightRunIds.delete(run.id);
      this.runControllers.delete(run.id);
      throw new Error('Knowledge scheduler is closed');
    }
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobQueued(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode,
    }));
    return run;
  }

  private hasActiveRun(jobId: string): boolean {
    for (const entry of this.activeRuns.values()) if (entry.jobId === jobId) return true;
    return false;
  }

  /**
   * Stops timers at once, then settles every run this process still has in
   * flight as failed: once the store closes, nothing can finish them, and on
   * disk they would read as running until another process noticed. Callers that
   * close the store must await this first.
   */
  dispose(): Promise<void> {
    const first = !this.disposed;
    this.disposed = true;
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
    if (!first) return Promise.resolve();
    this.releaseScheduleOwnership();
    const interrupted = [...this.inFlightRunIds];
    // The jobs stop calling the model and writing; their runs settle as interrupted below.
    for (const controller of this.runControllers.values()) {
      controller.abort(new Error('interrupted: the process shut down before this job finished'));
    }
    return (async () => {
      for (const runId of interrupted) await this.settleRun(runId, 'failed', 'interrupted: the process shut down before this job finished');
    })();
  }

  /**
   * Several processes open the same store file (a terminal next to its daemon,
   * two terminals in one home). Each would arm the same persisted schedules and
   * run every job once per process, so one process at a time executes them: it
   * holds a lock file beside the store for its lifetime, and another process
   * takes over only once the holder's pid is gone.
   */
  private ownsSchedules(): boolean {
    if (this.scheduleOwnership) return true;
    if (this.disposed) return false;
    try {
      this.scheduleOwnership = tryAcquireCrossProcessLock(`${this.context.store.storagePath}.schedule-owner`);
    } catch (error) {
      logger.warn('Knowledge schedule ownership could not be checked; schedules stay with the current owner', { error: summarizeError(error) });
      return false;
    }
    return this.scheduleOwnership !== null;
  }

  private releaseScheduleOwnership(): void {
    const release = this.scheduleOwnership;
    this.scheduleOwnership = null;
    try { release?.(); } catch (error) {
      logger.warn('Knowledge schedule ownership release failed', { error: summarizeError(error) });
    }
  }

  private async initializeSchedules(): Promise<void> {
    if (this.schedulesInitialized || this.disposed) return;
    this.schedulesInitialized = true;
    await this.context.store.init();
    if (this.disposed) return;
    // Only the schedule owner rewrites schedules and sweeps runs at startup; a
    // second process opening the same file leaves them to it.
    if (this.ownsSchedules()) {
      for (let attempt = 1; ; attempt++) {
        try {
          await this.prepareOwnedSchedules();
          break;
        } catch (error) {
          // Another process saved first; the store has reloaded, so one more
          // pass sees its rows (including any bootstrap schedule it created).
          if (attempt >= 2 || !(error instanceof KnowledgeStoreConflictError) || !error.reloaded) throw error;
        }
      }
      if (this.disposed) return;
    }
    await this.reconcileSchedules();
  }

  private async prepareOwnedSchedules(): Promise<void> {
    await this.settleInterruptedRuns(this.startedAt);
    if (this.disposed) return;
    // Retain current due timestamps while adopting a phase for older cron rows.
    // Publish before any timer can use it so reopening cannot choose another phase.
    for (const record of this.context.store.listSchedules(10_000)) {
      const schedule = ensureAutomationCronPhase(record.schedule);
      if (schedule !== record.schedule) await this.context.store.upsertSchedule({ ...record, schedule });
      if (this.disposed) return;
    }
    await this.ensureBootstrapSchedule('knowledge-light-consolidation', 'Daily Light Consolidation', normalizeEverySchedule('24h'));
    await this.ensureBootstrapSchedule('knowledge-deep-consolidation', 'Weekly Deep Consolidation', normalizeCronSchedule('15 4 * * 0'));
    await this.ensureBootstrapSchedule('knowledge-semantic-self-improvement', 'Continuous Semantic Self-Improvement', normalizeEverySchedule('1h'));
  }

  /**
   * Runs still `queued`/`running` whose owner is gone can never finish, and
   * pruneJobRuns never drops active runs, so they would read as running
   * forever. Settle them as failed. A run stamped with its owner is settled as
   * soon as that owner's process is dead. The instance id is compared first:
   * a run stamped with this process's pid but another instance may belong to
   * another live service here or to a dead process whose pid was recycled, so
   * it falls back to the age rule, as does a run with no owner stamp (older
   * builds).
   */
  private async settleInterruptedRuns(now: number): Promise<void> {
    for (const run of this.context.store.listJobRuns(10_000)) {
      if (run.status !== 'queued' && run.status !== 'running') continue;
      if (this.inFlightRunIds.has(run.id)) continue;
      const owner = readRunOwner(run);
      if (owner?.instanceId === this.owner.instanceId) continue;
      const age = now - Math.max(run.requestedAt, run.startedAt ?? 0);
      if (owner) {
        if ((owner.pid === process.pid || isPidAlive(owner.pid)) && age < INTERRUPTED_RUN_MIN_AGE_MS) continue;
      } else {
        if (run.requestedAt >= this.startedAt) continue;
        if (age < INTERRUPTED_RUN_MIN_AGE_MS) continue;
      }
      await this.settleRun(run.id, 'failed', 'interrupted: the process exited before this job finished');
      if (this.disposed) return;
    }
  }

  /**
   * Moves a run to `status` only when the lifecycle allows it from the store's
   * current state, so a late write can never put a settled run back. Never
   * throws: a store that cannot be written is logged, the caller's own error wins.
   */
  private async settleRun(runId: string, status: KnowledgeJobStatus, error: string): Promise<KnowledgeJobRunRecord | null> {
    try {
      const current = this.context.store.getJobRun(runId);
      if (!current) return null;
      const move = knowledgeJobRunLifecycle.check(current.status, status);
      if (!move.ok) {
        logger.warn('Knowledge job run left as is', { runId, reason: move.reason });
        return current;
      }
      const completedAt = Date.now();
      const settled = await this.context.store.upsertJobRun({
        id: current.id,
        jobId: current.jobId,
        status,
        mode: current.mode,
        completedAt,
        error,
      });
      // The run was announced as queued (and maybe started); close it for event followers.
      if (status === 'failed') {
        try {
          this.context.emitIfReady((bus, ctx) => emitKnowledgeJobFailed(bus, ctx, {
            jobId: settled.jobId,
            runId: settled.id,
            error,
            durationMs: Math.max(0, completedAt - (current.startedAt ?? current.requestedAt)),
          }));
        } catch (emitError) {
          logger.warn('Knowledge job failure event could not be emitted', { runId, error: summarizeError(emitError) });
        }
      }
      return settled;
    } catch (settleError) {
      logger.warn('Knowledge job run could not be settled', { runId, status, error: summarizeError(settleError) });
      return null;
    }
  }

  private async ensureBootstrapSchedule(
    jobId: string,
    label: string,
    schedule: AutomationScheduleDefinition,
  ): Promise<void> {
    const existing = this.context.store.listSchedules(10_000).find((entry) => entry.jobId === jobId && entry.metadata.bootstrap === true);
    if (existing) return;
    schedule = ensureAutomationCronPhase(schedule);
    await this.context.store.upsertSchedule({
      jobId,
      label,
      enabled: true,
      schedule,
      nextRunAt: getNextAutomationOccurrence(schedule, Date.now()),
      metadata: { bootstrap: true },
    });
  }

  private clearScheduleTimer(id: string): void {
    const timer = this.scheduleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.scheduleTimers.delete(id);
    }
  }

  private reconcileSchedules(): Promise<void> {
    const next = this.reconciling.then(() => this.reconcileSchedulesNow());
    this.reconciling = next.catch(() => {});
    return next;
  }

  private async reconcileSchedulesNow(): Promise<void> {
    await this.context.store.init();
    if (this.disposed) return;
    const schedules = this.context.store.listSchedules(10_000);
    const activeIds = new Set(schedules.map((schedule) => schedule.id));
    for (const existing of [...this.scheduleTimers.keys()]) {
      if (!activeIds.has(existing)) this.clearScheduleTimer(existing);
    }
    for (const schedule of schedules) {
      this.clearScheduleTimer(schedule.id);
      if (!schedule.enabled) continue;
      let dueAt = schedule.nextRunAt;
      if (dueAt === undefined) {
        dueAt = getNextAutomationOccurrence(schedule.schedule, Date.now());
        // Only a missing due time is persisted, and only by the owner: rewriting
        // every schedule on each reconcile published a new image that refused
        // every other process's next save.
        if (dueAt !== undefined && this.ownsSchedules()) {
          await this.context.store.upsertSchedule({
            id: schedule.id,
            jobId: schedule.jobId,
            label: schedule.label,
            enabled: schedule.enabled,
            schedule: schedule.schedule,
            lastRunAt: schedule.lastRunAt,
            nextRunAt: dueAt,
            metadata: schedule.metadata,
          });
        }
      }
      // Re-checked after the upsert await: a dispose() that landed mid-loop must
      // not have a timer armed behind it.
      if (dueAt === undefined || this.disposed) continue;
      this.armScheduleTimer(schedule, dueAt);
    }
  }

  private armScheduleTimer(schedule: Pick<KnowledgeScheduleRecord, 'id' | 'jobId'>, dueAt: number): void {
    this.clearScheduleTimer(schedule.id);
    if (this.disposed) return;
    const delay = Math.max(250, Math.min(2_147_483_647, dueAt - Date.now()));
    const timer = setTimeout(() => {
      void this.runScheduledJob(schedule.id).catch((error) => {
        logger.warn('Scheduled knowledge job failed before run record completion', {
          scheduleId: schedule.id,
          jobId: schedule.jobId,
          error: summarizeError(error),
        });
      });
    }, delay);
    timer.unref?.();
    this.scheduleTimers.set(schedule.id, timer);
  }

  private async runScheduledJob(scheduleId: string): Promise<void> {
    this.clearScheduleTimer(scheduleId);
    const schedule = this.context.store.getSchedule(scheduleId);
    if (!schedule?.enabled || this.disposed) return;
    const now = Date.now();
    if (!this.ownsSchedules()) {
      // Stay armed so this process can take over when the owner exits, but
      // never run or rewrite another owner's schedule.
      const following = getNextAutomationOccurrence(schedule.schedule, now);
      if (following !== undefined) this.armScheduleTimer(schedule, following);
      return;
    }
    if (schedule.nextRunAt !== undefined && now < schedule.nextRunAt) {
      // A stale or duplicate timer fired early; the schedule is not due.
      this.armScheduleTimer(schedule, schedule.nextRunAt);
      return;
    }
    if (this.runningSchedules.has(schedule.id)) return;
    this.runningSchedules.add(schedule.id);
    let recorded = false;
    try {
      await this.settleInterruptedRuns(now);
      const job = this.getJob(schedule.jobId);
      // Preserve the saved cadence while semantic jobs are paused by Classic.
      // No run receipt or queued work claims that an omitted job executed.
      // A run of this job still going (queued background runs return at once)
      // is not repeated, and the schedule is not marked as having run.
      const dispatched = !this.hasActiveRun(schedule.jobId) && (!isClassicOperation() || Boolean(job && classicJob(job.kind)));
      let completed = false;
      if (dispatched) {
        const run = await this.runJob(schedule.jobId, { mode: 'background' });
        // The schedule moves on when its run settles, not when it is queued: a run
        // cut short by shutdown leaves the schedule due for the next process.
        await this.runSettled.get(run.id);
        if (this.disposed) return;
        completed = this.context.store.getJobRun(run.id)?.status === 'completed';
      }
      const settledAt = Date.now();
      const following = getNextAutomationOccurrence(schedule.schedule, settledAt);
      await this.context.store.upsertSchedule({
        id: schedule.id,
        jobId: schedule.jobId,
        label: schedule.label,
        // A one-time schedule has no next occurrence: it ran, so it is finished.
        enabled: following !== undefined,
        schedule: schedule.schedule,
        lastRunAt: completed ? settledAt : schedule.lastRunAt,
        nextRunAt: following ?? null,
        metadata: schedule.metadata,
      });
      recorded = true;
    } finally {
      // A failed run or schedule write must not leave the schedule unarmed;
      // arm the next occurrence rather than the stale due time, which would
      // fire again at once.
      this.runningSchedules.delete(schedule.id);
      if (recorded) await this.reconcileSchedules();
      else if (!this.disposed) {
        const following = getNextAutomationOccurrence(schedule.schedule, Date.now());
        if (following !== undefined) this.armScheduleTimer(schedule, following);
      }
    }
  }

  private async executeJobRun(
    job: KnowledgeJobRecord,
    runId: string,
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined; readonly mode?: KnowledgeJobMode | undefined },
  ): Promise<KnowledgeJobRunRecord> {
    try {
      return await this.executeSettledJobRun(job, runId, input);
    } finally {
      this.inFlightRunIds.delete(runId);
      this.runControllers.delete(runId);
    }
  }

  private async executeSettledJobRun(
    job: KnowledgeJobRecord,
    runId: string,
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined; readonly mode?: KnowledgeJobMode | undefined },
  ): Promise<KnowledgeJobRunRecord> {
    const startedAt = Date.now();
    const signal = (this.runControllers.get(runId) ?? new AbortController()).signal;
    if (signal.aborted) {
      // Cancelled while queued: it never starts.
      const settled = await this.settleRun(runId, 'failed', abortReason(signal)) ?? this.context.store.getJobRun(runId);
      if (!settled) throw unknownKnowledgeJobRun(runId);
      return settled;
    }
    let run: KnowledgeJobRunRecord;
    try {
      run = await this.context.store.upsertJobRun({
        id: runId,
        jobId: job.id,
        status: 'running',
        mode: input.mode ?? job.defaultMode,
        startedAt,
      });
    } catch (error) {
      // The run was written `queued`; without this it stays queued forever.
      await this.settleRun(runId, 'failed', summarizeError(error));
      throw error;
    }
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobStarted(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode: run.mode,
    }));
    try {
      assertJobPolicy(job);
      const result = await untilAborted(this.context.runJobByKind(job.kind, input, signal), signal);
      const completedAt = Date.now();
      const current = this.context.store.getJobRun(run.id);
      const move = current ? knowledgeJobRunLifecycle.check(current.status, 'completed') : null;
      if (current && move && !move.ok) {
        // Settled meanwhile (for example as interrupted at shutdown): keep that outcome.
        logger.warn('Knowledge job run already settled; completion not recorded over it', { runId: run.id, reason: move.reason });
        return current;
      }
      run = await this.context.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'completed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        result,
      });
      this.context.emitIfReady((bus, ctx) => emitKnowledgeJobCompleted(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        durationMs: completedAt - startedAt,
      }));
      return run;
    } catch (error) {
      const completedAt = Date.now();
      const current = this.context.store.getJobRun(run.id);
      if (current && !knowledgeJobRunLifecycle.can(current.status, 'failed')) {
        // Already settled (e.g. the completed write landed before it threw): do not overwrite.
        logger.warn('Knowledge job run already settled; failure not recorded over it', { runId: run.id, status: current.status, error: summarizeError(error) });
        return current;
      }
      run = await this.context.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'failed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        error: signal.aborted ? abortReason(signal) : summarizeError(error),
      });
      this.context.emitIfReady((bus, ctx) => emitKnowledgeJobFailed(bus, ctx, {
        jobId: job.id,
        runId: run.id,
        error: run.error ?? 'Knowledge job failed.',
        durationMs: completedAt - startedAt,
      }));
      return run;
    }
  }
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error ? signal.reason.message : 'cancelled: the job run was cancelled';
}

/**
 * The job's result, or a rejection as soon as the signal aborts. Jobs that read
 * the signal stop at their next step; this settles the run at once either way.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
