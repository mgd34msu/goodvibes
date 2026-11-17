/**
 * The one work plan: every app (terminal, Agent, daemon) keeps a project's
 * plan as rows in one shared file. Edits made at the same time, in one app or
 * in two, are all kept, and an app hears another app's commit.
 */
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

function create(root = mkdtempSync(join(tmpdir(), 'goodvibes-work-plan-concurrency-'))): { root: string; rowsPath: string; service: ProjectPlanningService; store: KnowledgeStore } {
  if (!roots.includes(root)) roots.push(root);
  const rowsPath = join(root, 'work-plans.sqlite');
  // Each app has its own knowledge database; the plan rows are the one shared file.
  const store = new KnowledgeStore({ dbPath: join(mkdtempSync(join(root, 'app-')), 'knowledge.sqlite') });
  stores.push(store);
  return { root, rowsPath, service: new ProjectPlanningService(store, { defaultProjectId: 'default-project', workPlanRowsPath: rowsPath }), store };
}

/** The other app: its own process and knowledge database, editing the same plan file. */
const OTHER_APP = `
  import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
  import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
  import { ProjectPlanningService } from './platform/src/platform/knowledge/index.ts';
  import { KnowledgeStore } from './platform/src/platform/knowledge/store.ts';
  installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const [rowsPath, knowledgePath, ...taskIds] = process.argv.slice(1);
  const store = new KnowledgeStore({ dbPath: knowledgePath });
  const service = new ProjectPlanningService(store, { defaultProjectId: 'default-project', workPlanRowsPath: rowsPath });
  await service.getWorkPlanSnapshot({ projectId: 'alpha' });
  const input = Bun.stdin.stream().getReader();
  console.log('started');
  // Several rounds over every task, ending at done, while the first app edits the same tasks.
  for (const status of ['in_progress', 'blocked', 'pending', 'in_progress', 'done']) {
    for (const taskId of taskIds) await service.setWorkPlanTaskStatus({ projectId: 'alpha', taskId, status });
  }
  console.log('done');
  // Once told, a quick burst of edits, so the first app must hear the burst's last commit.
  while (!(await input.read()).done) { /* until the first app closes the pipe */ }
  for (const taskId of taskIds) await service.updateWorkPlanTask({ projectId: 'alpha', taskId, patch: { owner: 'other app' } });
  await store.close();
`;

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

test('a retried create of a task that already exists is refused, not added twice', async () => {
  const { service } = create();
  const first = await service.createWorkPlanTask({ projectId: 'alpha', task: { taskId: 'fixed', title: 'Fixed id' } });
  expect(first.task?.taskId).toBe('fixed');
  await expect(service.createWorkPlanTask({ projectId: 'alpha', task: { taskId: 'fixed', title: 'Again' } })).rejects.toThrow('fixed');
  expect((await service.getWorkPlanSnapshot({ projectId: 'alpha' })).tasks.map((task) => task.title)).toEqual(['Fixed id']);
});

test('two apps editing the same tasks at the same time lose no edit, and each hears the other', async () => {
  const mine = create();
  const ids: string[] = [];
  for (const n of [1, 2, 3, 4, 5, 6]) ids.push((await mine.service.createWorkPlanTask({ projectId: 'alpha', task: { title: `Unit ${n}` } })).task!.taskId);
  // Heard when a notice finds the other app's last edit in the plan.
  let heardLast!: () => void;
  const lastHeard = new Promise<void>((resolve) => { heardLast = resolve; });
  const stop = mine.service.subscribeWorkPlan({ projectId: 'alpha' }, () => {
    if (mine.service.getWorkPlanSnapshotNow({ projectId: 'alpha' }).tasks.every((task) => task.owner === 'other app')) heardLast();
  });

  const other = Bun.spawn([
    process.execPath, '--no-env-file', '--preload', new URL('../toolchain/src/test-runner/test-network-preload.ts', import.meta.url).pathname,
    '-e', OTHER_APP, mine.rowsPath, join(mkdtempSync(join(mine.root, 'other-app-')), 'knowledge.sqlite'), ...ids,
  ], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const out = other.stdout.getReader();
  let printed = '';
  const line = async (wanted: string) => {
    while (!printed.includes(`${wanted}\n`)) {
      const chunk = await out.read();
      if (chunk.done) throw new Error(`The other app ended before printing ${wanted}`);
      printed += new TextDecoder().decode(chunk.value);
    }
  };
  try {
    await line('started');
    // While the other app moves every task's status, this one writes notes on every task.
    for (const round of [1, 2, 3, 4, 5]) {
      for (const taskId of ids) await mine.service.updateWorkPlanTask({ projectId: 'alpha', taskId, patch: { notes: round === 5 ? `checked ${taskId}` : `round ${round}` } });
    }
    await line('done');

    // With this app's own writes finished, the other app's burst of edits is
    // heard, up to its last commit: the shared file is watched, not polled. The
    // wait is on that notice itself; if it never comes, the runner's per-test
    // limit fails the proof.
    other.stdin.end();
    const [exit, error] = await Promise.all([other.exited, new Response(other.stderr).text()]);
    expect({ exit, error }).toEqual({ exit: 0, error: '' });
    await lastHeard;

    const reader = create(mine.root);
    const tasks = (await reader.service.getWorkPlanSnapshot({ projectId: 'alpha' })).tasks;
    expect(tasks.map((task) => [task.taskId, task.status, task.notes])).toEqual(ids.map((taskId) => [taskId, 'done', `checked ${taskId}`]));
    expect(tasks.every((task) => task.owner === 'other app')).toBe(true);
  } finally {
    stop();
    out.releaseLock();
    if (other.exitCode === null) other.kill();
    await other.exited;
  }
});
