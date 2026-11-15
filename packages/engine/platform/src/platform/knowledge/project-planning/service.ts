import { configuredPlanningStoreIdentity } from './configured-project.js';
import { knowledgeRawRowForAdmission } from '../store-row-revisions.js';
export class WorkPlanTaskExistsError extends Error {
  constructor(taskId: string) { super(`Work plan task already exists: ${taskId}`); this.name = 'WorkPlanTaskExistsError'; }
}
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { retainStrictJudgmentJson } from '../../gate/judgment-result.js';
import { retainConfiguredWorkspace, type ConfigManager } from '../../config/manager.js';
import { dirname, resolve } from 'node:path';
import { types as nativeTypes } from 'node:util';
import { SQLiteObservationRetiredError } from '../../state/sqlite-store.js';
import { randomUUID } from 'node:crypto';
import { knowledgeSpaceMetadata, normalizeProjectId } from '../spaces.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from '../types.js';
import { KnowledgeSourcePublicationHeldError, type KnowledgeSourceSnapshot } from '../store-source-generation.js';
import { KnowledgeStore } from '../store.js';
import { KnowledgeStoreConflictError } from '../store-conflict.js';
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

type MutableProjectWorkPlanCounts = {
  -readonly [K in keyof ProjectWorkPlanCounts]: ProjectWorkPlanCounts[K];
};

type WorkPlanTaskCandidate = {
  readonly [K in keyof ProjectWorkPlanTask]?: ProjectWorkPlanTask[K] | undefined;
} & {
  readonly title?: string | undefined;
};

export interface ProjectPlanningServiceOptions {
  /** Composition-owned startup writes on this same store, before any reading. */
  readonly waitForStartup?: (() => Promise<void>) | undefined;
  readonly defaultProjectId?: string | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
}

interface NativePlanningDefault {
  readonly projectId: string;
  readonly store: KnowledgeStore;
  readonly startup: (() => Promise<void>) | undefined;
  readonly assertCurrent: () => void;
}
const nativeApply = Reflect.apply, nativeWeakGet = WeakMap.prototype.get, nativeWeakSet = WeakMap.prototype.set, nativeWeakDelete = WeakMap.prototype.delete;
const nativePlanningOptions = new WeakMap<ProjectPlanningServiceOptions, NativePlanningDefault>();
const nativeStoreMethods = [
  ['init', KnowledgeStore.prototype.init],
  ['captureSourcePublication', KnowledgeStore.prototype.captureSourcePublication],
  ['getSourceSnapshot', KnowledgeStore.prototype.getSourceSnapshot],
  ['listSources', KnowledgeStore.prototype.listSources],
] as const;

function captureNativePlanningOptions(options: Omit<ProjectPlanningServiceOptions, 'defaultProjectId'>) {
  if (nativeTypes.isProxy(options) || (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)) {
    throw new JudgmentInputError('unsupported-input');
  }
  const keys = Reflect.ownKeys(options);
  const slots = keys.map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor) || typeof key !== 'string') throw new JudgmentInputError('unsupported-input');
    return { key, descriptor };
  });
  const extra: Record<string, unknown> = {};
  let startup: (() => Promise<void>) | undefined;
  let bus: RuntimeEventBus | null | undefined;
  for (const { key, descriptor } of slots) {
    const value: unknown = descriptor.value;
    if (key === 'waitForStartup') {
      if (value !== undefined && typeof value !== 'function') throw new JudgmentInputError('unsupported-input');
      startup = options.waitForStartup;
    } else if (key === 'runtimeBus') bus = options.runtimeBus;
    else Object.defineProperty(extra, key, descriptor);
  }
  const retained = retainStrictJudgmentJson(extra, () => new JudgmentInputError('unsupported-input'));
  snapshotJudgmentInput(retained.snapshot);
  if (keys.includes('defaultProjectId')) throw new TypeError('Native planning composition cannot select a default project ID');
  const prototype = Object.getPrototypeOf(options);
  const assertCurrent = () => {
    if (nativeTypes.isProxy(options) || Object.getPrototypeOf(options) !== prototype) throw new JudgmentAuthorityRetiredError();
    const currentKeys = Reflect.ownKeys(options);
    if (currentKeys.length !== keys.length) throw new JudgmentAuthorityRetiredError();
    for (const [index, { key, descriptor }] of slots.entries()) {
      const current = Object.getOwnPropertyDescriptor(options, key);
      if (currentKeys[index] !== key || !current || !('value' in current) || current.value !== descriptor.value
        || current.writable !== descriptor.writable || current.enumerable !== descriptor.enumerable
        || current.configurable !== descriptor.configurable) throw new JudgmentAuthorityRetiredError();
    }
    retained.assertCurrent();
  };
  return { startup, bus, assertCurrent };
}

/**
 * Work-plan task status is a CHECKLIST, not a one-way workflow: every state may
 * move to every state, including out of done, failed and cancelled. That is
 * deliberate and relied on: the contract plan sync re-opens a unit's task when
 * a later check finds its work failing (repair/retry), the checklist cycle
 * (workflow/work-plan-store.ts `nextWorkPlanStatus`) moves done/failed/
 * cancelled back to pending, and an operator may un-cancel through the status
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

const WORK_PLAN_MUTATION_ATTEMPTS = 3;

/** Refusals raised before anything was written because the store moved under the read. */
function isRetryableWorkPlanConflict(error: unknown): boolean {
  return error instanceof SQLiteObservationRetiredError
    || error instanceof KnowledgeSourcePublicationHeldError
    || (error instanceof KnowledgeStoreConflictError && error.reloaded);
}

export class ProjectPlanningService {
  readonly #nativeDefault: NativePlanningDefault | undefined;
  private readonly defaultProjectId: string;
  private readonly waitForStartup: (() => Promise<void>) | undefined;
  private runtimeBus: RuntimeEventBus | null;
  private runtimeBusEpoch = 0;
  /** Tail of the edit chain for each work plan; see mutateWorkPlan(). */
  private readonly workPlanMutations = new Map<string, Promise<void>>();

  /** Native composition derives this identity from the actual configured workspace. */
  static forConfiguredWorkspace(
    store: KnowledgeStore,
    configManager: ConfigManager,
    workingDirectory: string,
    options: Omit<ProjectPlanningServiceOptions, 'defaultProjectId'> = {},
  ): { readonly service: ProjectPlanningService; readonly projectId: string } {
    const workspace = retainConfiguredWorkspace(configManager);
    const captured = captureNativePlanningOptions(options);
    const identity = configuredPlanningStoreIdentity(store, configManager, workingDirectory);
    const projectId = identity.projectId;
    workspace.assertCurrent(); captured.assertCurrent();
    if (workspace.directory === null || workspace.directory !== resolve(workingDirectory)) throw new JudgmentAuthorityRetiredError();
    if (nativeTypes.isProxy(store) || Object.getPrototypeOf(store) !== KnowledgeStore.prototype) throw new JudgmentAuthorityRetiredError();
    const storeSlots = ['dbPath', 'sqlite', 'closed'].map(key => {
      const slot = Object.getOwnPropertyDescriptor(store, key);
      if (!slot || !('value' in slot)) throw new JudgmentAuthorityRetiredError();
      return { key, slot };
    });
    const path = storeSlots.find(slot => slot.key === 'dbPath')?.slot.value;
    if (typeof path !== 'string' || dirname(path) !== workspace.configDirectory) throw new JudgmentAuthorityRetiredError();
    const assertCurrent = () => {
      if (nativeTypes.isProxy(store) || Object.getPrototypeOf(store) !== KnowledgeStore.prototype) throw new JudgmentAuthorityRetiredError();
      for (const { key, slot } of storeSlots) {
        const current = Object.getOwnPropertyDescriptor(store, key);
        if (!current || !('value' in current) || current.value !== slot.value || (key === 'closed' && current.value !== false)
          || current.writable !== slot.writable || current.enumerable !== slot.enumerable
          || current.configurable !== slot.configurable) throw new JudgmentAuthorityRetiredError();
      }
      for (const [key, method] of nativeStoreMethods) {
        const own = Object.getOwnPropertyDescriptor(store, key);
        const current = own ?? Object.getOwnPropertyDescriptor(KnowledgeStore.prototype, key);
        if (!current || !('value' in current) || current.value !== method) throw new JudgmentAuthorityRetiredError();
      }
      workspace.assertCurrent(); identity.assertCurrent(); captured.assertCurrent();
    };
    assertCurrent();
    const nativeOptions = Object.freeze({ defaultProjectId: projectId, waitForStartup: captured.startup, runtimeBus: captured.bus });
    nativeApply(nativeWeakSet, nativePlanningOptions, [nativeOptions, Object.freeze({ projectId, store, startup: captured.startup, assertCurrent })]);
    try { return { projectId, service: new ProjectPlanningService(store, nativeOptions) }; }
    finally { nativeApply(nativeWeakDelete, nativePlanningOptions, [nativeOptions]); }
  }

  constructor(
    private readonly store: KnowledgeStore,
    options: ProjectPlanningServiceOptions = {},
  ) {
    const native = nativeApply(nativeWeakGet, nativePlanningOptions, [options]) as NativePlanningDefault | undefined;
    native?.assertCurrent();
    const defaultProjectId = options.defaultProjectId;
    snapshotJudgmentInput(native ? { kind: 'native-project-reference' } : defaultProjectId);
    if (native && (native.store !== store || native.projectId !== defaultProjectId)) throw new JudgmentAuthorityRetiredError();
    this.defaultProjectId = normalizeProjectId(defaultProjectId ?? 'default');
    this.runtimeBus = options.runtimeBus ?? null;
    this.waitForStartup = options.waitForStartup;
    this.#nativeDefault = native;
    this.#assertNativeDefaultCurrent();
  }

  #assertNativeDefaultCurrent(): void {
    const native = this.#nativeDefault;
    if (!native) return;
    for (const [key, value] of [['store', native.store], ['defaultProjectId', native.projectId], ['waitForStartup', native.startup]] as const) {
      const slot = Object.getOwnPropertyDescriptor(this, key);
      if (!slot || !('value' in slot) || slot.value !== value) throw new JudgmentAuthorityRetiredError();
    }
    native.assertCurrent();
  }

  private async initialize(): Promise<void> {
    this.#assertNativeDefaultCurrent();
    await this.store.init();
    this.#assertNativeDefaultCurrent();
    await this.waitForStartup?.();
    this.#assertNativeDefaultCurrent();
  }

  attachRuntimeBus(runtimeBus: RuntimeEventBus | null | undefined): void {
    this.runtimeBusEpoch += 1;
    this.runtimeBus = runtimeBus ?? null;
  }

  async status(input: ProjectPlanningSpaceInput = {}): Promise<ProjectPlanningStatus> {
    await this.initialize();
    const space = this.resolveSpace(input);
    const sources = this.sourcesForSpace(space.knowledgeSpaceId);
    return {
      ok: true,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      passiveOnly: true,
      counts: {
        states: sources.filter((source) => artifactKind(source) === 'state').length,
        decisions: sources.filter((source) => artifactKind(source) === 'decision').length,
        languageArtifacts: sources.filter((source) => artifactKind(source) === 'language').length,
        workPlans: sources.filter((source) => artifactKind(source) === 'work-plan').length,
        workPlanTasks: sources
          .filter((source) => artifactKind(source) === 'work-plan')
          .reduce((count, source) => count + (readWorkPlan(source)?.tasks.length ?? 0), 0),
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
    const snapshot = this.store.getPlanningSourceSnapshot({ spaceId, kind, artifactId: id });
    admitPlanningSource(snapshot);
    return snapshot;
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
    await this.initialize();
    const space = this.resolveSpace(input);
    const workPlan = this.getWorkPlanArtifact(space, normalizeWorkPlanId(input.workPlanId));
    return snapshotFromWorkPlan(space, workPlan, {
      status: input.status,
      parentTaskId: input.parentTaskId,
      contractId: input.contractId,
      owner: input.owner,
      limit: input.limit,
    });
  }

  async getWorkPlanTask(input: ProjectWorkPlanTaskGetInput): Promise<ProjectWorkPlanTaskResult> {
    await this.initialize();
    const snapshot = await this.getWorkPlanSnapshot(input);
    return {
      ok: true,
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task: snapshot.tasks.find((task) => task.taskId === input.taskId) ?? null,
      snapshot,
    };
  }

  async createWorkPlanTask(input: ProjectWorkPlanTaskCreateInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskCreateInput;
    return this.mutateWorkPlan(input, async () => {
      await this.initialize();
      const space = this.resolveSpace(input);
      const workPlanId = normalizeWorkPlanId(input.workPlanId);
      const existing = this.getWorkPlanArtifact(space, workPlanId);
      const now = Date.now();
      const task = normalizeWorkPlanTask(input.task, {
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        now,
        fallbackOrder: nextWorkPlanOrder(existing.tasks),
      });
      if (existing.tasks.some((entry) => entry.taskId === task.taskId)) {
        throw new WorkPlanTaskExistsError(task.taskId);
      }
      const workPlan = await this.saveWorkPlanArtifact(space, {
        ...existing,
        tasks: sortWorkPlanTasks([...existing.tasks, task]),
        updatedAt: now,
      });
      const snapshot = snapshotFromWorkPlan(space, workPlan);
      this.emitWorkPlanTaskCreated(snapshot, task);
      return {
        ok: true,
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        workPlanId,
        task,
        snapshot,
      };
    });
  }

  async updateWorkPlanTask(input: ProjectWorkPlanTaskUpdateInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskUpdateInput;
    return this.mutateWorkPlan(input, async () => {
      await this.initialize();
      const space = this.resolveSpace(input);
      const workPlanId = normalizeWorkPlanId(input.workPlanId);
      const existing = this.getWorkPlanArtifact(space, workPlanId);
      const previousTask = existing.tasks.find((task) => task.taskId === input.taskId);
      if (!previousTask) throw new Error(`Work plan task not found: ${input.taskId}`);
      const now = Date.now();
      // A new status starts a new explanation and completion time: the old reason and
      // completedAt described the previous status.
      const statusChanging = input.patch.status !== undefined && normalizeWorkPlanStatus(input.patch.status) !== previousTask.status;
      const carriedMetadata: Record<string, unknown> = { ...(previousTask.metadata ?? {}) };
      if (statusChanging && !('statusReason' in (input.patch.metadata ?? {}))) delete carriedMetadata.statusReason;
      const task = normalizeWorkPlanTask({
        ...previousTask,
        ...input.patch,
        ...(statusChanging && input.patch.completedAt === undefined ? { completedAt: undefined } : {}),
        metadata: {
          ...carriedMetadata,
          ...(input.patch.metadata ?? {}),
        },
        taskId: previousTask.taskId,
        createdAt: previousTask.createdAt,
        updatedAt: now,
      }, {
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        now,
        fallbackOrder: previousTask.order,
      });
      projectWorkPlanTaskLifecycle.assert(previousTask.status, task.status);
      const workPlan = await this.saveWorkPlanArtifact(space, {
        ...existing,
        tasks: sortWorkPlanTasks(existing.tasks.map((entry) => entry.taskId === input.taskId ? task : entry)),
        updatedAt: now,
      });
      const snapshot = snapshotFromWorkPlan(space, workPlan);
      this.emitWorkPlanTaskUpdated(snapshot, task, previousTask);
      if (previousTask.status !== task.status) {
        this.emitWorkPlanTaskStatusChanged(snapshot, task, previousTask);
      }
      return {
        ok: true,
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        workPlanId,
        task,
        previousTask,
        snapshot,
      };
    });
  }

  async setWorkPlanTaskStatus(input: ProjectWorkPlanTaskStatusInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskStatusInput;
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
    });
  }

  async reorderWorkPlanTasks(input: ProjectWorkPlanTaskReorderInput): Promise<ProjectWorkPlanSnapshot> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskReorderInput;
    return this.mutateWorkPlan(input, async () => {
      await this.initialize();
      const space = this.resolveSpace(input);
      const workPlanId = normalizeWorkPlanId(input.workPlanId);
      const existing = this.getWorkPlanArtifact(space, workPlanId);
      const previousById = new Map(existing.tasks.map((task) => [task.taskId, task]));
      const orderById = new Map(input.orderedTaskIds.map((taskId, index) => [taskId, index]));
      for (const taskId of orderById.keys()) {
        if (!previousById.has(taskId)) throw new Error(`Work plan task not found: ${taskId}`);
      }
      const now = Date.now();
      const tasks = sortWorkPlanTasks(existing.tasks.map((task) => ({
        ...task,
        order: orderById.get(task.taskId) ?? task.order + input.orderedTaskIds.length,
        updatedAt: orderById.has(task.taskId) ? now : task.updatedAt,
      })));
      const workPlan = await this.saveWorkPlanArtifact(space, {
        ...existing,
        tasks,
        updatedAt: now,
      });
      const snapshot = snapshotFromWorkPlan(space, workPlan);
      for (const task of tasks) {
        const previousTask = previousById.get(task.taskId);
        if (previousTask && previousTask.order !== task.order) {
          this.emitWorkPlanTaskUpdated(snapshot, task, previousTask, true);
        }
      }
      this.emitWorkPlanSnapshotInvalidated(snapshot, 'reordered');
      return snapshot;
    });
  }

  async deleteWorkPlanTask(input: ProjectWorkPlanTaskDeleteInput): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanTaskDeleteInput;
    return this.mutateWorkPlan(input, async () => {
      await this.initialize();
      const space = this.resolveSpace(input);
      const workPlanId = normalizeWorkPlanId(input.workPlanId);
      const existing = this.getWorkPlanArtifact(space, workPlanId);
      const deletedTask = existing.tasks.find((task) => task.taskId === input.taskId);
      if (!deletedTask) throw new Error(`Work plan task not found: ${input.taskId}`);
      const now = Date.now();
      const workPlan = await this.saveWorkPlanArtifact(space, {
        ...existing,
        tasks: existing.tasks.filter((task) => task.taskId !== input.taskId),
        updatedAt: now,
      });
      const snapshot = snapshotFromWorkPlan(space, workPlan);
      this.emitWorkPlanTaskDeleted(snapshot, deletedTask);
      return {
        ok: true,
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        workPlanId,
        deletedTask,
        snapshot,
      };
    });
  }

  async clearCompletedWorkPlanTasks(input: ProjectWorkPlanClearCompletedInput = {}): Promise<ProjectWorkPlanMutationResult> {
    input = snapshotJudgmentInput(input) as ProjectWorkPlanClearCompletedInput;
    return this.mutateWorkPlan(input, async () => {
      await this.initialize();
      const space = this.resolveSpace(input);
      const workPlanId = normalizeWorkPlanId(input.workPlanId);
      const existing = this.getWorkPlanArtifact(space, workPlanId);
      const statuses = new Set(input.statuses?.length ? input.statuses.map(normalizeWorkPlanStatus) : ['done']);
      const cleared = existing.tasks.filter((task) => statuses.has(task.status));
      const now = Date.now();
      const workPlan = await this.saveWorkPlanArtifact(space, {
        ...existing,
        tasks: existing.tasks.filter((task) => !statuses.has(task.status)),
        updatedAt: now,
      });
      const snapshot = snapshotFromWorkPlan(space, workPlan);
      for (const task of cleared) {
        this.emitWorkPlanTaskDeleted(snapshot, task, true);
      }
      this.emitWorkPlanSnapshotInvalidated(snapshot, 'cleared-completed');
      return {
        ok: true,
        projectId: space.projectId,
        knowledgeSpaceId: space.knowledgeSpaceId,
        workPlanId,
        clearedTaskIds: cleared.map((task) => task.taskId),
        snapshot,
      };
    });
  }

  /**
   * Work-plan edits are whole-artifact read-modify-writes published against the
   * observation taken at read time, so any other write to the store in between
   * (another task's status change, a job run, a usage record) retires it. Edits
   * to one plan run one at a time in this process, and an edit refused because
   * the store moved is re-read and retried; each attempt re-runs its own checks,
   * so a duplicate create still reports the existing task.
   */
  private async mutateWorkPlan<T>(input: ProjectPlanningSpaceInput & { readonly workPlanId?: string | undefined }, mutate: () => Promise<T>,
    chain?: string): Promise<T> {
    await this.initialize();
    const run = async (): Promise<T> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await mutate();
        } catch (error) {
          if (attempt >= WORK_PLAN_MUTATION_ATTEMPTS || !isRetryableWorkPlanConflict(error)) throw error;
          await new Promise<void>((resolve) => { setTimeout(resolve, 20 * attempt).unref?.(); });
        }
      }
    };
    let key: string;
    try {
      const space = this.resolveSpace(input);
      key = JSON.stringify([space.projectId, space.knowledgeSpaceId, chain ?? normalizeWorkPlanId(input.workPlanId)]);
    } catch {
      // The mutation reports its own resolution failure.
      return run();
    }
    const previous = this.workPlanMutations.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    const settled = next.then(() => {}, () => {});
    this.workPlanMutations.set(key, settled);
    void settled.then(() => { if (this.workPlanMutations.get(key) === settled) this.workPlanMutations.delete(key); });
    return next;
  }

  private resolveSpace(input: ProjectPlanningSpaceInput = {}) {
    this.#assertNativeDefaultCurrent();
    snapshotJudgmentInput({ input, defaultProjectId: this.#nativeDefault ? { kind: 'native-project-reference' } : this.defaultProjectId });
    this.#assertNativeDefaultCurrent();
    return resolveProjectPlanningSpace(input, this.defaultProjectId);
  }

  private sourcesForSpace(spaceId: string): readonly KnowledgeSourceRecord[] {
    return this.store.listSources(Number.MAX_SAFE_INTEGER).filter((source) => {
      const metadata = source.metadata ?? {};
      return metadata.projectPlanning === true && metadata.knowledgeSpaceId === spaceId;
    }).map(source => {
      const snapshot = this.store.getSourceSnapshot({ id: source.id });
      admitPlanningSource(snapshot);
      return snapshot.source!;
    });
  }

  private getArtifactSource(
    spaceId: string,
    kind: ProjectPlanningArtifactKind,
    id: string,
  ): KnowledgeSourceRecord | null {
    return this.getArtifactSnapshot(spaceId, kind, id).source;
  }

  private getWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlanId: string,
  ): ProjectWorkPlanArtifact {
    const source = this.getArtifactSource(space.knowledgeSpaceId, 'work-plan', workPlanId);
    const value = source ? readWorkPlan(source) : null;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return normalizeWorkPlanArtifact(value as Partial<ProjectWorkPlanArtifact>, space, workPlanId);
    }
    const now = Date.now();
    return {
      id: workPlanId,
      projectId: space.projectId,
      knowledgeSpaceId: space.knowledgeSpaceId,
      tasks: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  private async saveWorkPlanArtifact(
    space: { readonly projectId: string; readonly knowledgeSpaceId: string },
    workPlan: ProjectWorkPlanArtifact,
  ): Promise<ProjectWorkPlanArtifact> {
    const normalized = normalizeWorkPlanArtifact(workPlan, space, workPlan.id);
    await this.upsertArtifactSource(space, 'work-plan', normalized.id, normalized);
    return normalized;
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
        value: snapshotJudgmentInput(value),
      }),
    };
  }

  private emitWorkPlanTaskCreated(snapshot: ProjectWorkPlanSnapshot, task: ProjectWorkPlanTask, assertCurrent?: () => void): void {
    assertCurrent?.();
    if (!this.runtimeBus) return;
    emitWorkPlanTaskCreated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
    });
    assertCurrent?.();
    this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-created');
  }

  private emitWorkPlanTaskUpdated(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
    assertCurrent?: () => void,
  ): void {
    assertCurrent?.();
    if (!this.runtimeBus) return;
    emitWorkPlanTaskUpdated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      task,
      previousTask,
    });
    assertCurrent?.();
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-updated');
  }

  private emitWorkPlanTaskStatusChanged(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    previousTask: ProjectWorkPlanTask,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskStatusChanged(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      status: task.status,
      previousStatus: previousTask.status,
      task,
    });
  }

  private emitWorkPlanTaskDeleted(
    snapshot: ProjectWorkPlanSnapshot,
    task: ProjectWorkPlanTask,
    skipSnapshotInvalidation = false,
  ): void {
    if (!this.runtimeBus) return;
    emitWorkPlanTaskDeleted(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      taskId: task.taskId,
      task,
    });
    if (!skipSnapshotInvalidation) this.emitWorkPlanSnapshotInvalidated(snapshot, 'task-deleted');
  }

  private emitWorkPlanSnapshotInvalidated(snapshot: ProjectWorkPlanSnapshot, reason: string): void {
    if (!this.runtimeBus) return;
    emitWorkPlanSnapshotInvalidated(this.runtimeBus, workPlanEmitterContext(snapshot), {
      projectId: snapshot.projectId,
      knowledgeSpaceId: snapshot.knowledgeSpaceId,
      workPlanId: snapshot.workPlanId,
      reason,
      snapshot,
    });
  }
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

function nextWorkPlanOrder(tasks: readonly ProjectWorkPlanTask[]): number {
  return tasks.reduce((max, task) => Math.max(max, task.order), -1) + 1;
}

function sortWorkPlanTasks(tasks: readonly ProjectWorkPlanTask[]): ProjectWorkPlanTask[] {
  return [...tasks].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

function snapshotFromWorkPlan(
  space: { readonly projectId: string; readonly knowledgeSpaceId: string },
  workPlan: ProjectWorkPlanArtifact,
  filter: {
    readonly status?: ProjectWorkPlanTaskStatus | undefined;
    readonly parentTaskId?: string | undefined;
    readonly contractId?: string | undefined;
    readonly owner?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): ProjectWorkPlanSnapshot {
  const tasks = sortWorkPlanTasks(workPlan.tasks).filter((task) => {
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
    workPlanId: workPlan.id,
    tasks: limit ? tasks.slice(0, limit) : tasks,
    counts: countWorkPlanTasks(workPlan.tasks),
    updatedAt: workPlan.updatedAt,
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

function workPlanEmitterContext(snapshot: ProjectWorkPlanSnapshot): {
  readonly traceId: string;
  readonly sessionId: string;
  readonly source: string;
} {
  return {
    traceId: `project-planning:work-plan:${snapshot.workPlanId}:${snapshot.updatedAt}`,
    sessionId: `project:${snapshot.projectId}`,
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


/** The complete persisted original is admitted before reading its numeric view. */
function admitPlanningSource(snapshot: KnowledgeSourceSnapshot): void {
  if (!snapshot.source) return;
  if (!snapshot.raw) throw new JudgmentInputError('unsupported-input');
  snapshotJudgmentInput(knowledgeRawRowForAdmission(snapshot.raw));
  snapshotJudgmentInput(snapshot.source.metadata);
  snapshotJudgmentInput(snapshot.source.tags);
  for (const key of ['created_at', 'updated_at'] as const) {
    const value = snapshot.raw[key];
    const timestamp = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    if (!Number.isSafeInteger(timestamp) || Math.abs(timestamp) > 8.64e15
      || (typeof value === 'string' && new Date(timestamp).toISOString() !== value)) throw new JudgmentInputError('unsupported-input');
  }
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
