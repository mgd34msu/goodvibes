import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ProjectPlanningService } from '../platform/src/platform/knowledge/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';

let previousPort: JudgmentPort | undefined;
const roots: string[] = [];
const stores: KnowledgeStore[] = [];
beforeEach(() => { previousPort = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port); });
afterEach(async () => {
  installJudgmentPort(previousPort);
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function create(): { service: ProjectPlanningService; store: KnowledgeStore } {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-work-plan-concurrency-'));
  roots.push(root);
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  return { service: new ProjectPlanningService(store, { defaultProjectId: 'default-project' }), store };
}

test('overlapping status changes to different tasks of one plan are all kept', async () => {
  const { service, store } = create();
  const a = await service.createWorkPlanTask({ projectId: 'alpha', task: { title: 'Unit one' } });
  const b = await service.createWorkPlanTask({ projectId: 'alpha', task: { title: 'Unit two' } });
  await Promise.all([
    service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId: a.task!.taskId, status: 'done' }),
    service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId: b.task!.taskId, status: 'in_progress' }),
    store.upsertUsageRecord({ targetKind: 'source', targetId: 'unrelated', usageKind: 'search-hit' }),
  ]);
  const snapshot = await service.getWorkPlanSnapshot({ projectId: 'alpha' });
  expect(Object.fromEntries(snapshot.tasks.map((task) => [task.taskId, task.status]))).toEqual({
    [a.task!.taskId]: 'done',
    [b.task!.taskId]: 'in_progress',
  });
});

test('a retried create still reports a task that already exists', async () => {
  const { service } = create();
  const first = await service.createWorkPlanTask({ projectId: 'alpha', task: { taskId: 'fixed', title: 'Fixed id' } });
  expect(first.task?.taskId).toBe('fixed');
  await expect(service.createWorkPlanTask({ projectId: 'alpha', task: { taskId: 'fixed', title: 'Again' } })).rejects.toThrow('fixed');
});
