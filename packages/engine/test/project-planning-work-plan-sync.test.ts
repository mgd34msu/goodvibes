import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ProjectPlanningService, type ProjectWorkPlanTask } from '../platform/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

let previousPort: JudgmentPort | undefined;
const roots: string[] = [];
const afterEachRestore: Array<() => void> = [];
const stores: KnowledgeStore[] = [];
beforeEach(() => { previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(async () => {
  installJudgmentPort(previousPort);
  for (const restore of afterEachRestore.splice(0)) restore();
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function create(bus?: RuntimeEventBus): { service: ProjectPlanningService; store: KnowledgeStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-work-plan-sync-'));
  roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  return { service: new ProjectPlanningService(store, { defaultProjectId: 'default-project', runtimeBus: bus }), store };
}

const planningState = (goal: string, tasks: readonly { id: string; title: string; status?: 'completed' }[]) => ({
  id: 'plan',
  goal,
  scope: 'platform only',
  tasks: tasks.map((task) => ({ ...task, verification: ['bun test'] })),
  verificationGates: [{ id: 'gate', description: 'tests pass', required: true }],
  executionApproved: true,
});

async function workPlanTasks(service: ProjectPlanningService): Promise<readonly ProjectWorkPlanTask[]> {
  return (await service.getWorkPlanSnapshot({ projectId: 'alpha' })).tasks;
}

describe('planning state publication and the work plan it feeds', () => {
  test('a status an operator set survives a later planning publication', async () => {
    const { service } = create();
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) });
    const [synced] = await workPlanTasks(service);
    await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId: synced!.taskId, status: 'done' });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning, revised', [{ id: 't1', title: 'First' }]) });
    const [after] = await workPlanTasks(service);
    expect(after!.status).toBe('done');
    expect(after!.completedAt).toBeDefined();
  });

  test('a planning-side status change still reaches the work plan', async () => {
    const { service } = create();
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First', status: 'completed' }]) });
    expect((await workPlanTasks(service))[0]!.status).toBe('done');
  });

  test('an operator reorder is kept and a deleted task is not brought back', async () => {
    const { service } = create();
    const tasks = [{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }, { id: 't3', title: 'Third' }];
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', tasks) });
    const ids = (await workPlanTasks(service)).map((task) => task.taskId);
    await service.reorderWorkPlanTasks({ projectId: 'alpha', orderedTaskIds: [ids[2]!, ids[1]!, ids[0]!] });
    await service.deleteWorkPlanTask({ projectId: 'alpha', taskId: ids[1]! });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning again', tasks) });
    expect((await workPlanTasks(service)).map((task) => task.taskId)).toEqual([ids[2]!, ids[0]!]);
  });

  test('a task that left the planning state is marked, not deleted, and unmarked when it returns', async () => {
    const { service } = create();
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }]) });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) });
    const dropped = (await workPlanTasks(service)).find((task) => task.title === 'Second')!;
    expect(dropped.tags).toContain('planning-removed');
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }]) });
    const back = (await workPlanTasks(service)).find((task) => task.title === 'Second')!;
    expect(back.tags).not.toContain('planning-removed');
  });

  test('a publication is announced even when its observation retires after the write is durable', async () => {
    const bus = new RuntimeEventBus();
    const types: string[] = [];
    for (const type of ['WORK_PLAN_TASK_CREATED', 'WORK_PLAN_SNAPSHOT_INVALIDATED'] as const) bus.on(type, () => { types.push(type); });
    const { service, store } = create(bus);
    let retired = false;
    const original = store.upsertOwnedCanonicalSources.bind(store);
    spyOn(store, 'upsertOwnedCanonicalSources').mockImplementation(async (...args: Parameters<typeof original>) => {
      const written = await original(...args);
      retired = true;
      return written;
    });
    await expect(service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) }, {
      assertCurrent: () => { if (retired) throw new Error('retired'); },
    })).rejects.toThrow('was published');
    expect(types).toContain('WORK_PLAN_TASK_CREATED');
    expect(types).toContain('WORK_PLAN_SNAPSHOT_INVALIDATED');
  });

  test('a publication is announced when the store retires the observation inside the commit', async () => {
    const bus = new RuntimeEventBus();
    const types: string[] = [];
    for (const type of ['WORK_PLAN_TASK_CREATED'] as const) bus.on(type, () => { types.push(type); });
    const { service, store } = create(bus);
    const original = store.upsertOwnedCanonicalSources.bind(store);
    spyOn(store, 'upsertOwnedCanonicalSources').mockImplementation((writes, assertCurrent, published) => {
      let committed = false;
      return original(writes, () => { assertCurrent(); if (committed) throw new Error('retired inside commit'); },
        (sources, successor) => { committed = true; published?.(sources, successor); });
    });
    await expect(service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) }))
      .rejects.toThrow('was published');
    expect(types).toContain('WORK_PLAN_TASK_CREATED');
  });

  test('a planning status change replaces the reason an operator gave for the old status', async () => {
    const { service } = create();
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First' }]) });
    const [synced] = await workPlanTasks(service);
    await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId: synced!.taskId, status: 'blocked', reason: 'waiting on X' });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', [{ id: 't1', title: 'First', status: 'completed' }]) });
    const [after] = await workPlanTasks(service);
    expect(after!.status).toBe('done');
    expect(after!.metadata?.statusReason).toBeUndefined();
  });

  test('a deleted planning task stays deleted after its source was changed by a patch', async () => {
    const { service } = create();
    const tasks = [{ id: 't1', title: 'First' }, { id: 't2', title: 'Second' }];
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning', tasks) });
    const [first] = await workPlanTasks(service);
    await service.updateWorkPlanTask({ projectId: 'alpha', taskId: first!.taskId, patch: { source: 'agent' } });
    await service.deleteWorkPlanTask({ projectId: 'alpha', taskId: first!.taskId });
    await service.upsertState({ projectId: 'alpha', state: planningState('Ship planning again', tasks) });
    expect((await workPlanTasks(service)).map((task) => task.taskId)).not.toContain(first!.taskId);
  });
});

describe('work-plan status changes', () => {
  test('a later status change without a reason drops the old reason and takes a new completion time', async () => {
    const { service } = create();
    let clock = 1_000_000;
    const now = spyOn(Date, 'now').mockImplementation(() => clock);
    afterEachRestore.push(() => now.mockRestore());
    const created = await service.createWorkPlanTask({ projectId: 'alpha', task: { title: 'Unit' } });
    const taskId = created.task!.taskId;
    const failed = await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId, status: 'failed', reason: 'tests broke' });
    expect(failed.task!.metadata?.statusReason).toBe('tests broke');
    clock = 2_000_000;
    const done = await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId, status: 'done' });
    expect(done.task!.metadata?.statusReason).toBeUndefined();
    expect(done.task!.completedAt!).toBeGreaterThan(failed.task!.completedAt!);
    const reopened = await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId, status: 'pending' });
    expect(reopened.task!.completedAt).toBeUndefined();
  });

  test('a patch that does not change the status keeps the reason', async () => {
    const { service } = create();
    const created = await service.createWorkPlanTask({ projectId: 'alpha', task: { title: 'Unit' } });
    const taskId = created.task!.taskId;
    await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId, status: 'blocked', reason: 'waiting on review' });
    const patched = await service.updateWorkPlanTask({ projectId: 'alpha', taskId, patch: { notes: 'still waiting' } });
    expect(patched.task!.metadata?.statusReason).toBe('waiting on review');
  });
});

describe('decisions and language', () => {
  test('re-recording a decision by id keeps its creation time and status', async () => {
    const { service } = create();
    const first = await service.recordDecision({ projectId: 'alpha', decision: { title: 'Use sqlite', decision: 'Use sqlite.' } });
    const id = first.decision.id;
    await service.recordDecision({ projectId: 'alpha', decision: { id, title: 'Use sqlite', decision: 'Use sqlite.', status: 'superseded' } });
    const again = await service.recordDecision({ projectId: 'alpha', decision: { id, title: 'Use sqlite', decision: 'Use sqlite, with WAL.' } });
    expect(again.decision.status).toBe('superseded');
    expect(again.decision.createdAt).toBe(first.decision.createdAt);
  });

  test('concurrent language upserts keep both sets of terms', async () => {
    const { service } = create();
    await Promise.all([
      service.upsertLanguage({ projectId: 'alpha', language: { terms: [{ term: 'Surface', definition: 'A channel.' }] } }),
      service.upsertLanguage({ projectId: 'alpha', language: { ambiguities: [{ phrase: 'agent channel', resolution: 'Split it.' }] } }),
    ]);
    const { language } = await service.getLanguage({ projectId: 'alpha' });
    expect(language?.terms.map((term) => term.term)).toEqual(['Surface']);
    expect(language?.ambiguities.map((entry) => entry.phrase)).toEqual(['agent channel']);
  });
});

describe('readiness with an advisory gap', () => {
  const twoTasks = (dependencies: readonly string[]) => ({
    goal: 'Ship it',
    scope: 'platform only',
    tasks: [
      { id: 'a', title: 'A', verification: ['bun test'] },
      { id: 'b', title: 'B', verification: ['bun test'], dependencies: [...dependencies] },
    ],
    executionApproved: true,
  });

  test('an approved plan whose only gap is the missing dependency graph is executable', async () => {
    const { service } = create();
    const result = await service.evaluate({ projectId: 'alpha', state: twoTasks([]) });
    expect(result.gaps.map((gap) => [gap.kind, gap.severity])).toEqual([['missing-dependencies', 'advisory']]);
    expect(result.readiness).toBe('executable');
  });

  test('an unapproved plan with only the advisory gap still asks for approval', async () => {
    const { service } = create();
    const result = await service.evaluate({ projectId: 'alpha', state: { ...twoTasks([]), executionApproved: false } });
    expect(result.readiness).toBe('needs-user-input');
    expect(result.nextQuestion?.id).toBe('approve-execution');
  });

  test('dependencies listed on tasks count as a recorded graph', async () => {
    const { service } = create();
    const result = await service.evaluate({ projectId: 'alpha', state: twoTasks(['a']) });
    expect(result.gaps).toEqual([]);
    expect(result.readiness).toBe('executable');
  });
});
