import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { getNextAutomationOccurrence, ensureAutomationCronPhase, normalizeCronSchedule, normalizeEverySchedule, type AutomationScheduleDefinition } from '../automation/schedules.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeJobMode, KnowledgeJobRecord, KnowledgeJobRunRecord, KnowledgeScheduleRecord } from './types.js';
import { emitKnowledgeJobCompleted, emitKnowledgeJobFailed, emitKnowledgeJobQueued, emitKnowledgeJobStarted } from '../runtime/emitters/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';

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
    if (!job) throw new Error(`Unknown knowledge job: ${input.jobId}`);
    if (input.enabled ?? true) assertJobPolicy(job);
    const previous = input.id ? this.context.store.getSchedule(input.id) : null;
    const schedule = ensureAutomationCronPhase(input.schedule, previous?.schedule);
    const nextRunAt = (input.enabled ?? true)
      ? getNextAutomationOccurrence(schedule, Date.now())
      : undefined;
    const record = await this.context.store.upsertSchedule({
      id: input.id,
      jobId: input.jobId,
      label: input.label?.trim() || job.title,
      enabled: input.enabled ?? true,
      schedule,
      nextRunAt,
      metadata: {
        ...(input.metadata ?? {}),
      },
    });
    await this.reconcileSchedules();
    return record;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    await this.readyForMutation();
    const deleted = await this.context.store.deleteSchedule(id);
    this.clearScheduleTimer(id);
    return deleted;
  }

  async setScheduleEnabled(id: string, enabled: boolean): Promise<KnowledgeScheduleRecord | null> {
    await this.readyForMutation();
    const schedule = this.context.store.getSchedule(id);
    if (!schedule) return null;
    const job = this.getJob(schedule.jobId);
    if (enabled && job) assertJobPolicy(job);
    const updated = await this.context.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled,
      schedule: schedule.schedule,
      lastRunAt: schedule.lastRunAt,
      nextRunAt: enabled ? getNextAutomationOccurrence(schedule.schedule, Date.now()) : undefined,
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
    return updated;
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
    const job = this.getJob(id);
    if (!job) throw new Error(`Unknown knowledge job: ${id}`);
    assertJobPolicy(job);
    const mode = input.mode ?? job.defaultMode;
    const run = await this.context.store.upsertJobRun({
      jobId: job.id,
      status: 'queued',
      mode,
      requestedAt: Date.now(),
      result: {},
      metadata: {
        ...(input.sourceIds?.length ? { sourceIds: [...input.sourceIds] } : {}),
        ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      },
    });
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobQueued(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode,
    }));
    if (mode === 'inline') {
      return this.executeJobRun(job, run.id, input);
    }
    queueMicrotask(() => {
      void this.executeJobRun(job, run.id, input).catch((error: unknown) => {
        logger.warn('Queued knowledge job failed before run record completion', {
          jobId: job.id,
          runId: run.id,
          error: summarizeError(error),
        });
      });
    });
    return run;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.scheduleTimers.values()) {
      clearTimeout(timer);
    }
    this.scheduleTimers.clear();
  }

  private async initializeSchedules(): Promise<void> {
    if (this.schedulesInitialized || this.disposed) return;
    this.schedulesInitialized = true;
    await this.context.store.init();
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
    await this.reconcileSchedules();
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

  private async reconcileSchedules(): Promise<void> {
    await this.context.store.init();
    const schedules = this.context.store.listSchedules(10_000);
    const activeIds = new Set(schedules.map((schedule) => schedule.id));
    for (const existing of [...this.scheduleTimers.keys()]) {
      if (!activeIds.has(existing)) this.clearScheduleTimer(existing);
    }
    for (const schedule of schedules) {
      this.clearScheduleTimer(schedule.id);
      if (!schedule.enabled) continue;
      const dueAt = schedule.nextRunAt ?? getNextAutomationOccurrence(schedule.schedule, Date.now());
      const normalized = await this.context.store.upsertSchedule({
        id: schedule.id,
        jobId: schedule.jobId,
        label: schedule.label,
        enabled: schedule.enabled,
        schedule: schedule.schedule,
        lastRunAt: schedule.lastRunAt,
        nextRunAt: dueAt,
        metadata: schedule.metadata,
      });
      // Re-checked after the upsert await: a dispose() that landed mid-loop must
      // not have a timer armed behind it.
      if (!normalized.nextRunAt || this.disposed) continue;
      const delay = Math.max(250, Math.min(2_147_483_647, normalized.nextRunAt - Date.now()));
      const timer = setTimeout(() => {
        void this.runScheduledJob(normalized.id).catch((error) => {
          logger.warn('Scheduled knowledge job failed before run record completion', {
            scheduleId: normalized.id,
            jobId: normalized.jobId,
            error: summarizeError(error),
          });
        });
      }, delay);
      timer.unref?.();
      this.scheduleTimers.set(normalized.id, timer);
    }
  }

  private async runScheduledJob(scheduleId: string): Promise<void> {
    this.clearScheduleTimer(scheduleId);
    const schedule = this.context.store.getSchedule(scheduleId);
    if (!schedule?.enabled) return;
    const now = Date.now();
    const job = this.getJob(schedule.jobId);
    // Preserve the saved cadence while semantic jobs are paused by Classic.
    // No run receipt or queued work claims that an omitted job executed.
    const dispatched = !isClassicOperation() || Boolean(job && classicJob(job.kind));
    if (dispatched) await this.runJob(schedule.jobId, { mode: 'background' });
    await this.context.store.upsertSchedule({
      id: schedule.id,
      jobId: schedule.jobId,
      label: schedule.label,
      enabled: schedule.enabled,
      schedule: schedule.schedule,
      lastRunAt: dispatched ? now : schedule.lastRunAt,
      nextRunAt: getNextAutomationOccurrence(schedule.schedule, now),
      metadata: schedule.metadata,
    });
    await this.reconcileSchedules();
  }

  private async executeJobRun(
    job: KnowledgeJobRecord,
    runId: string,
    input: { readonly sourceIds?: readonly string[] | undefined; readonly limit?: number | undefined; readonly mode?: KnowledgeJobMode | undefined },
  ): Promise<KnowledgeJobRunRecord> {
    const startedAt = Date.now();
    let run = await this.context.store.upsertJobRun({
      id: runId,
      jobId: job.id,
      status: 'running',
      mode: input.mode ?? job.defaultMode,
      startedAt,
    });
    this.context.emitIfReady((bus, ctx) => emitKnowledgeJobStarted(bus, ctx, {
      jobId: job.id,
      runId: run.id,
      mode: run.mode,
    }));
    try {
      assertJobPolicy(job);
      const result = await this.context.runJobByKind(job.kind, input);
      const completedAt = Date.now();
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
      run = await this.context.store.upsertJobRun({
        id: run.id,
        jobId: run.jobId,
        status: 'failed',
        mode: run.mode,
        requestedAt: run.requestedAt,
        startedAt,
        completedAt,
        error: summarizeError(error),
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
