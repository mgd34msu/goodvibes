import { configuredPlanningStoreIdentity } from './configured-project.js';
export class WorkPlanTaskExistsError extends Error {
  constructor(taskId: string) { super(`Work plan task already exists: ${taskId}`); this.name = 'WorkPlanTaskExistsError'; }
}
import { snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { retainConfiguredWorkspace, type ConfigManager } from '../../config/manager.js';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import { acquireWorkPlanRows, WORK_PLAN_ROWS_FILE, workPlanRowsPath, type WorkPlanRows } from './work-plan-rows.js';
import { knowledgeSpaceMetadata, normalizeProjectId } from '../spaces.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from '../types.js';
import type { KnowledgeSourceSnapshot } from '../store-source-generation.js';
import type { KnowledgeStore } from '../store.js';
import type { StoredWorkPlanTask, WorkPlanTaskView, WorkPlanTaskWrite } from '../store-work-plan-tasks.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import type { RuntimeEventBus } from '../../runtime/events/index.js';
import {
  emitWorkPlanSnapshotInvalidated,
  emitWorkPlanTaskCreated,
  emitWorkPlanTaskDeleted,
  emitWorkPlanTaskStatusChanged,
  emitWorkPlanTaskUpdated,
} from '../../runtime/emitters/index.js';
import {
  PROJECT_PLANNING_CONNECTOR_ID,
  PROJECT_PLANNING_TAG,
  type ProjectPlanningArtifactKind,
  projectPlanningArtifactSummary,
  projectPlanningCanonicalUri,
  readPlanningMetadataObject,
  resolveProjectPlanningSpace,
  stablePlanningId,
  withStoredContractId,
} from './helpers.js';
import type {
  ProjectPlanningDecision,
  ProjectPlanningDecisionRecordInput,
  ProjectPlanningDecisionResult,
  ProjectPlanningDecisionsResult,
  ProjectPlanningLanguageArtifact,
  ProjectPlanningLanguageResult,
  ProjectPlanningSpaceInput,
  ProjectPlanningState,
  ProjectPlanningStateResult,
  ProjectPlanningRevision,
  ProjectPlanningStatus,
  ProjectWorkPlanArtifact,
  ProjectWorkPlanClearCompletedInput,
  ProjectWorkPlanCounts,
  ProjectWorkPlanMutationResult,
  ProjectWorkPlanSnapshot,
  ProjectWorkPlanTask,
  ProjectWorkPlanTaskCreateInput,
  ProjectWorkPlanTaskDeleteInput,
  ProjectWorkPlanTaskGetInput,
  ProjectWorkPlanTaskListInput,
  ProjectWorkPlanTaskMutationSource,
  ProjectWorkPlanTaskReorderInput,
  ProjectWorkPlanTaskResult,
  ProjectWorkPlanTaskStatus,
  ProjectWorkPlanTaskStatusInput,
  ProjectWorkPlanTaskUpdateInput,
} from './types.js';
import { nextWorkPlanTaskStatus } from './work-plan.js';

type MutableProjectWorkPlanCounts = {
  -readonly [K in keyof ProjectWorkPlanCounts]: ProjectWorkPlanCounts[K];
};

type WorkPlanTaskCandidate = {
  readonly [K in keyof ProjectWorkPlanTask]?: ProjectWorkPlanTask[K] | undefined;
} & {
  readonly title?: string | undefined;
};

/** How an in-process caller names a task: `matchPrefix` also accepts a unique prefix of its id. */
export interface WorkPlanTaskMatch {
  readonly matchPrefix?: boolean | undefined;
}

export class WorkPlanNotReadyError extends Error {
  constructor() { super('The checklist is still opening; read it again in a moment.'); this.name = 'WorkPlanNotReadyError'; }
}

export interface ProjectPlanningServiceOptions {
  /** Composition-owned startup writes on this same store, before any reading. */
  readonly waitForStartup?: (() => Promise<void>) | undefined;
  readonly defaultProjectId?: string | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /**
   * The work-plan file (work-plan-rows.ts). Composition passes the user's shared
   * one, so every program keeps one plan per project; absent, a file beside the
   * knowledge store (in memory for an in-memory store).
   */
  readonly workPlanRowsPath?: string | undefined;
}

/**
 * Work-plan task status is a CHECKLIST, not a one-way workflow: every state may
 * move to every state, including out of done, failed and cancelled. That is
 * deliberate and relied on: the contract plan sync re-opens a unit's task when
 * a later check finds its work failing (repair/retry), the checklist cycle
 * (`nextWorkPlanTaskStatus`) moves done/failed/cancelled back to pending, and
 * an operator may un-cancel through the status
 * route. Nothing here is final, so no move is refused; declaring the table makes
 * that the answer in code. Narrowing it takes effect at updateWorkPlanTask.
 */
export const projectWorkPlanTaskLifecycle = defineLifecycle<ProjectWorkPlanTaskStatus>('work plan task', {
  pending: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
  in_progress: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
  blocked: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
  done: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
  failed: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
  cancelled: ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'],
});

export class ProjectPlanningService {
  private readonly defaultProjectId: string;
  private readonly waitForStartup: (() => Promise<void>) | undefined;
  private runtimeBus: RuntimeEventBus | null;
  private runtimeBusEpoch = 0;
  /** Set once the store opened and composition startup finished; a synchronous read needs both. */
  private opened = false;
  private readonly planFile: { readonly rows: WorkPlanRows; release(): void };
  /** Plans whose earlier copy in this program's knowledge store was moved into the plan file, or that had none. */
  private readonly movedPlans = new Set<string>();
  /** Plans this program read or edited, with the revision it last saw; compared when another program commits. */
  private readonly seenPlans = new Map<string, { readonly space: WorkPlanSpace; readonly workPlanId: string; revision: number }>();
  private readonly planListeners = new Map<string, Set<() => void>>();
  private stopWatching: (() => void) | null = null;

  /**
   * Native composition. The default project is the configured workspace's:
   * established once, here, from the store createConfiguredPlanningStore built
   * for this workspace. Nothing after composition re-proves it. The work plan
   * is kept in the user's shared plan file, so the terminal app, the Agent and
   * the daemon keep one plan per project.
   */
  static forConfiguredWorkspace(
    store: KnowledgeStore,
    configManager: ConfigManager,
    workingDirectory: string,
    options: Omit<ProjectPlanningServiceOptions, 'defaultProjectId' | 'workPlanRowsPath'> = {},
  ): { readonly service: ProjectPlanningService; readonly projectId: string } {
    if ('defaultProjectId' in options) throw new TypeError('Native planning composition cannot select a default project ID');
    const { projectId } = configuredPlanningStoreIdentity(store, configManager, workingDirectory);
    const workspace = retainConfiguredWorkspace(configManager);
    const service = new ProjectPlanningService(store, {
      defaultProjectId: projectId,
      waitForStartup: options.waitForStartup,
      runtimeBus: options.runtimeBus,
      workPlanRowsPath: workPlanRowsPath(configManager.getHomeDirectory(), workspace.configDirectory),
    });
    return { projectId, service };
  }

  constructor(
    private readonly store: KnowledgeStore,
    options: ProjectPlanningServiceOptions = {},
  ) {
    this.defaultProjectId = normalizeProjectId(options.defaultProjectId ?? 'default');
    this.runtimeBus = options.runtimeBus ?? null;
    this.waitForStartup = options.waitForStartup;
    const storePath = store.storagePath;
    this.planFile = acquireWorkPlanRows(options.workPlanRowsPath
      ?? (isAbsolute(storePath) ? join(dirname(storePath), WORK_PLAN_ROWS_FILE) : ':memory:'));
  }

  /** The file that holds the work plan. */
  get workPlanFile(): string {
    return this.planFile.rows.path;
  }

  private get rows(): WorkPlanRows {
    return this.planFile.rows;
  }

  /** Lets go of the plan file and stops watching it; the knowledge store is closed by its owner. */
  dispose(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.planListeners.clear();
    this.seenPlans.clear();
    this.planFile.release();
  }

  private async initialize(): Promise<void> {
    await this.store.init();
    await this.waitForStartup?.();
    this.opened = true;
  }

  private assertOpened(): void {
    if (this.opened && this.store.isReady) return;
    void this.initialize().catch(() => undefined);
    throw new WorkPlanNotReadyError();
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    this.runtimeBusEpoch += 1;
    this.runtimeBus = runtimeBus ?? null;
    if (this.runtimeBus && this.seenPlans.size > 0) this.watchPlanFile();
  }

  /**
   * Calls `listener` when the plan's revision may have moved: after an edit made
   * through this program, and when another program committed to the plan file
   * and the plan's revision is not the one this program last saw. The listener
   * compares the revision it holds (one indexed statement) and re-reads only when
   * it moved.
   */
  subscribeWorkPlan(input: ProjectPlanningSpaceInput & { readonly workPlanId?: string | undefined }, listener: () => void): () => void {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const key = planKey(space.knowledgeSpaceId, workPlanId);
    let listeners = this.planListeners.get(key);
    if (!listeners) { listeners = new Set(); this.planListeners.set(key, listeners); }
    listeners.add(listener);
    if (!this.seenPlans.has(key)) this.seenPlans.set(key, { space, workPlanId, revision: -1 });
    this.watchPlanFile();
    return () => {
      const current = this.planListeners.get(key);
      current?.delete(listener);
      if (current?.size === 0) this.planListeners.delete(key);
    };
  }

  /** Start noticing other programs' commits once something here would act on them: a bus to announce them on, or a listener. */
  private watchPlanFile(): void {
    if (this.stopWatching) return;
    this.stopWatching = this.rows.onExternalCommit(() => this.noticeExternalCommit());
  }

  /** Another program committed to the plan file: one revision read per plan this program holds, and a notice for each that moved. */
  private noticeExternalCommit(): void {
    for (const [key, seen] of this.seenPlans) {
      let head: { readonly revision: number; readonly updatedAt: number | null };
      try { head = this.rows.read(seen.space.knowledgeSpaceId, seen.workPlanId, (view) => view.head); }
      catch (error) { logger.warn('The work plan could not be read after another program changed it', { error: summarizeError(error) }); continue; }
      if (head.revision === seen.revision) continue;
      seen.revision = head.revision;
      this.emitWorkPlanSnapshotInvalidated(workPlanEvent(seen.space, seen.workPlanId, head.revision), 'changed-elsewhere', head.updatedAt ?? Date.now());
      this.notifyPlan(key);
    }
  }

  private notifyPlan(key: string): void {
    for (const listener of [...(this.planListeners.get(key) ?? [])]) {
      try { listener(); } catch (error) { logger.warn('A work plan listener failed', { error: summarizeError(error) }); }
    }
  }

  /** Remember the revision this program last saw of a plan, so another program's commit is compared against it. */
  private seePlan(space: WorkPlanSpace, workPlanId: string, revision: number): void {
    const key = planKey(space.knowledgeSpaceId, workPlanId);
    const seen = this.seenPlans.get(key);
    if (seen) seen.revision = revision;
    else this.seenPlans.set(key, { space, workPlanId, revision });
    if (this.runtimeBus) this.watchPlanFile();
  }

  /**
   * The first time this program opens a plan, the copy it kept in its own
   * knowledge database before the plan had the shared file (task rows, or a
   * plan stored as one knowledge source) is moved in, once, by whichever program
   * gets there first: in one transaction on the plan file, a task the file
   * already holds is kept when it was written later, and the copy's other tasks
   * go after the plan's own. The copy is then removed from the knowledge
   * database. Every later open is one set lookup; the first open in a program
   * whose copy was already moved is one primary-key read. Needs the knowledge
   * store open.
   */
  private movePlanIn(space: WorkPlanSpace, workPlanId: string): void {
    const key = planKey(space.knowledgeSpaceId, workPlanId);
    if (this.movedPlans.has(key)) return;
    const source = this.store.storagePath;
    if (this.rows.moved(source, space.knowledgeSpaceId, workPlanId)) {
      this.movedPlans.add(key);
      // A copy whose removal failed when the plan moved is removed now, once per program.
      const leftover = this.store.readWorkPlanNow(space.knowledgeSpaceId, workPlanId, (view) => view.tasks().map((row) => row.taskId));
      if (leftover.length > 0) this.removeEarlierCopy(space, workPlanId, leftover, Date.now());
      return;
    }
    const earlier = this.store.readWorkPlanNow(space.knowledgeSpaceId, workPlanId, (view) => {
      const recordIds = new Map(view.tasks().map((row) => [row.taskId, row.recordId] as const));
      return workPlanEditView(space, workPlanId, view).tasks().map((task) => ({ task, recordId: recordIds.get(task.taskId) }));
    });
    const at = Date.now();
    const moved = this.rows.moveIn(source, space.knowledgeSpaceId, workPlanId, (view) => {
      const ownMax = view.maxOrder();
      const offset = ownMax === null ? 0 : ownMax + 1;
      const put: WorkPlanTaskWrite[] = [];
      for (const { task, recordId } of earlier) {
        const stored = view.task(task.taskId)?.task as ProjectWorkPlanTask | undefined;
        if (stored && stored.updatedAt >= task.updatedAt) continue;
        put.push({ ...workPlanTaskWrite({ ...task, order: stored ? stored.order : task.order + offset }), ...(!stored && recordId ? { recordId } : {}) });
      }
      return { value: undefined, put, remove: [], at };
    });
    this.movedPlans.add(key);
    if (!moved || earlier.length === 0) return;
    logger.info('Work plan moved into the shared plan file', { from: source, to: this.rows.path, tasks: earlier.length });
    this.removeEarlierCopy(space, workPlanId, earlier.map(({ task }) => task.taskId), at);
  }

  /** Remove a moved plan's earlier copy from the knowledge database, without waiting; a failure is retried on the next program's first open. */
  private removeEarlierCopy(space: WorkPlanSpace, workPlanId: string, taskIds: readonly string[], at: number): void {
    const remove = [...taskIds];
    void this.store.commitWorkPlan(space.knowledgeSpaceId, workPlanId, () => ({ value: undefined, put: [], remove, at }))
      .catch((error: unknown) => logger.warn('The earlier copy of the work plan could not be removed from the knowledge database; it is no longer read', { error: summarizeError(error) }));
  }

  /** A plan read or edited without waiting: the plan file directly once its earlier copy was moved. */
  private planReadyNow(space: WorkPlanSpace, workPlanId: string): void {
    const key = planKey(space.knowledgeSpaceId, workPlanId);
    if (this.movedPlans.has(key)) return;
    if (this.rows.moved(this.store.storagePath, space.knowledgeSpaceId, workPlanId)) { this.movedPlans.add(key); return; }
    this.assertOpened();
    this.movePlanIn(space, workPlanId);
  }

  async status(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningStatus> {
    await this.initialize();
    const space = this.resolveSpace(input);
    this.movePlanIn(space, 'current');
    const sources = this.sourcesForSpace(space.knowledgeSpaceId);
    // Plans in the plan file, plus any copy in this program's knowledge database
    // not yet moved in. A copy left behind after its plan moved (its removal
    // failed) is no longer read, so it is not counted either.
    const shared = this.rows.count(space.knowledgeSpaceId);
    const rows = { workPlans: shared.workPlans, tasks: shared.tasks };
    for (const [workPlanId, tasks] of await this.store.countWorkPlanTasks(space.knowledgeSpaceId)) {
      if (this.rows.moved(this.store.storagePath, space.knowledgeSpaceId, workPlanId)) continue;
      rows.workPlans += 1;
      rows.tasks += tasks;
    }
    const legacyPlans = sources.filter((source) => artifactKind(source) === 'work-plan');
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      passiveOnly: true,
      counts: {
        states: sources.filter((source) => artifactKind(source) === 'state').length,
        decisions: sources.filter((source) => artifactKind(source) === 'decision').length,
        languageArtifacts: sources.filter((source) => artifactKind(source) === 'language').length,
        workPlans: rows.workPlans + legacyPlans.length,
        workPlanTasks: legacyPlans.reduce((count, source) => count + (readWorkPlan(source)?.tasks?.length ?? 0), rows.tasks),
      },
      capabilities: [
        'project-scoped-storage',
        'historical-planning-records',
        'decision-records',
        'durable-work-plan-tasks',
        'work-plan-transition-events',
        'agent-task-graph-metadata',
        'passive-daemon-only',
      ],
    };
  }

  async getState(input: ProjectPlanningSpaceInput & { readonly planningId?: string | undefined } = {}): Promise<ProjectPlanningStateResult> {
    await this.initialize();
    const space = this.resolveSpace(input);
    const planningId = normalizePlanningId(input.planningId);
    const snapshot = this.getArtifactSnapshot(space.knowledgeSpaceId, 'state', planningId);
    const source = snapshot.source;
    const state = source ? readState(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      state,
      ...(source ? { source, revision: this.planningRevision(snapshot)! } : {}),
    };
  }

  private planningRevision(snapshot: KnowledgeSourceSnapshot): ProjectPlanningRevision | undefined {
    return snapshot.source && snapshot.generation
      ? Object.freeze({ sourceId: snapshot.source.id, generation: snapshot.generation }) : undefined;
  }

  private getArtifactSnapshot(spaceId: string, kind: ProjectPlanningArtifactKind, id: string): KnowledgeSourceSnapshot {
    return this.store.getPlanningSourceSnapshot({ spaceId, kind, artifactId: id });
  }

  async listDecisions(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningDecisionsResult> {
    await this.initialize();
    const space = this.resolveSpace(input);
    const decisions = this.sourcesForSpace(space.knowledgeSpaceId)
      .filter((source) => artifactKind(source) === 'decision')
      .map(readDecision)
      .filter((decision): decision is ProjectPlanningDecision => decision !== null)
      .sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0));
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decisions,
    };
  }

  async recordDecision(input: ProjectPlanningDecisionRecordInput): Promise<ProjectPlanningDecisionResult> {
    input = snapshotJudgmentInput(input) as ProjectPlanningDecisionRecordInput;
    await this.initialize();
    const space = this.resolveSpace(input);
    const observation = planningRowsObservation();
    const title = input.decision.title.trim();
    const matching = input.decision.id === undefined ? this.sourcesForSpace(space.knowledgeSpaceId)
      .filter(source => artifactKind(source) === 'decision').map(readDecision)
      .filter((decision): decision is ProjectPlanningDecision => decision !== null && decision.title === title) : [];
    if (matching.length > 1) throw new Error('Multiple saved decisions have this title; select the exact saved decision ID.');
    // Re-recording by ID updates that decision, so it keeps its creation time and status unless the caller sets them.
    const savedById = input.decision.id === undefined ? null : this.getArtifactSource(space.knowledgeSpaceId, 'decision', input.decision.id);
    observation();
    const previous = matching[0] ?? (savedById ? readDecision(savedById) ?? undefined : undefined), now = Date.now();
    const decision: ProjectPlanningDecision = {
      id: input.decision.id ?? previous?.id ?? `decision-${randomUUID()}`,
      title,
      ...(input.decision.context ? { context: input.decision.context } : {}),
      decision: input.decision.decision.trim(),
      ...(input.decision.alternatives ? { alternatives: [...input.decision.alternatives] } : {}),
      ...(input.decision.reasoning ? { reasoning: input.decision.reasoning } : {}),
      ...(input.decision.consequences ? { consequences: [...input.decision.consequences] } : {}),
      status: input.decision.status ?? previous?.status ?? 'accepted',
      createdAt: input.decision.createdAt ?? previous?.createdAt ?? now,
      updatedAt: now,
      ...(input.decision.metadata ? { metadata: { ...input.decision.metadata } } : {}),
    };
    const source = await this.upsertArtifactSource(space, 'decision', decision.id, decision, observation);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      decision,
      source,
    };
  }

  async getLanguage(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningLanguageResult> {
    await this.initialize();
    const space = this.resolveSpace(input);
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'language', 'current');
    const language = source ? readLanguage(source) : null;
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      language,
      ...(source ? { source } : {}),
    };
  }

  async getWorkPlanSnapshot(input: ProjectWorkPlanTaskListInput = {}): Promise<ProjectWorkPlanSnapshot> {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    await this.planReady(space, workPlanId);
    const snapshot = this.rows.read(space.knowledgeSpaceId, workPlanId, (view) => {
      const plan = workPlanEditView(space, workPlanId, view);
      return snapshotFromTasks(space, workPlanId, plan, {
        status: input.status,
        parentTaskId: input.parentTaskId,
        contractId: input.contractId,
        owner: input.owner,
        limit: input.limit,
      });
    });
    this.seePlan(space, workPlanId, snapshot.revision);
    return snapshot;
  }

  /**
   * The snapshot without waiting, for a caller that cannot await (a modal frame,
   * a synchronous capture). Reads the plan file directly; only the first read of
   * a plan whose earlier copy was never moved in throws `WorkPlanNotReadyError`
   * while the knowledge store is still opening.
   */
  getWorkPlanSnapshotNow(input: ProjectWorkPlanTaskListInput = {}): ProjectWorkPlanSnapshot {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    this.planReadyNow(space, workPlanId);
    const snapshot = this.rows.read(space.knowledgeSpaceId, workPlanId, (view) => snapshotFromTasks(space, workPlanId, workPlanEditView(space, workPlanId, view), {
      status: input.status,
      parentTaskId: input.parentTaskId,
      contractId: input.contractId,
      owner: input.owner,
      limit: input.limit,
    }));
    this.seePlan(space, workPlanId, snapshot.revision);
    return snapshot;
  }

  /** The plan's revision without waiting: one indexed statement on the plan file. */
  getWorkPlanRevisionNow(input: ProjectPlanningSpaceInput & { readonly workPlanId?: string | undefined } = {}): number {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    this.planReadyNow(space, workPlanId);
    return this.rows.read(space.knowledgeSpaceId, workPlanId, (view) => view.head.revision);
  }

  /** The work-ledger import's view of the plan file: the record ids of a project's tasks. */
  listWorkPlanTaskImportIds(projectId: string): readonly string[] {
    return this.rows.recordIds(this.resolveSpace({ projectId }).knowledgeSpaceId);
  }

  /** The work-ledger import's view of one task in the plan file, by record id. */
  readWorkPlanTaskImportRecord(recordId: string): { readonly source: Record<string, unknown> | null; readonly generation: string | null } {
    return this.rows.importRecord(recordId);
  }

  /** Opens the knowledge store when the plan's earlier copy still has to be moved in; otherwise reads nothing. */
  private async planReady(space: WorkPlanSpace, workPlanId: string): Promise<void> {
    const key = planKey(space.knowledgeSpaceId, workPlanId);
    if (this.movedPlans.has(key)) return;
    if (this.rows.moved(this.store.storagePath, space.knowledgeSpaceId, workPlanId)) { this.movedPlans.add(key); return; }
    await this.initialize();
    this.movePlanIn(space, workPlanId);
  }

  /** One task and the plan's revision: one row read (a prefix match, when asked for, is one key range). */
  async getWorkPlanTask(input: ProjectWorkPlanTaskGetInput, match: WorkPlanTaskMatch = {}): Promise<ProjectWorkPlanTaskResult> {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    await this.planReady(space, workPlanId);
    return this.rows.read<ProjectWorkPlanTaskResult>(space.knowledgeSpaceId, workPlanId, (view) => {
      const plan = workPlanEditView(space, workPlanId, view);
      return {
        ok: true,
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        workPlanId,
        revision: plan.revision,
        task: match.matchPrefix ? plan.find(input.taskId) : plan.task(input.taskId),
      };
    });
  }

  async createWorkPlanTask(input: ProjectWorkPlanTaskCreateInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskCreateInput;
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const commit = await this.commitWorkPlan(space, workPlanId, (plan, at) => {
      const explicitOrder = typeof input.task.order === 'number' && Number.isFinite(input.task.order);
      const task = normalizeWorkPlanTask(input.task, {
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        now: at,
        fallbackOrder: explicitOrder ? 0 : plan.nextOrder(),
      });
      if (plan.task(task.taskId)) throw new WorkPlanTaskExistsError(task.taskId);
      return { value: task, put: [task], remove: [] };
    });
    const task = commit.value;
    const event = workPlanEvent(space, workPlanId, commit.revision);
    this.emitWorkPlanTaskCreated(event, task);
    this.emitWorkPlanSnapshotInvalidated(event, 'task-created', commit.updatedAt);
    return { ...mutationResult(space, workPlanId, commit), task };
  }

  async updateWorkPlanTask(input: ProjectWorkPlanTaskUpdateInput, match: WorkPlanTaskMatch = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskUpdateInput;
    const patch = input.patch;
    return this.editWorkPlanTask(input, () => patch, match);
  }

  /**
   * Move a task to the next checklist status (pending, in progress, done, back to
   * pending; blocked, failed and cancelled go to pending), decided from the task as
   * stored in the edit's own transaction.
   */
  async cycleWorkPlanTaskStatus(input: ProjectWorkPlanTaskGetInput & { readonly source?: ProjectWorkPlanTaskMutationSource | undefined }, match: WorkPlanTaskMatch = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as typeof input;
    const source = input.source;
    return this.editWorkPlanTask(input, (previous) => ({ status: nextWorkPlanTaskStatus(previous.status), ...(source ? { source } : {}) }), match);
  }

  private async editWorkPlanTask(
    input: ProjectPlanningSpaceInput & { readonly workPlanId?: string | undefined; readonly taskId: string },
    makePatch: (previous: ProjectWorkPlanTask) => ProjectWorkPlanTaskUpdateInput['patch'],
    match: WorkPlanTaskMatch,
  ): Promise<ProjectWorkPlanMutationResult> {
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const commit = await this.commitWorkPlan(space, workPlanId, (plan, at) => {
      const previousTask = match.matchPrefix ? plan.find(input.taskId) : plan.task(input.taskId);
      if (!previousTask) throw new Error(`Work plan task not found: ${input.taskId}`);
      const patch = makePatch(previousTask);
      // A new status starts a new explanation and completion time: the old reason and
      // completedAt described the previous status.
      const statusChanging = patch.status !== undefined && normalizeWorkPlanStatus(patch.status) !== previousTask.status;
      const carriedMetadata: Record<string, unknown> = { ...(previousTask.metadata ?? {}) };
      if (statusChanging && !('statusReason' in (patch.metadata ?? {}))) delete carriedMetadata.statusReason;
      const task = normalizeWorkPlanTask({
        ...previousTask,
        ...patch,
        ...(statusChanging && patch.completedAt === undefined ? { completedAt: undefined } : {}),
        metadata: {
          ...carriedMetadata,
          ...(patch.metadata ?? {}),
        },
        taskId: previousTask.taskId,
        createdAt: previousTask.createdAt,
        updatedAt: at,
      }, {
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        now: at,
        fallbackOrder: previousTask.order,
      });
      projectWorkPlanTaskLifecycle.assert(previousTask.status, task.status);
      // Nothing changed: no write, no new update time, no change notice.
      if (sameWorkPlanTask(task, previousTask)) return { value: { task: previousTask, previousTask }, put: [], remove: [] };
      return { value: { task, previousTask }, put: [task], remove: [] };
    });
    const { task, previousTask } = commit.value;
    if (commit.changed) {
      const event = workPlanEvent(space, workPlanId, commit.revision);
      this.emitWorkPlanTaskUpdated(event, task, previousTask);
      if (previousTask.status !== task.status) this.emitWorkPlanTaskStatusChanged(event, task, previousTask);
      this.emitWorkPlanSnapshotInvalidated(event, 'task-updated', commit.updatedAt);
    }
    return { ...mutationResult(space, workPlanId, commit), task, previousTask };
  }

  async setWorkPlanTaskStatus(input: ProjectWorkPlanTaskStatusInput, match: WorkPlanTaskMatch = {}): Promise<ProjectWorkPlanMutationResult> {
    // updateWorkPlanTask admits the input once.
    return this.updateWorkPlanTask({
      projectId: input.projectId,
      knowledgeSpaceId: input.knowledgeSpaceId,
      workPlanId: input.workPlanId,
      taskId: input.taskId,
      patch: {
        status: normalizeWorkPlanStatus(input.status),
        ...(input.source ? { source: input.source } : {}),
        metadata: {
          ...(input.reason ? { statusReason: input.reason } : {}),
        },
      },
    }, match);
  }

  /** Writes and announces only the tasks whose position changed. */
  async reorderWorkPlanTasks(input: ProjectWorkPlanTaskReorderInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskReorderInput;
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const commit = await this.commitWorkPlan(space, workPlanId, (plan, at) => {
      const tasks = plan.tasks();
      const byId = new Map(tasks.map((task) => [task.taskId, task]));
      const named = [...new Set(input.orderedTaskIds)];
      for (const taskId of named) {
        if (!byId.has(taskId)) throw new Error(`Work plan task not found: ${taskId}`);
      }
      // The named tasks first, in the given order, then every other task in its
      // current relative order; positions are numbered from 0 and a task is
      // written only when its number changes.
      const namedIds = new Set(named);
      const sequence = [...named.map((taskId) => byId.get(taskId)!),
        ...sortWorkPlanTasks(tasks).filter((task) => !namedIds.has(task.taskId))];
      const moved: { readonly task: ProjectWorkPlanTask; readonly previousTask: ProjectWorkPlanTask }[] = [];
      for (const [order, task] of sequence.entries()) {
        // Only a task that actually moved gets a new update time.
        if (order !== task.order) moved.push({ task: { ...task, order, updatedAt: at }, previousTask: task });
      }
      return { value: moved, put: moved.map((entry) => entry.task), remove: [] };
    });
    if (commit.changed) {
      const event = workPlanEvent(space, workPlanId, commit.revision);
      for (const { task, previousTask } of commit.value) this.emitWorkPlanTaskUpdated(event, task, previousTask);
      this.emitWorkPlanSnapshotInvalidated(event, 'reordered', commit.updatedAt);
    }
    return { ...mutationResult(space, workPlanId, commit), tasks: commit.value.map((entry) => entry.task) };
  }

  async deleteWorkPlanTask(input: ProjectWorkPlanTaskDeleteInput, match: WorkPlanTaskMatch = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskDeleteInput;
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const commit = await this.commitWorkPlan(space, workPlanId, (plan) => {
      const deletedTask = match.matchPrefix ? plan.find(input.taskId) : plan.task(input.taskId);
      if (!deletedTask) throw new Error(`Work plan task not found: ${input.taskId}`);
      return { value: deletedTask, put: [], remove: [deletedTask.taskId] };
    });
    const deletedTask = commit.value;
    const event = workPlanEvent(space, workPlanId, commit.revision);
    this.emitWorkPlanTaskDeleted(event, deletedTask);
    this.emitWorkPlanSnapshotInvalidated(event, 'task-deleted', commit.updatedAt);
    return { ...mutationResult(space, workPlanId, commit), deletedTask };
  }

  async clearCompletedWorkPlanTasks(input: ProjectWorkPlanClearCompletedInput = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanClearCompletedInput;
    const space = this.resolveSpace(input);
    const workPlanId = normalizeWorkPlanId(input.workPlanId);
    const statuses: ProjectWorkPlanTaskStatus[] = [...new Set<ProjectWorkPlanTaskStatus>(input.statuses?.length ? input.statuses.map(normalizeWorkPlanStatus) : ['done'])];
    const commit = await this.commitWorkPlan(space, workPlanId, (plan) => {
      // Reads only the tasks being cleared.
      const cleared = plan.tasks(statuses);
      return { value: cleared, put: [], remove: cleared.map((task) => task.taskId) };
    });
    if (commit.changed) {
      const event = workPlanEvent(space, workPlanId, commit.revision);
      for (const task of commit.value) this.emitWorkPlanTaskDeleted(event, task);
      this.emitWorkPlanSnapshotInvalidated(event, 'cleared-completed', commit.updatedAt);
    }
    return { ...mutationResult(space, workPlanId, commit), clearedTaskIds: commit.value.map((task) => task.taskId) };
  }

  /**
   * One edit of a plan: `decide` runs inside the plan file's immediate
   * transaction against the rows as stored (no other writer can commit in
   * between, in this program or another), so an edit is never built on a stale
   * read and needs no retry. Only the tasks it returns are written.
   */
  private async commitWorkPlan<T>(
    space: WorkPlanSpace,
    workPlanId: string,
    decide: (plan: WorkPlanEditView, at: number) => { readonly value: T; readonly put: readonly ProjectWorkPlanTask[]; readonly remove: readonly string[] },
  ): Promise<WorkPlanCommit<T>> {
    await this.planReady(space, workPlanId);
    let unchanged: { revision: number; updatedAt: number; counts: ProjectWorkPlanCounts } = { revision: 0, updatedAt: 0, counts: countWorkPlanTasks([]) };
    const result = this.rows.commit(space.knowledgeSpaceId, workPlanId, (view) => {
      const plan = workPlanEditView(space, workPlanId, view);
      const at = Date.now();
      const edit = decide(plan, at);
      if (edit.put.length === 0 && edit.remove.length === 0) {
        unchanged = { revision: plan.revision, updatedAt: plan.updatedAt, counts: plan.counts() };
        return { value: edit.value, put: [], remove: [], at };
      }
      // An edit that finishes a task also removes the finished tasks past the
      // bounds, in the same transaction; no other edit pays for it.
      const reclaimFinished = edit.put.some((task) => isFinishedStatus(task.status) && !isFinishedStatus(plan.task(task.taskId)?.status));
      return { value: edit.value, put: edit.put.map(workPlanTaskWrite), remove: edit.remove, at, reclaimFinished };
    });
    if (!result.changed) {
      this.seePlan(space, workPlanId, unchanged.revision);
      return { value: result.value, changed: false, ...unchanged };
    }
    const revision = result.head.revision;
    const reclaimed = (result.reclaimed ?? []).map((row) => row.task as unknown as ProjectWorkPlanTask);
    if (reclaimed.length > 0) {
      const event = workPlanEvent(space, workPlanId, revision);
      for (const task of reclaimed) this.emitWorkPlanTaskDeleted(event, task);
    }
    this.seePlan(space, workPlanId, revision);
    queueMicrotask(() => this.notifyPlan(planKey(space.knowledgeSpaceId, workPlanId)));
    return {
      value: result.value,
      changed: true,
      revision,
      updatedAt: result.head.updatedAt ?? Date.now(),
      counts: countsFromStatuses(result.statusCounts ?? {}),
      reclaimedTaskIds: reclaimed.map((task) => task.taskId),
    };
  }

  private resolveSpace(input: ProjectPlanningSpaceInput = {}) {
    return resolveProjectPlanningSpace(input, this.defaultProjectId);
  }

  private sourcesForSpace(spaceId: string): readonly KnowledgeSourceRecord[] {
    return this.store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => {
      const metadata = source.metadata ?? {};
      return metadata.projectPlanning === true && metadata.knowledgeSpaceId === spaceId;
    });
  }

  private getArtifactSource(
    spaceId: string,
    kind: ProjectPlanningArtifactKind,
    id: string,
  ): KnowledgeSourceRecord | null {
    return this.getArtifactSnapshot(spaceId, kind, id).source;
  }

  private async upsertArtifactSource(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
    observation = planningRowsObservation(),
  ): Promise<KnowledgeSourceRecord> {
    observation();
    const previous = this.getArtifactSnapshot(space.knowledgeSpaceId, kind, id);
    const current = observation;
    let durable = false;
    try {
      const written = await this.store.upsertOwnedCanonicalSources([{
        input: this.artifactSourceInput(space, kind, id, value, previous.source?.id), generation: previous.generation,
      }], () => current(), () => { durable = true; });
      return written[0]!.source!;
    } catch (error) {
      // A committed write must not look like a refused one: a retry would apply it twice.
      if (durable) throw new Error('Planning artifact was published, but its observation retired before the response.', { cause: error });
      throw error;
    }
  }

  private artifactSourceInput(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    kind: ProjectPlanningArtifactKind,
    id: string,
    value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
    sourceId?: string,
  ): KnowledgeSourceUpsertInput {
    const spaceId = space.knowledgeSpaceId;
    return {
      id: sourceId ?? `project-planning-${kind}-${randomUUID()}`,
      connectorId: PROJECT_PLANNING_CONNECTOR_ID,
      sourceType: 'dataset',
      title: titleForArtifact(kind, value),
      canonicalUri: projectPlanningCanonicalUri(spaceId, kind, id),
      summary: projectPlanningArtifactSummary(kind, value),
      tags: [PROJECT_PLANNING_TAG, `project-planning:${kind}`],
      status: 'indexed',
      metadata: knowledgeSpaceMetadata(spaceId, {
        projectPlanning: true,
        planningArtifactKind: kind,
        planningArtifactId: id,
        projectId: space.projectId,
        // Built from input admitted at the call and rows admitted when written.
        value,
      }),
    };
  }

  private emitWorkPlanTaskCreated(event: WorkPlanEvent, task: ProjectWorkPlanTask): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskCreated(this.runtimeBus, workPlanEmitterContext(event), { ...event, task });
  }

  private emitWorkPlanTaskUpdated(event: WorkPlanEvent, task: ProjectWorkPlanTask, previousTask: ProjectWorkPlanTask): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskUpdated(this.runtimeBus, workPlanEmitterContext(event), { ...event, task, previousTask });
  }

  private emitWorkPlanTaskStatusChanged(event: WorkPlanEvent, task: ProjectWorkPlanTask, previousTask: ProjectWorkPlanTask): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskStatusChanged(this.runtimeBus, workPlanEmitterContext(event), {
      ...event,
      taskId: task.taskId,
      status: task.status,
      previousStatus: previousTask.status,
      task,
    });
  }

  private emitWorkPlanTaskDeleted(event: WorkPlanEvent, task: ProjectWorkPlanTask): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskDeleted(this.runtimeBus, workPlanEmitterContext(event), { ...event, taskId: task.taskId, task });
  }

  /** One per committed edit: a snapshot read at an older revision is stale. Carries no tasks. */
  private emitWorkPlanSnapshotInvalidated(event: WorkPlanEvent, reason: string, updatedAt: number): void {
    if (!this.runtimeBus) return;
    emitWorkPlanSnapshotInvalidated(this.runtimeBus, workPlanEmitterContext(event), { ...event, reason, updatedAt });
  }
}

interface WorkPlanSpace {
  readonly projectId: string;
  readonly knowledgeSpaceId: string;
}

interface WorkPlanEvent extends WorkPlanSpace {
  readonly workPlanId: string;
  readonly revision: number;
}

interface WorkPlanCommit<T> {
  readonly value: T;
  readonly changed: boolean;
  readonly revision: number;
  readonly updatedAt: number;
  readonly counts: ProjectWorkPlanCounts;
  /** Finished tasks the edit removed because they were past the bounds. */
  readonly reclaimedTaskIds?: readonly string[] | undefined;
}

function planKey(spaceId: string, workPlanId: string): string {
  return `${spaceId}\u0000${workPlanId}`;
}

/** Done and cancelled: what the automatic removal of finished tasks may remove. */
function isFinishedStatus(status: ProjectWorkPlanTaskStatus | undefined): boolean {
  return status === 'done' || status === 'cancelled';
}

/** A plan as one read or one commit sees it; tasks come from their rows, and from a plan still stored as one source. */
interface WorkPlanEditView {
  readonly revision: number;
  readonly updatedAt: number;
  /** Tasks of a plan still stored as one knowledge source; empty once its first commit wrote them as rows. */
  readonly legacyTasks: readonly ProjectWorkPlanTask[];
  task(taskId: string): ProjectWorkPlanTask | null;
  /** The task with this id, or the one task whose id starts with it; throws when several do. */
  find(taskIdOrPrefix: string): ProjectWorkPlanTask | null;
  tasks(statuses?: readonly ProjectWorkPlanTaskStatus[]): ProjectWorkPlanTask[];
  nextOrder(): number;
  counts(): ProjectWorkPlanCounts;
}

function workPlanEditView(space: WorkPlanSpace, workPlanId: string, view: WorkPlanTaskView): WorkPlanEditView {
  const legacyPlan = view.legacy ? readLegacyWorkPlan(space, workPlanId, view.legacy) : null;
  const legacy = new Map((legacyPlan?.tasks ?? []).map((task) => [task.taskId, task]));
  // Rows were admitted when they were written; they are read as stored.
  const stored = (row: StoredWorkPlanTask): ProjectWorkPlanTask => row.task as unknown as ProjectWorkPlanTask;
  // A task in both places (an older build wrote the source after the rows existed) is read from the newer copy.
  const newer = (row: ProjectWorkPlanTask | null, old: ProjectWorkPlanTask | undefined): ProjectWorkPlanTask | null =>
    !old ? row : !row || old.updatedAt > row.updatedAt ? old : row;
  const task = (taskId: string): ProjectWorkPlanTask | null => {
    const row = view.task(taskId);
    return newer(row ? stored(row) : null, legacy.get(taskId));
  };
  const tasks = (statuses?: readonly ProjectWorkPlanTaskStatus[]): ProjectWorkPlanTask[] => {
    if (legacy.size === 0) return sortWorkPlanTasks(view.tasks(statuses).map(stored));
    const merged = new Map(view.tasks().map((row) => [row.taskId, stored(row)] as const));
    for (const [taskId, old] of legacy) merged.set(taskId, newer(merged.get(taskId) ?? null, old)!);
    return sortWorkPlanTasks([...merged.values()].filter((task) => !statuses || statuses.includes(task.status)));
  };
  return {
    revision: view.head.revision,
    updatedAt: Math.max(view.head.updatedAt ?? 0, legacyPlan?.updatedAt ?? 0) || Date.now(),
    legacyTasks: [...legacy.values()],
    task,
    find: (taskIdOrPrefix) => {
      const needle = taskIdOrPrefix.trim();
      if (!needle) throw new Error('Work plan task id is required.');
      const exact = task(needle);
      if (exact) return exact;
      const ids = new Set(view.taskIdsWithPrefix(needle, 8));
      for (const taskId of legacy.keys()) if (taskId.startsWith(needle)) ids.add(taskId);
      if (ids.size > 1) throw new Error(`Work plan task id "${needle}" is ambiguous: ${[...ids].sort().join(', ')}`);
      const [only] = ids;
      return only ? task(only) : null;
    },
    counts: () => legacy.size > 0 ? countWorkPlanTasks(tasks()) : countsFromStatuses(view.statusCounts()),
    tasks,
    nextOrder: () => {
      let max = view.maxOrder() ?? -1;
      for (const task of legacy.values()) max = Math.max(max, task.order);
      return max + 1;
    },
  };
}

function readLegacyWorkPlan(space: WorkPlanSpace, workPlanId: string, source: KnowledgeSourceRecord): ProjectWorkPlanArtifact | null {
  const value = readWorkPlan(source);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? normalizeWorkPlanArtifact(value as Partial<ProjectWorkPlanArtifact>, space, workPlanId)
    : null;
}

function workPlanTaskWrite(task: ProjectWorkPlanTask): WorkPlanTaskWrite {
  return { taskId: task.taskId, status: task.status, order: task.order, task };
}

function workPlanEvent(space: WorkPlanSpace, workPlanId: string, revision: number): WorkPlanEvent {
  return { projectId: space.projectId, knowledgeSpaceId: space.knowledgeSpaceId, workPlanId, revision };
}

function mutationResult(space: WorkPlanSpace, workPlanId: string, commit: WorkPlanCommit<unknown>) {
  return {
    ok: true as const,
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    workPlanId,
    changed: commit.changed,
    revision: commit.revision,
    updatedAt: commit.updatedAt,
    counts: commit.counts,
    ...(commit.reclaimedTaskIds?.length ? { reclaimedTaskIds: commit.reclaimedTaskIds } : {}),
  };
}

function normalizeWorkPlanArtifact(
  input: Partial<ProjectWorkPlanArtifact>,
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlanId: string,
): ProjectWorkPlanArtifact {
  const now = Date.now();
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : now;
  const tasks = Array.isArray(input.tasks)
    ? input.tasks.map((task, index) => normalizeWorkPlanTask(withStoredContractId(task), {
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      now,
      fallbackOrder: index,
    }))
    : [];
  return {
    id: normalizeWorkPlanId(input.id ?? workPlanId),
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    tasks: sortWorkPlanTasks(tasks),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now,
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

function normalizeWorkPlanTask(
  input: WorkPlanTaskCandidate,
  options: {
    readonly projectId: string;
    readonly knowledgeSpaceId: string;
    readonly now: number;
    readonly fallbackOrder: number;
  },
): ProjectWorkPlanTask {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new Error('Work plan task title is required.');
  const status = normalizeWorkPlanStatus(input.status ?? 'pending');
  const createdAt = typeof input.createdAt === 'number' ? input.createdAt : options.now;
  return {
    taskId: normalizeWorkPlanTaskId(input.taskId ?? `task-${randomUUID().slice(0, 12)}`),
    projectId: options.projectId,
    knowledgeSpaceId: options.knowledgeSpaceId,
    title,
    ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
    ...(typeof input.owner === 'string' && input.owner.trim() ? { owner: input.owner.trim() } : {}),
    status,
    ...(typeof input.priority === 'number' && Number.isFinite(input.priority) ? { priority: input.priority } : {}),
    order: typeof input.order === 'number' && Number.isFinite(input.order) ? input.order : options.fallbackOrder,
    ...(typeof input.source === 'string' && input.source.trim() ? { source: input.source.trim() } : {}),
    tags: stringList(input.tags),
    ...(typeof input.parentTaskId === 'string' && input.parentTaskId.trim() ? { parentTaskId: normalizeWorkPlanTaskId(input.parentTaskId) } : {}),
    ...(typeof input.contractId === 'string' && input.contractId.trim() ? { contractId: input.contractId.trim() } : {}),
    ...(typeof input.phaseId === 'string' && input.phaseId.trim() ? { phaseId: input.phaseId.trim() } : {}),
    ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    ...(typeof input.sessionId === 'string' && input.sessionId.trim() ? { sessionId: input.sessionId.trim() } : {}),
    ...(typeof input.turnId === 'string' && input.turnId.trim() ? { turnId: input.turnId.trim() } : {}),
    ...(typeof input.decisionId === 'string' && input.decisionId.trim() ? { decisionId: input.decisionId.trim() } : {}),
    ...(typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim() ? { sourceMessageId: input.sourceMessageId.trim() } : {}),
    linkedArtifactIds: stringList(input.linkedArtifactIds),
    linkedSourceIds: stringList(input.linkedSourceIds),
    linkedNodeIds: stringList(input.linkedNodeIds),
    ...(typeof input.originSurface === 'string' && input.originSurface.trim() ? { originSurface: input.originSurface.trim() } : {}),
    createdAt,
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : options.now,
    ...(status === 'done' || status === 'failed' || status === 'cancelled'
      ? { completedAt: typeof input.completedAt === 'number' ? input.completedAt : options.now }
      : {}),
    ...(input.metadata ? { metadata: readPlanningMetadataObject(input.metadata) } : {}),
  };
}

/** Two versions of a task say the same, apart from when they were written. */
function sameWorkPlanTask(left: ProjectWorkPlanTask, right: ProjectWorkPlanTask): boolean {
  // An absent metadata object and an empty one say the same.
  const comparable = (task: ProjectWorkPlanTask) => JSON.stringify({ ...task, updatedAt: 0, metadata: task.metadata && Object.keys(task.metadata).length > 0 ? task.metadata : null });
  return comparable(left) === comparable(right);
}

function normalizeWorkPlanId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('work-plan', value)
    : 'current';
}

function normalizeWorkPlanTaskId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('task', value)
    : `task-${randomUUID().slice(0, 12)}`;
}

function normalizeWorkPlanStatus(value: unknown): ProjectWorkPlanTaskStatus {
  if (
    value === 'pending'
    || value === 'in_progress'
    || value === 'blocked'
    || value === 'done'
    || value === 'failed'
    || value === 'cancelled'
  ) {
    return value;
  }
  if (value === 'in-progress') return 'in_progress';
  if (value === 'completed') return 'done';
  throw new Error(`Invalid work plan task status: ${String(value)}`);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim()))];
}

function sortWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanTask[] {
  return [...tasks].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

function snapshotFromTasks(
  space: WorkPlanSpace,
  workPlanId: string,
  plan: WorkPlanEditView,
  filter: {
    readonly status?: ProjectWorkPlanTaskStatus | undefined;
    readonly parentTaskId?: string | undefined;
    readonly contractId?: string | undefined;
    readonly owner?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): ProjectWorkPlanSnapshot {
  const all = plan.tasks();
  const tasks = all.filter((task) => {
    if (filter.status && task.status !== filter.status) return false;
    if (filter.parentTaskId && task.parentTaskId !== filter.parentTaskId) return false;
    if (filter.contractId && task.contractId !== filter.contractId) return false;
    if (filter.owner && task.owner !== filter.owner) return false;
    return true;
  });
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.floor(filter.limit)
    : undefined;
  return {
    ok: true,
    projectId: space.projectId,
    knowledgeSpaceId: space.knowledgeSpaceId,
    workPlanId,
    revision: plan.revision,
    tasks: limit ? tasks.slice(0, limit) : tasks,
    counts: countWorkPlanTasks(all),
    updatedAt: plan.updatedAt,
  };
}

function countWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanCounts {
  const counts: MutableProjectWorkPlanCounts = {
    total: tasks.length,
    pending: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    counts[task.status] += 1;
  }
  return counts;
}

/** Counts from the stored status column (one aggregate statement's rows). */
function countsFromStatuses(byStatus: Readonly<Record<string, number>>): ProjectWorkPlanCounts {
  const counts = countWorkPlanTasks([]) as MutableProjectWorkPlanCounts;
  for (const status of ['pending', 'in_progress', 'blocked', 'done', 'failed', 'cancelled'] as const) {
    const count = byStatus[status] ?? 0;
    counts[status] = count;
    counts.total += count;
  }
  return counts;
}

function workPlanEmitterContext(event: WorkPlanEvent): {
  readonly traceId: string;
  readonly sessionId: string;
  readonly source: string;
} {
  return {
    traceId: `project-planning:work-plan:${event.workPlanId}:${event.revision}`,
    sessionId: `project:${event.projectId}`,
    source: 'project-planning.work-plan',
  };
}

function normalizePlanningId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? stablePlanningId('plan', value)
    : 'current';
}

function artifactKind(source: KnowledgeSourceRecord): ProjectPlanningArtifactKind | null {
  const kind = source.metadata.planningArtifactKind;
  return kind === 'state' || kind === 'decision' || kind === 'language' || kind === 'work-plan' ? kind : null;
}

function readState(source: KnowledgeSourceRecord): ProjectPlanningState | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? storedPlanningArtifact(value, 'state') as ProjectPlanningState : null;
}

function readDecision(source: KnowledgeSourceRecord): ProjectPlanningDecision | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? storedPlanningArtifact(value, 'decision') as ProjectPlanningDecision : null;
}

function readLanguage(source: KnowledgeSourceRecord): ProjectPlanningLanguageArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? storedPlanningArtifact(value, 'language') as ProjectPlanningLanguageArtifact : null;
}

function readWorkPlan(source: KnowledgeSourceRecord): ProjectWorkPlanArtifact | null {
  const value = source.metadata.value;
  return value && typeof value === 'object' ? storedPlanningArtifact(value, 'work-plan') as ProjectWorkPlanArtifact : null;
}

function titleForArtifact(
  kind: ProjectPlanningArtifactKind,
  value: ProjectPlanningState | ProjectPlanningDecision | ProjectPlanningLanguageArtifact | ProjectWorkPlanArtifact,
): string {
  if (kind === 'state') return `Planning: ${(value as ProjectPlanningState).goal || 'Current plan'}`;
  if (kind === 'decision') return `Decision: ${(value as ProjectPlanningDecision).title}`;
  if (kind === 'work-plan') return 'Project Work Plan';
  return 'Project Language';
}


/**
 * Planning writes are compare-and-write on the rows they read: every publication
 * carries the state (and work-plan) row generation it was computed from, and the
 * store refuses it when that row moved. Another knowledge write (an ingest, a
 * usage record, a job run) does not touch those rows, so it must not cancel an
 * owner's action; the observation a planning step holds is therefore the row
 * generation check alone, and this placeholder never retires.
 */
function planningRowsObservation(): () => void {
  return () => undefined;
}

/** Goal-clarity readings by the semantic facts they were read from (approve and dismiss leave those unchanged). */
/**
 * Planning artifacts are stored with numeric clocks. Rows written before that
 * hold ISO strings at the clock paths; those (and only those) are read back
 * as numbers. A current row is returned as stored.
 */
function storedPlanningArtifact(value: object, kind: ProjectPlanningArtifactKind): unknown {
  const root = value as Record<string, unknown>;
  if (typeof root.createdAt !== 'string' && typeof root.updatedAt !== 'string') return value;
  const metadata = root.metadata as Record<string, unknown> | undefined;
  function clockPath(path: readonly string[]): boolean {
    if (path.length === 1 && ['createdAt', 'updatedAt'].includes(path[0]!)) return true;
    if (kind === 'state' && path.length === 3 && /^(0|[1-9][0-9]*)$/.test(path[1]!)) {
      if (['openQuestions', 'answeredQuestions'].includes(path[0]!) && path[2] === 'answeredAt') return true;
      if (path[0] === 'decisions' && ['createdAt', 'updatedAt'].includes(path[2]!)) return true;
    }
    if (kind === 'state' && path.join('.') === 'metadata.approvedAt'
      && root.executionApproved === true && metadata?.approvedFrom === 'plan-command') return true;
    return kind === 'work-plan' && path.length === 3 && path[0] === 'tasks'
      && /^(0|[1-9][0-9]*)$/.test(path[1]!) && ['createdAt', 'updatedAt', 'completedAt'].includes(path[2]!);
  }
  function visit(entry: unknown, path: readonly string[]): unknown {
    if (clockPath(path) && typeof entry === 'string') {
      const timestamp = Date.parse(entry);
      if (Number.isFinite(timestamp) && new Date(timestamp).toISOString() === entry) return timestamp;
    }
    if (!entry || typeof entry !== 'object') return entry;
    const result: object = Array.isArray(entry) ? new Array(entry.length) : Object.create(null) as object;
    for (const [key, item] of Object.entries(entry)) {
      Object.defineProperty(result, key, { value: visit(item, [...path, key]), enumerable: true });
    }
    return Object.freeze(result);
  }
  return visit(value, []);
}
