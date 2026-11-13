/**
 * Retry is a declared, single exception to "failed/cancelled are final"; the
 * store helper behind the task adapters consults the table; a terminal task is
 * not overwritten, and process sync does not re-apply a finished process.
 */
import { describe, expect, test } from 'bun:test';
import {
  canRetry,
  canTransition,
  isTerminalStatus,
  RETRYABLE_TASK_STATES,
  taskLifecycle,
} from '../platform/src/platform/runtime/tasks/lifecycle.ts';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import type { RuntimeTask, TaskLifecycleState } from '../platform/src/platform/runtime/store/domains/tasks.ts';
import { ProcessTaskAdapter } from '../platform/src/platform/runtime/tasks/adapters/process-adapter.ts';

function task(id: string, status: TaskLifecycleState): RuntimeTask {
  return { id, kind: 'exec', title: id, status, owner: 'o', cancellable: true, childTaskIds: [], queuedAt: 1 } as RuntimeTask;
}

describe('task lifecycle retry exception', () => {
  test('failed and cancelled stay terminal but are retryable', () => {
    expect([...RETRYABLE_TASK_STATES].sort()).toEqual(['cancelled', 'failed']);
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('cancelled')).toBe(true);
    expect(canRetry('completed')).toBe(false);
    expect(canRetry('running')).toBe(false);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('completed')).toBe(true);
  });

  test('declares the blocked re-queue that failTask with a retry policy performs', () => {
    expect(canTransition('blocked', 'queued')).toBe(true);
    expect(taskLifecycle.can('running', 'queued')).toBe(true);
  });
});

describe('transitionRuntimeTask honours the table', () => {
  function setup(status: TaskLifecycleState) {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.syncRuntimeTask(task('t', status), 'test');
    return { store, dispatch, get: () => store.getState().tasks.tasks.get('t')! };
  }

  test('a completed task is not overwritten by a late cancelled', () => {
    const { dispatch, get } = setup('completed');
    dispatch.transitionRuntimeTask('t', 'cancelled', { endedAt: 99 }, 'test');
    expect(get().status).toBe('completed');
    expect(get().endedAt).toBeUndefined();
  });

  test('a terminal task re-applied with the same status keeps its endedAt', () => {
    const { dispatch, get } = setup('running');
    dispatch.transitionRuntimeTask('t', 'completed', { endedAt: 10 }, 'test');
    dispatch.transitionRuntimeTask('t', 'completed', { endedAt: 20 }, 'test');
    expect(get().endedAt).toBe(10);
  });

  test('legitimate adapter moves are accepted', () => {
    for (const [from, to] of [
      ['queued', 'running'], ['queued', 'completed'], ['queued', 'failed'], ['queued', 'cancelled'],
      ['running', 'completed'], ['running', 'failed'], ['running', 'cancelled'], ['running', 'running'],
      ['queued', 'queued'], ['failed', 'queued'], ['cancelled', 'queued'],
    ] as const) {
      const { dispatch, get } = setup(from);
      dispatch.transitionRuntimeTask('t', to, {}, 'test');
      expect(`${from}->${to}:${get().status}`).toBe(`${from}->${to}:${to}`);
    }
  });

  test('an illegal move leaves the store unchanged', () => {
    const { store, dispatch } = setup('queued');
    const before = store.getState();
    dispatch.transitionRuntimeTask('t', 'blocked', {}, 'test');
    // queued -> blocked is not declared
    expect(store.getState().tasks.tasks.get('t')!.status).toBe('queued');
    expect(store.getState().tasks).toBe(before.tasks);
  });
});

describe('ProcessTaskAdapter.sync', () => {
  function fakeManager() {
    const state = { done: false, exitCode: 0 as number | undefined };
    const manager = {
      list: () => [{ id: 'bg_1', pid: 1, cmd: 'sleep' }],
      getStatus: () => ({ pid: 1, done: state.done, exitCode: state.exitCode }),
      stop: () => {},
    };
    return { state, manager: manager as never };
  }

  test('repeated sync of a done process does not rewrite endedAt', async () => {
    const store = createRuntimeStore();
    const { state, manager } = fakeManager();
    const adapter = new ProcessTaskAdapter(store, manager);
    adapter.sync();
    state.done = true;
    adapter.sync();
    const id = [...store.getState().tasks.tasks.keys()][0]!;
    const first = store.getState().tasks.tasks.get(id)!.endedAt;
    expect(store.getState().tasks.tasks.get(id)!.status).toBe('completed');
    await new Promise((r) => setTimeout(r, 5));
    adapter.sync();
    expect(store.getState().tasks.tasks.get(id)!.endedAt).toBe(first);
  });

  test('a cancelled task is not overwritten by a later sync of the stopped process', () => {
    const store = createRuntimeStore();
    const { state, manager } = fakeManager();
    const adapter = new ProcessTaskAdapter(store, manager);
    adapter.sync();
    const id = [...store.getState().tasks.tasks.keys()][0]!;
    adapter.cancelProcess(id);
    expect(store.getState().tasks.tasks.get(id)!.status).toBe('cancelled');
    state.done = true;
    state.exitCode = 0;
    adapter.sync();
    expect(store.getState().tasks.tasks.get(id)!.status).toBe('cancelled');
  });
});
