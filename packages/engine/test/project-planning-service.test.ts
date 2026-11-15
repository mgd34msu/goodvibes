import { KNOWLEDGE_SCHEMA_VERSION } from '../platform/src/platform/knowledge/store-schema.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  ProjectPlanningService,
  type ProjectWorkPlanSnapshot,
  projectKnowledgeSpaceId,
} from '../platform/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { SQLiteStore } from '../platform/src/platform/state/sqlite-store.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { seedHistoricalPlanningLanguage, seedHistoricalPlanningState } from './_helpers/planning-history.ts';
import type { PlannerEvent } from '../platform/src/events/planner.js';

let previousPort: JudgmentPort | undefined;
beforeEach(() => { previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(() => { installJudgmentPort(previousPort); });

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('project planning service', () => {
  test('saved planning records stay readable in isolated project knowledge spaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-'));
    tmpRoots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const service = new ProjectPlanningService(store, { defaultProjectId: 'default-project' });
    await seedHistoricalPlanningState(store, 'alpha', {
      goal: 'Add conversational planning support',
      tasks: [{ id: 'contracts', title: 'Add passive planning contracts' }],
      readiness: 'executable',
      executionApproved: true,
    });
    await seedHistoricalPlanningLanguage(store, 'alpha', {
      terms: [{ term: 'Surface', definition: 'A user-facing channel where GoodVibes receives or sends interaction.' }],
      ambiguities: [],
    });
    await service.recordDecision({
      projectId: 'alpha',
      decision: { title: 'Work plan is the plan', decision: 'Tasks live in the work plan; planning state is history.' },
    });

    const alpha = await service.getState({ projectId: 'alpha' });
    const beta = await service.getState({ projectId: 'beta' });
    const status = await service.status({ projectId: 'alpha' });

    expect(alpha.knowledgeSpaceId).toBe(projectKnowledgeSpaceId('alpha'));
    expect(alpha.state?.goal).toBe('Add conversational planning support');
    expect(alpha.revision?.sourceId).toBe(alpha.source?.id);
    expect(beta.state).toBeNull();
    expect(status.counts).toEqual({ states: 1, decisions: 1, languageArtifacts: 1, workPlans: 0, workPlanTasks: 0 });
    expect(status.passiveOnly).toBe(true);
    expect((await service.listDecisions({ projectId: 'alpha' })).decisions[0]?.title).toBe('Work plan is the plan');
    expect((await service.getLanguage({ projectId: 'alpha' })).language?.terms[0]?.term).toBe('Surface');
    // Saved planning tasks are history; they do not create work-plan tasks.
    expect((await service.getWorkPlanSnapshot({ projectId: 'alpha' })).tasks).toEqual([]);
  });

  test('stores durable work-plan tasks and emits task deltas plus snapshot invalidations', async () => {
    const bus = new RuntimeEventBus();
    const service = createService(bus);
    const events: string[] = [];
    const snapshots: ProjectWorkPlanSnapshot[] = [];
    const unsubscribeCreated = bus.on<Extract<PlannerEvent, { type: 'WORK_PLAN_TASK_CREATED' }>>('WORK_PLAN_TASK_CREATED', ({ payload }) => {
      events.push(`${payload.type}:${payload.task.title}`);
    });
    const unsubscribeStatus = bus.on<Extract<PlannerEvent, { type: 'WORK_PLAN_TASK_STATUS_CHANGED' }>>('WORK_PLAN_TASK_STATUS_CHANGED', ({ payload }) => {
      events.push(`${payload.type}:${payload.previousStatus}->${payload.status}`);
    });
    const unsubscribeSnapshot = bus.on<Extract<PlannerEvent, { type: 'WORK_PLAN_SNAPSHOT_INVALIDATED' }>>('WORK_PLAN_SNAPSHOT_INVALIDATED', ({ payload }) => {
      snapshots.push(payload.snapshot as ProjectWorkPlanSnapshot);
    });

    const created = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: {
        title: 'Build shared work-plan primitive',
        owner: 'platform',
        priority: 10,
        source: 'contract',
        contractId: 'ctr-1',
        phaseId: 'engineer',
        agentId: 'agent-1',
        linkedArtifactIds: ['artifact-1'],
        linkedSourceIds: ['source-1'],
        linkedNodeIds: ['node-1'],
        originSurface: 'tui',
        tags: ['contract', 'planning'],
      },
    });
    const started = await service.setWorkPlanTaskStatus({
      projectId: 'alpha',
      taskId: created.task!.taskId,
      status: 'in_progress',
      reason: 'Engineer started',
    });
    const listed = await service.getWorkPlanSnapshot({ projectId: 'alpha', contractId: 'ctr-1' });
    const beta = await service.getWorkPlanSnapshot({ projectId: 'beta' });
    const status = await service.status({ projectId: 'alpha' });

    unsubscribeCreated();
    unsubscribeStatus();
    unsubscribeSnapshot();

    expect(created.snapshot.counts.pending).toBe(1);
    expect(started.task?.status).toBe('in_progress');
    expect(started.task?.metadata?.statusReason).toBe('Engineer started');
    expect(listed.tasks[0]?.linkedNodeIds).toEqual(['node-1']);
    expect(beta.tasks).toEqual([]);
    expect(status.counts.workPlans).toBe(1);
    expect(status.counts.workPlanTasks).toBe(1);
    expect(events).toContain('WORK_PLAN_TASK_CREATED:Build shared work-plan primitive');
    expect(events).toContain('WORK_PLAN_TASK_STATUS_CHANGED:pending->in_progress');
    expect(snapshots.length).toBeGreaterThanOrEqual(2);
  });

  test('reorders and clears work-plan tasks with durable counts', async () => {
    const service = createService();
    const first = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: { title: 'First task' },
    });
    const second = await service.createWorkPlanTask({
      projectId: 'alpha',
      task: { title: 'Second task' },
    });

    const reordered = await service.reorderWorkPlanTasks({
      projectId: 'alpha',
      orderedTaskIds: [second.task!.taskId, first.task!.taskId],
    });
    expect(reordered.tasks.map((task) => task.title)).toEqual(['Second task', 'First task']);

    await service.setWorkPlanTaskStatus({
      projectId: 'alpha',
      taskId: second.task!.taskId,
      status: 'done',
    });
    const cleared = await service.clearCompletedWorkPlanTasks({ projectId: 'alpha' });
    expect(cleared.clearedTaskIds).toEqual([second.task!.taskId]);
    expect(cleared.snapshot.counts.total).toBe(1);
    expect(cleared.snapshot.tasks[0]?.title).toBe('First task');
  });
});

describe('stored work plans written before the contract rename', () => {
  test("a stored task's chainId is read as its contractId, so the link survives", async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-'));
    tmpRoots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
    const service = new ProjectPlanningService(store, { defaultProjectId: 'default-project' });
    await service.createWorkPlanTask({ projectId: 'alpha', task: { title: 'Older task', contractId: 'ctr-old' } });
    // Rewrite the stored artifact the way an older build wrote it: the correlation under `chainId`.
    const source = store.listSources(100).find((candidate) => candidate.metadata['planningArtifactKind'] === 'work-plan')!;
    const value = source.metadata['value'] as { tasks: Array<Record<string, unknown>> };
    const legacyTasks = value.tasks.map(({ contractId, ...rest }) => ({ ...rest, chainId: contractId }));
    const original = store.getSourceSnapshot({ id: source.id }).raw!;
    // Inject only the historical field-name shape. A generic source upsert would
    // rewrite canonical source clocks through its numeric compatibility view.
    const raw = new SQLiteStore(store.storagePath);
    await raw.init(() => {}, { schemaVersion: KNOWLEDGE_SCHEMA_VERSION });
    raw.run('UPDATE knowledge_sources SET metadata = ? WHERE id = ?',
      [JSON.stringify({ ...source.metadata, value: { ...value, tasks: legacyTasks } }), source.id]);
    await raw.save(); raw.close();
    const reopened = new KnowledgeStore({ dbPath: store.storagePath });
    try {
      await reopened.init();
      const after = reopened.getSourceSnapshot({ id: source.id }).raw!;
      expect(after.created_at).toBe(original.created_at); expect(after.updated_at).toBe(original.updated_at);
      const snapshot = await new ProjectPlanningService(reopened).getWorkPlanSnapshot({ projectId: 'alpha', contractId: 'ctr-old' });
      expect(snapshot.tasks.map((task) => [task.title, task.contractId])).toEqual([['Older task', 'ctr-old']]);
    } finally { await reopened.close(); }
  });
});

function createService(runtimeBus?: RuntimeEventBus): ProjectPlanningService {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-project-planning-'));
  tmpRoots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  return new ProjectPlanningService(store, { defaultProjectId: 'default-project', runtimeBus });
}
