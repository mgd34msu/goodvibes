/**
 * runtime-task-retry-ownership.test.ts
 *
 * POST /api/tasks/:id/retry spawns a NEW agent for the task, but the task
 * record's `owner` used to keep naming the previous, already-terminal agent.
 * The reducer merges the transition patch over the existing record, so nothing
 * downstream repaired it, and POST /api/tasks/:id/cancel reads exactly that
 * field: the operator got a 200 with the task marked cancelled while
 * AgentManager.cancel() no-oped on a dead id and the retried agent kept
 * running.
 */

import { describe, expect, test } from 'bun:test';
import { createDaemonRuntimeSessionRouteHandlers } from '../daemon-api/src/runtime-session-routes.js';
import type { DaemonRuntimeRouteContext } from '../daemon-api/src/runtime-route-types.js';
import { createDomainDispatch, createRuntimeStore, type RuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import type { RuntimeTask } from '../platform/src/platform/runtime/store/domains/tasks.js';

interface Harness {
  readonly handlers: ReturnType<typeof createDaemonRuntimeSessionRouteHandlers>;
  readonly store: RuntimeStore;
  readonly task: (id: string) => RuntimeTask | undefined;
  readonly cancelled: string[];
  readonly spawned: string[];
}

/** The real runtime store and dispatch hold the task; only the agent manager and spawner are fakes. */
function makeHarness(taskId: string, initial: Partial<RuntimeTask> & Pick<RuntimeTask, 'owner' | 'status'>, options: { readonly withRetryGate?: boolean } = { withRetryGate: true }): Harness {
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  dispatch.syncRuntimeTask({
    id: taskId, kind: 'agent', title: 'task', cancellable: true, childTaskIds: [], queuedAt: 1, ...initial,
  });
  const cancelled: string[] = [];
  const spawned: string[] = [];
  let nextAgent = 0;

  const context = {
    parseJsonBody: async () => ({}),
    parseOptionalJsonBody: async () => null,
    recordApiResponse: (_req: unknown, _path: unknown, response: Response) => response,
    requireAdmin: () => null,
    agentManager: {
      getStatus: () => null,
      // Mirrors AgentManager.cancel: unknown/terminal ids are a silent no-op.
      cancel: (id: string) => { cancelled.push(id); return false; },
    },
    trySpawnAgent: () => {
      nextAgent += 1;
      const id = `agent-spawned-${nextAgent}`;
      spawned.push(id);
      return { id, status: 'running', task: 'retried', tools: [], startedAt: Date.now() };
    },
    syncSpawnedAgentTask: () => {},
    syncFinishedAgentTask: () => {},
    configManager: { get: () => undefined },
    runtimeStore: store,
    // Without the eligibility gate the route must still catch a retry the store refuses.
    runtimeDispatch: options.withRetryGate === false ? { ...dispatch, canRetryRuntimeTask: undefined } : dispatch,
    publishConversationFollowup: () => {},
    openSessionEventStream: () => new Response('stream', { status: 200 }),
  } as unknown as DaemonRuntimeRouteContext;

  return {
    handlers: createDaemonRuntimeSessionRouteHandlers(context),
    store,
    task: (id) => store.getState().tasks.tasks.get(id),
    cancelled,
    spawned,
  };
}

function actionRequest(taskId: string, action: string): Request {
  return new Request(`http://localhost/api/tasks/${taskId}/${action}`, { method: 'POST' });
}

describe('retrying a runtime task moves ownership to the agent that is actually running', () => {
  test('cancel after retry reaches the retried agent, not the dead one', async () => {
    const taskId = 'task-1';
    const harness = makeHarness(taskId, {
      owner: 'agent-dead',
      status: 'failed',
      description: 'do the thing',
      error: 'boom',
      endedAt: 1,
    });

    const retry = await harness.handlers.runtimeTaskAction(taskId, 'retry', actionRequest(taskId, 'retry'));
    expect(retry.status).toBe(200);
    const retryBody = await retry.json() as { agentId: string; retried: boolean };
    expect(retryBody.retried).toBe(true);
    expect(harness.spawned).toEqual([retryBody.agentId]);

    // Before the fix the record still said 'agent-dead' here.
    expect(harness.task(taskId)?.owner).toBe(retryBody.agentId);
    expect(harness.task(taskId)?.status).toBe('queued');
    expect(harness.task(taskId)?.error).toBeUndefined();

    const cancel = await harness.handlers.runtimeTaskAction(taskId, 'cancel', actionRequest(taskId, 'cancel'));
    expect(cancel.status).toBe(200);
    expect(harness.cancelled).toEqual([retryBody.agentId]);
    expect(harness.task(taskId)?.status).toBe('cancelled');
  });

  test('cancel without a retry still targets the original owner', async () => {
    const taskId = 'task-2';
    const harness = makeHarness(taskId, { owner: 'agent-original', status: 'running' });

    const cancel = await harness.handlers.runtimeTaskAction(taskId, 'cancel', actionRequest(taskId, 'cancel'));
    expect(cancel.status).toBe(200);
    expect(harness.cancelled).toEqual(['agent-original']);
  });

  test('retry of a completed task is refused before any agent is spawned', async () => {
    const taskId = 'task-3';
    const harness = makeHarness(taskId, { owner: 'agent-done', status: 'completed', description: 'x' });
    const retry = await harness.handlers.runtimeTaskAction(taskId, 'retry', actionRequest(taskId, 'retry'));
    expect(retry.status).toBe(400);
    const body = await retry.json() as { error: string; retried?: boolean };
    expect(body.error).toContain('failed');
    expect(body.error).toContain('cancelled');
    expect(body.retried).toBeUndefined();
    expect(harness.spawned).toEqual([]);
    expect(harness.task(taskId)?.owner).toBe('agent-done');
    expect(harness.task(taskId)?.status).toBe('completed');
  });

  test('a refused transition is never reported as retried; the spawned agent is cancelled', async () => {
    const taskId = 'task-4';
    const harness = makeHarness(taskId, { owner: 'agent-done', status: 'completed', description: 'x' }, { withRetryGate: false });
    const retry = await harness.handlers.runtimeTaskAction(taskId, 'retry', actionRequest(taskId, 'retry'));
    expect(retry.status).toBe(400);
    const body = await retry.json() as { retried?: boolean };
    expect(body.retried).toBeUndefined();
    expect(harness.cancelled).toEqual(harness.spawned);
    expect(harness.task(taskId)?.owner).toBe('agent-done');
  });
});
