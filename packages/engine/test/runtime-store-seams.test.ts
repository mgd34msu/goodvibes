import { describe, expect, test } from 'bun:test';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { SchedulerTaskAdapter } from '../platform/src/platform/runtime/tasks/adapters/scheduler-adapter.js';
import type { ScheduledTask, TaskRunRecord } from '../platform/src/platform/scheduler/scheduler.js';

describe('runtime store lifecycle seams', () => {
  test('task events do not synthesize records or double-count terminal state', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'missing-task', durationMs: 1 });
    expect(store.getState().tasks.tasks.has('missing-task')).toBe(false);
    expect(store.getState().tasks.totalCompleted).toBe(0);

    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 'task-1', description: 'Run build', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 'task-1', description: 'Run build again', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 'task-1' });
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'task-1', durationMs: 12 });
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 'task-1', durationMs: 24 });
    dispatch.dispatchTaskEvent({ type: 'TASK_FAILED', taskId: 'task-1', error: 'late failure', durationMs: 30 });

    const tasks = store.getState().tasks;
    expect(tasks.totalCreated).toBe(1);
    expect(tasks.totalCompleted).toBe(1);
    expect(tasks.totalFailed).toBe(0);
    expect(tasks.tasks.get('task-1')?.status).toBe('completed');
  });

  test('agent events do not synthesize records or double-count terminal state', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'missing-agent', durationMs: 1 });
    expect(store.getState().agents.agents.has('missing-agent')).toBe(false);
    expect(store.getState().agents.totalCompleted).toBe(0);

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Inspect state' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-1', task: 'Inspect state again' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'agent-1' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 12 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'agent-1', durationMs: 24 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'agent-1', error: 'late failure', durationMs: 30 });

    const agents = store.getState().agents;
    expect(agents.totalSpawned).toBe(1);
    expect(agents.totalCompleted).toBe(1);
    expect(agents.totalFailed).toBe(0);
    expect(agents.agents.get('agent-1')?.status).toBe('completed');
  });

  test('AGENT_COMPLETED usage populates RuntimeAgent.usage; omitting it leaves usage undefined', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-usage', task: 'Do work' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'agent-usage' });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_COMPLETED',
      agentId: 'agent-usage',
      durationMs: 12,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
    });

    expect(store.getState().agents.agents.get('agent-usage')?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });

    // A second agent whose AGENT_COMPLETED omits usage must not fabricate a zeroed reading.
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'agent-no-usage', task: 'Do other work' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'agent-no-usage', durationMs: 5 });
    expect(store.getState().agents.agents.get('agent-no-usage')?.usage).toBeUndefined();
  });

  test('contract owner running/progress events can revive a prematurely terminal owner record', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'owner-1', task: 'Run the contract' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'owner-1', durationMs: 10, output: 'premature' });
    expect(store.getState().agents.agents.get('owner-1')?.status).toBe('completed');
    expect(store.getState().agents.totalCompleted).toBe(1);

    dispatch.dispatchAgentEvent({
      type: 'AGENT_RUNNING',
      agentId: 'owner-1',
      contractId: 'ctr-00000001',
      contractRole: 'owner',
    });
    dispatch.dispatchAgentEvent({
      type: 'AGENT_PROGRESS',
      agentId: 'owner-1',
      progress: 'Contract owner waiting on its units',
      contractId: 'ctr-00000001',
      contractRole: 'owner',
    });

    const agent = store.getState().agents.agents.get('owner-1');
    expect(agent?.status).toBe('running');
    expect(agent?.endedAt).toBeUndefined();
    expect(agent?.result).toBeUndefined();
    expect(agent?.contractRef).toEqual({ contractId: 'ctr-00000001', contractRole: 'owner', contractUnitId: undefined });
    expect(store.getState().agents.activeAgentIds).toContain('owner-1');
    expect(store.getState().agents.totalCompleted).toBe(0);
  });

  test('only the contract owner is revived: a finished unit agent stays finished', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'unit-1', task: 'Write the parser' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'unit-1', durationMs: 10, output: 'done' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'unit-1', contractId: 'ctr-00000001', contractRole: 'unit', contractUnitId: 'u1' });
    expect(store.getState().agents.agents.get('unit-1')?.status).toBe('completed');

    // An owner event without a contract id is not a contract owner's and revives nothing either.
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'owner-2', task: 'Run the contract' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'owner-2', durationMs: 10 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'owner-2', contractRole: 'owner' });
    expect(store.getState().agents.agents.get('owner-2')?.status).toBe('completed');
  });

  test('a woken run comes back to running only through its marked AGENT_RUNNING; a cancelled run never does', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    const wake = { wake: true } as const;

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'worker-1', task: 'Fix the parser' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'worker-1', error: 'turn budget', durationMs: 5 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'worker-1' });
    expect(store.getState().agents.agents.get('worker-1')?.status).toBe('failed');

    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'worker-1', ...wake });
    const woken = store.getState().agents.agents.get('worker-1');
    expect(woken?.status).toBe('running');
    expect(woken?.endedAt).toBeUndefined();
    expect(woken?.error).toBeUndefined();
    expect(store.getState().agents.totalFailed).toBe(0);
    expect(store.getState().agents.activeAgentIds).toContain('worker-1');

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'worker-2', task: 'Stopped work' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId: 'worker-2' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_RUNNING', agentId: 'worker-2', ...wake });
    expect(store.getState().agents.agents.get('worker-2')?.status).toBe('cancelled');
  });

  test('progress and output do not clear a wait; a repeated terminal event keeps the first outcome', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    const agent = () => store.getState().agents.agents.get('w1');

    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'w1', task: 'Wait on a tool' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_PROGRESS', agentId: 'w1', progress: 'starting' } as never);
    expect(agent()?.status).toBe('running');
    dispatch.dispatchAgentEvent({ type: 'AGENT_AWAITING_TOOL', agentId: 'w1', callId: 'c1', tool: 'exec' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_PROGRESS', agentId: 'w1', progress: 'still waiting' } as never);
    dispatch.dispatchAgentEvent({ type: 'AGENT_STREAM_DELTA', agentId: 'w1', accumulated: 'partial', delta: 'partial' } as never);
    expect(agent()?.status).toBe('awaiting_tool');
    expect(agent()?.latestOutput).toBe('partial');

    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'w1', durationMs: 5, output: 'first' });
    const firstEnd = agent()?.endedAt;
    dispatch.dispatchAgentEvent({ type: 'AGENT_COMPLETED', agentId: 'w1', durationMs: 99, output: 'second' });
    expect(agent()?.endedAt).toBe(firstEnd);
    expect(agent()?.result).toMatchObject({ durationMs: 5, output: 'first' });
    expect(store.getState().agents.totalCompleted).toBe(1);
  });

  test('a direct transition cannot move a finished agent back to a live state', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'w2', task: 'Done already' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'w2', error: 'x', durationMs: 1 });
    dispatch.transitionRuntimeAgent('w2', 'running', undefined, 'test');
    expect(store.getState().agents.agents.get('w2')?.status).toBe('failed');
  });

  test('scheduler adapter preserves failed run status when wrapping history', () => {
    const store = createRuntimeStore();
    const adapter = new SchedulerTaskAdapter(store);
    const run: TaskRunRecord = {
      taskId: 'scheduled-1',
      agentId: 'run-agent-1',
      startedAt: Date.now(),
      status: 'failed',
      error: 'scheduled job failed',
    };
    const scheduledTask: ScheduledTask = {
      id: 'scheduled-1',
      name: 'Nightly check',
      cron: '0 0 * * *',
      prompt: 'Check runtime state',
      enabled: true,
      runCount: 1,
      missedRuns: 0,
      createdAt: Date.now(),
    };

    const taskId = adapter.wrapScheduledRun(run, scheduledTask);
    const task = store.getState().tasks.tasks.get(taskId);

    expect(task?.status).toBe('failed');
    expect(task?.error).toBe('scheduled job failed');
    expect(store.getState().tasks.totalFailed).toBe(1);
  });
});
