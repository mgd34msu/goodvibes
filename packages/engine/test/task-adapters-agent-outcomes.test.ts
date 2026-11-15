import { describe, expect, test } from 'bun:test';
// Loaded first: the event bus and telemetry modules import each other, and only this entry order initialises them cleanly.
import '../platform/src/platform/runtime/telemetry/api-helpers.js';
import {
  emitAgentCancelled, emitAgentCompleted, emitAgentFailed, emitAgentRunning, emitAgentSpawning,
} from '../platform/src/platform/runtime/emitters/agents.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { AcpTaskAdapter } from '../platform/src/platform/runtime/tasks/adapters/acp-adapter.js';
import { AgentTaskAdapter } from '../platform/src/platform/runtime/tasks/adapters/agent-adapter.js';

type AcpManager = Parameters<AcpTaskAdapter['sync']>[0];
type SubagentInfo = ReturnType<AcpManager['getActive']>[number];
const manager = (active: () => SubagentInfo[]): AcpManager => ({ getActive: active }) as unknown as AcpManager;
const info = (id: string): SubagentInfo => ({ id, task: 'Refactor', status: 'running' }) as unknown as SubagentInfo;
/** The bus hands each event to its listeners in a microtask. */
const delivered = (): Promise<void> => new Promise((resolve) => { queueMicrotask(resolve); });
const managerCtx = { sessionId: 'acp-manager', traceId: 't', source: 'acp-manager' };
const connectionCtx = { sessionId: 'acp-connection', traceId: 't', source: 'acp-connection' };

describe('AcpTaskAdapter', () => {
  test('a subagent that finishes is recorded as completed, not cancelled', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const adapter = new AcpTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
    let active = [info('a1')];
    const acp = manager(() => active);
    adapter.sync(acp);
    emitAgentCompleted(bus, connectionCtx, { agentId: 'a1', durationMs: 5, output: 'ok' });
    await delivered();
    active = [];
    adapter.sync(acp);
    const tasks = [...store.getState().tasks.tasks.values()];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'acp', status: 'completed' });
  });

  test('a failure keeps its cause, and a subagent shorter than one poll still gets a task', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    new AcpTaskAdapter(store).attachRuntimeBus(bus);
    emitAgentSpawning(bus, managerCtx, { agentId: 'a2', task: 'Quick job' });
    await delivered();
    emitAgentFailed(bus, connectionCtx, { agentId: 'a2', error: 'boom', durationMs: 1 });
    await delivered();
    const task = [...store.getState().tasks.tasks.values()][0];
    expect(task).toMatchObject({ status: 'failed' });
    expect(task?.error).toContain('boom');
  });

  test('a subagent that vanishes without a terminal event is not reported as cancelled', async () => {
    const store = createRuntimeStore();
    const adapter = new AcpTaskAdapter(store);
    let active = [info('a3')];
    const acp = manager(() => active);
    adapter.sync(acp);
    active = [];
    adapter.sync(acp);
    const task = [...store.getState().tasks.tasks.values()][0];
    expect(task?.status).toBe('failed');
    expect(task?.error).toContain('no outcome');
  });

  test('an explicit cancel event is recorded as cancelled', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    new AcpTaskAdapter(store).attachRuntimeBus(bus);
    emitAgentSpawning(bus, managerCtx, { agentId: 'a4', task: 'Job' });
    await delivered();
    emitAgentCancelled(bus, connectionCtx, { agentId: 'a4', reason: 'stop' });
    await delivered();
    expect([...store.getState().tasks.tasks.values()][0]?.status).toBe('cancelled');
  });
});

describe('AgentTaskAdapter', () => {
  const ctx = { sessionId: 's1', traceId: 't', source: 'test' };

  test('a failed agent task carries the failure cause', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
    const taskId = adapter.wrapAgent('ag1', 'Work', { sessionId: 's1' });
    emitAgentFailed(bus, ctx, { agentId: 'ag1', error: 'boom', durationMs: 1 });
    await delivered();
    expect(store.getState().tasks.tasks.get(taskId)?.error).toContain('boom');
  });

  test('a running agent moves its task out of queued', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
    const taskId = adapter.wrapAgent('ag2', 'Work', { sessionId: 's1' });
    emitAgentRunning(bus, ctx, { agentId: 'ag2' });
    await delivered();
    expect(store.getState().tasks.tasks.get(taskId)?.status).toBe('running');
  });

  test('wrapping with a caller-supplied task id keeps one task per agent', async () => {
    const store = createRuntimeStore();
    const adapter = new AgentTaskAdapter(store);
    adapter.wrapAgent('ag3', 'Work', { sessionId: 's1' }, 'ag3');
    adapter.wrapAgent('ag3', 'Work', { sessionId: 's1' }, 'ag3');
    expect([...store.getState().tasks.tasks.keys()]).toEqual(['ag3']);
  });

  test('an agent woken after completing gets a fresh task that finishes on its own', async () => {
    const store = createRuntimeStore();
    const bus = new RuntimeEventBus();
    const adapter = new AgentTaskAdapter(store);
    adapter.attachRuntimeBus(bus);
    const first = adapter.wrapAgent('ag4', 'Work', { sessionId: 's1' });
    emitAgentCompleted(bus, ctx, { agentId: 'ag4', durationMs: 1 });
    await delivered();
    emitAgentRunning(bus, ctx, { agentId: 'ag4', wake: true });
    await delivered();
    const running = [...store.getState().tasks.tasks.values()].filter((task) => task.status === 'running');
    expect(running).toHaveLength(1);
    expect(running[0]?.id).not.toBe(first);
    emitAgentCompleted(bus, ctx, { agentId: 'ag4', durationMs: 1 });
    await delivered();
    expect([...store.getState().tasks.tasks.values()].every((task) => task.status === 'completed')).toBe(true);
  });
});
