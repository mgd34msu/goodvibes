/** The host event bridge is what lets the runtime store, and so MCP health, learn of MCP and plugin lifecycle. */
import { expect, test } from 'bun:test';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { emitMcpConnected, emitMcpDisconnected } from '../platform/src/platform/runtime/emitters/mcp.ts';
import { emitToolExecuting, emitToolSucceeded } from '../platform/src/platform/runtime/emitters/tools.ts';
import { registerHostRuntimeEvents } from '../platform/src/platform/runtime/bootstrap-runtime-events.ts';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';

/** Bus listeners run on a microtask; one awaited turn is the whole delay. */
const delivered = (): Promise<void> => Promise.resolve().then(() => undefined);

test('MCP lifecycle published on the bus reaches the runtime store', async () => {
  const bus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const { unsubs, agentStatusIntervalRef } = registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: createDomainDispatch(store),
    getSystemMessageRouter: () => null,
    requestRender: () => {},
    agentManager: {} as never,
    contractRunner: { get: () => undefined, list: () => [] } as never,
  });
  try {
    const ctx = { sessionId: 's', traceId: 't', source: 'test' };
    expect(store.getState().mcp.servers.size).toBe(0);
    emitMcpConnected(bus, ctx, { serverId: 'files', toolCount: 3, resourceCount: 0 });
    await delivered();
    expect(store.getState().mcp.servers.get('files')?.status).toBe('connected');
    emitMcpDisconnected(bus, ctx, { serverId: 'files', reason: 'exited', willRetry: true });
    await delivered();
    expect(store.getState().mcp.servers.get('files')).toMatchObject({ status: 'disconnected', lastError: 'exited' });
  } finally {
    for (const unsub of unsubs) unsub();
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
  }
});

test('a tool call that starts on the bus is an unfinished call in the runtime store until it succeeds', async () => {
  const bus = new RuntimeEventBus();
  const store = createRuntimeStore();
  const dispatch = createDomainDispatch(store);
  // Tool events only count inside the current turn.
  dispatch.dispatchTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'turn-1', prompt: 'hello' });
  dispatch.dispatchTurnEvent({ type: 'STREAM_START', turnId: 'turn-1' });
  const { unsubs, agentStatusIntervalRef } = registerHostRuntimeEvents({
    runtimeBus: bus,
    domainDispatch: dispatch,
    getSystemMessageRouter: () => null,
    requestRender: () => {},
    agentManager: {} as never,
    contractRunner: { get: () => undefined, list: () => [] } as never,
  });
  try {
    const ctx = { sessionId: 's', traceId: 't', source: 'test' };
    emitToolExecuting(bus, ctx, { callId: 'c1', turnId: 'turn-1', tool: 'exec', startedAt: 1 });
    await delivered();
    expect(store.getState().conversation.activeToolCalls.get('c1')?.state).toBe('executing');
    emitToolSucceeded(bus, ctx, { callId: 'c1', turnId: 'turn-1', tool: 'exec', durationMs: 5 });
    await delivered();
    expect(store.getState().conversation.activeToolCalls.get('c1')?.state).toBe('succeeded');
  } finally {
    for (const unsub of unsubs) unsub();
    if (agentStatusIntervalRef.value) clearInterval(agentStatusIntervalRef.value);
  }
});
