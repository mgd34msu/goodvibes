import { describe, expect, test } from 'bun:test';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import type { RuntimeTask } from '../platform/src/platform/runtime/store/domains/tasks.js';
import type { AutomationRun } from '../platform/src/platform/automation/runs.js';
import type { SurfaceRecord } from '../platform/src/platform/runtime/store/domains/surfaces.js';

function fresh() {
  const store = createRuntimeStore();
  return { store, dispatch: createDomainDispatch(store) };
}

describe('plugin reducer', () => {
  test('a plugin that errors after being active is no longer listed as active', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_DISCOVERED', pluginId: 'p', path: '/p', version: '1' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: 'p' });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ERROR', pluginId: 'p', error: 'boom', fatal: false });
    const plugins = store.getState().plugins;
    expect(plugins.activePluginNames).toEqual([]);
    expect(plugins.erroredPluginNames).toEqual(['p']);
  });

  test('a disabled plugin that loads again is enabled, and recovery clears its error', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_DISABLED', pluginId: 'p', reason: 'off' });
    expect(store.getState().plugins.plugins.get('p')?.enabled).toBe(false);
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ERROR', pluginId: 'p', error: 'boom', fatal: false });
    dispatch.dispatchPluginEvent({ type: 'PLUGIN_ACTIVE', pluginId: 'p' });
    const plugin = store.getState().plugins.plugins.get('p');
    expect(plugin?.enabled).toBe(true);
    expect(plugin?.error).toBeUndefined();
  });
});

describe('mcp reducer', () => {
  test('approving a quarantined schema, and reconnecting, clear the quarantine reason and last error', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchMcpEvent({ type: 'MCP_SCHEMA_QUARANTINED', serverId: 's', reason: 'schema-drift' as never, detail: 'changed' });
    expect(store.getState().mcp.servers.get('s')?.quarantineReason).toBeDefined();
    dispatch.dispatchMcpEvent({ type: 'MCP_SCHEMA_QUARANTINE_APPROVED', serverId: 's', operatorId: 'op' });
    const approved = store.getState().mcp.servers.get('s');
    expect(approved?.quarantineReason).toBeUndefined();
    expect(approved?.quarantineDetail).toBeUndefined();
    dispatch.dispatchMcpEvent({ type: 'MCP_DEGRADED', serverId: 's', reason: 'slow', availableTools: [] });
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 's', toolCount: 2, resourceCount: 0 });
    expect(store.getState().mcp.servers.get('s')?.lastError).toBeUndefined();
  });
});

describe('transport reducer', () => {
  test('a transport owned by neither ACP nor the daemon does not change daemon state', () => {
    const { store, dispatch } = fresh();
    const before = store.getState().daemon;
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_TERMINAL_FAILURE', transportId: 'ws-1', error: 'x' });
    expect(store.getState().daemon).toBe(before);
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_CONNECTED', transportId: 'daemon:http:127.0.0.1:3421', endpoint: 'http://127.0.0.1:3421' });
    expect(store.getState().daemon.isRunning).toBe(true);
  });
});

describe('contract reducer', () => {
  const created = { type: 'CONTRACT_CREATED', contractId: 'c1', sessionId: 's', origin: 'user' as never, ask: 'do', ownerAgentId: 'a' } as const;

  test('an ended contract keeps its first outcome and counts once', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchContractEvent(created);
    dispatch.dispatchContractEvent({ type: 'CONTRACT_PASSED', contractId: 'c1', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_CANCELLED', contractId: 'c1', reason: 'late', filesModified: 0 });
    dispatch.dispatchContractEvent({ type: 'CONTRACT_STATUS_CHANGED', contractId: 'c1', from: 'passed', to: 'running' });
    const contracts = store.getState().contracts;
    expect(contracts.contracts.get('c1')?.status).toBe('passed');
    expect(contracts.totalPassed).toBe(1);
    expect(contracts.totalCancelled).toBe(0);
    expect(contracts.activeContractIds).toEqual([]);
  });

  test('a late event for an evicted contract does not bring it back', () => {
    const { store, dispatch } = fresh();
    for (let index = 0; index < 205; index++) {
      dispatch.dispatchContractEvent({ ...created, contractId: `c${index}` });
      dispatch.dispatchContractEvent({ type: 'CONTRACT_PASSED', contractId: `c${index}`, criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
    }
    expect(store.getState().contracts.contracts.has('c0')).toBe(false);
    const total = store.getState().contracts.totalContracts;
    dispatch.dispatchContractEvent({ type: 'CONTRACT_STATUS_CHANGED', contractId: 'c0', from: 'passed', to: 'running' });
    expect(store.getState().contracts.contracts.has('c0')).toBe(false);
    expect(store.getState().contracts.totalContracts).toBe(total);
    expect(store.getState().contracts.activeContractIds).toEqual([]);
  });
});

describe('agent reducer', () => {
  test('a cancelled contract owner is not revived by a late progress event', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'o', task: 'own' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_CANCELLED', agentId: 'o' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_PROGRESS', agentId: 'o', progress: 'still going', contractRole: 'owner', contractId: 'c' } as never);
    expect(store.getState().agents.agents.get('o')?.status).toBe('cancelled');
  });

  test('a failed contract owner is still revived by its own progress', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchAgentEvent({ type: 'AGENT_SPAWNING', agentId: 'o', task: 'own' });
    dispatch.dispatchAgentEvent({ type: 'AGENT_FAILED', agentId: 'o', error: 'x', durationMs: 1 });
    dispatch.dispatchAgentEvent({ type: 'AGENT_PROGRESS', agentId: 'o', progress: 'again', contractRole: 'owner', contractId: 'c' } as never);
    expect(store.getState().agents.agents.get('o')?.status).toBe('running');
  });
});

describe('task reducer', () => {
  test('a blocked reason does not linger after the task starts and finishes', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 't', description: 'Build', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_BLOCKED', taskId: 't', reason: 'waiting' });
    expect(store.getState().tasks.tasks.get('t')?.error).toBe('waiting');
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 't' });
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 't', durationMs: 1 });
    expect(store.getState().tasks.tasks.get('t')?.error).toBeUndefined();
  });

  test('a failed task that starts again runs again, and a completed one stays completed', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 't', description: 'Build', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 't' });
    dispatch.dispatchTaskEvent({ type: 'TASK_FAILED', taskId: 't', error: 'boom', durationMs: 1 });
    expect(store.getState().tasks.tasks.get('t')?.status).toBe('failed');
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 't' });
    const retried = store.getState().tasks.tasks.get('t');
    expect(retried?.status).toBe('running');
    expect(retried?.error).toBeUndefined();
    expect(retried?.endedAt).toBeUndefined();
    dispatch.dispatchTaskEvent({ type: 'TASK_COMPLETED', taskId: 't', durationMs: 2 });
    expect(store.getState().tasks.tasks.get('t')?.status).toBe('completed');
    dispatch.dispatchTaskEvent({ type: 'TASK_STARTED', taskId: 't' });
    expect(store.getState().tasks.tasks.get('t')?.status).toBe('completed');
  });

  test('progress is kept apart from the description', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchTaskEvent({ type: 'TASK_CREATED', taskId: 't', description: 'Build', priority: 0 });
    dispatch.dispatchTaskEvent({ type: 'TASK_PROGRESS', taskId: 't', progress: 0.5, message: 'half way' });
    const task = store.getState().tasks.tasks.get('t');
    expect(task?.description).toBe('Build');
    expect(task?.progress).toBe('half way');
  });

  test('ended tasks are bounded and the lifetime totals keep counting', () => {
    const { store, dispatch } = fresh();
    for (let index = 0; index < 1100; index++) {
      const task: RuntimeTask = { id: `t${index}`, kind: 'exec', title: 't', status: 'completed', owner: 'o', cancellable: false, childTaskIds: [], queuedAt: index, endedAt: index };
      dispatch.syncRuntimeTask(task);
    }
    const tasks = store.getState().tasks;
    expect(tasks.tasks.size).toBe(1000);
    expect(tasks.tasks.has('t0')).toBe(false);
    expect(tasks.tasks.has('t1099')).toBe(true);
    expect(tasks.totalCreated).toBe(1100);
    expect(tasks.totalCompleted).toBe(1100);
  });
});

describe('automation reducer', () => {
  test('ended runs are bounded and the run totals keep counting them', () => {
    const { store, dispatch } = fresh();
    for (let index = 0; index < 1100; index++) {
      const run = { id: `r${index}`, jobId: 'j', status: index % 2 === 0 ? 'completed' : 'failed', queuedAt: index, endedAt: index,
        triggeredBy: { id: 'src', label: 'src', createdAt: 0 } } as unknown as AutomationRun;
      dispatch.syncAutomationRun(run);
    }
    const automation = store.getState().automation;
    expect(automation.runs.size).toBe(1000);
    expect(automation.totalRuns).toBe(1100);
    expect(automation.totalSucceeded).toBe(550);
    expect(automation.totalFailed).toBe(550);
  });
});

describe('surface reducer', () => {
  test('a disabled healthy surface counts as disabled only', () => {
    const { store, dispatch } = fresh();
    dispatch.syncSurface({ id: 'a', label: 'a', enabled: false, state: 'healthy', configuredAt: 0 } as unknown as SurfaceRecord);
    dispatch.syncSurface({ id: 'b', label: 'b', enabled: true, state: 'healthy', configuredAt: 0 } as unknown as SurfaceRecord);
    const surfaces = store.getState().surfaces;
    expect(surfaces.totalHealthy).toBe(1);
    expect(surfaces.totalDisabled).toBe(1);
  });
});

describe('permission reducer', () => {
  const requested = (callId: string) => ({ type: 'GATE_REQUESTED', callId, tool: 'bash', args: {}, category: 'exec' }) as const;
  const decided = (callId: string) => ({ type: 'DECISION_EMITTED', callId, tool: 'bash', category: 'exec', approved: true, source: 'test' }) as const;

  test('one call deciding does not clear the wait of another call in flight', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchGateEvent(requested('a'));
    dispatch.dispatchGateEvent(requested('b'));
    dispatch.dispatchGateEvent(decided('a'));
    expect(store.getState().permissions.awaitingDecision).toBe(true);
    dispatch.dispatchGateEvent(decided('b'));
    expect(store.getState().permissions.awaitingDecision).toBe(false);
  });
});

describe('conversation reducer', () => {
  const turn = 'turn-1';

  test('a second provider call after a tool batch streams again', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchTurnEvent({ type: 'TURN_SUBMITTED', turnId: turn, prompt: 'go' });
    dispatch.dispatchTurnEvent({ type: 'PREFLIGHT_OK', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'STREAM_START', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'TOOL_BATCH_READY', turnId: turn, toolCalls: ['c'] });
    dispatch.dispatchTurnEvent({ type: 'TOOLS_DONE', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'POST_HOOKS_DONE', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'PREFLIGHT_OK', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'STREAM_START', turnId: turn });
    dispatch.dispatchTurnEvent({ type: 'STREAM_DELTA', turnId: turn, content: 'x', accumulated: 'x' });
    expect(store.getState().conversation.turnState).toBe('streaming');
    expect(store.getState().conversation.stream.accumulated).toBe('x');
  });

  test('a tool that ends after its turn was cancelled is recorded as ended', () => {
    const { store, dispatch } = fresh();
    dispatch.dispatchTurnEvent({ type: 'TURN_SUBMITTED', turnId: turn, prompt: 'go' });
    dispatch.dispatchToolEvent({ type: 'TOOL_RECEIVED', callId: 'c', turnId: turn, tool: 'bash', args: {} });
    dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId: 'c', turnId: turn, tool: 'bash', startedAt: 1 });
    dispatch.dispatchTurnEvent({ type: 'TURN_CANCEL', turnId: turn, stopReason: 'cancelled' });
    dispatch.dispatchToolEvent({ type: 'TOOL_EXECUTING', callId: 'c', turnId: turn, tool: 'bash', startedAt: 2 });
    expect(store.getState().conversation.activeToolCalls.get('c')?.state).toBe('executing');
    dispatch.dispatchToolEvent({ type: 'TOOL_CANCELLED', callId: 'c', turnId: turn, tool: 'bash' });
    expect(store.getState().conversation.activeToolCalls.get('c')?.state).toBe('cancelled');
  });
});
