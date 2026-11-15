import { expect, test } from 'bun:test';
import { OpsControlPlane, OpsIllegalActionError } from '../platform/src/platform/runtime/ops/control-plane.ts';
import { UnifiedTaskManager } from '../platform/src/platform/runtime/tasks/manager.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

test('a queued task is not resumable: resume is rejected with an audit, and the task stays queued', async () => {
  const store = createRuntimeStore();
  const bus = new RuntimeEventBus();
  const tasks = new UnifiedTaskManager(store, bus, 'sess-ops');
  const ops = new OpsControlPlane(tasks, bus, store, 'sess-ops');
  const outcomes: unknown[] = [];
  bus.onDomain('ops', (envelope) => {
    const payload = envelope.payload as { action?: unknown; outcome?: unknown };
    if (envelope.type === 'OPS_AUDIT' && payload.action === 'task.resume') outcomes.push(payload.outcome);
  });
  const task = tasks.createTask({ kind: 'exec', title: 'waiting its turn', owner: 'test' });

  expect(ops.canResumeTask(task.id)).toBe(false);
  expect(() => ops.resumeTask(task.id)).toThrow(OpsIllegalActionError);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(tasks.getTask(task.id)!.status).toBe('queued');
  expect(outcomes).toEqual(['rejected']);
});
