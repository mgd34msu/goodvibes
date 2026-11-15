// Deliberately per-repo test: the module it exercises is this repo's own and has no counterpart in the sibling product.
/**
 * UX Anti-Regression: MCP reconnect storms
 *
 * Drives the real runtime store with MCP bus events, the way the host event
 * bridge does, and checks what the UI reads: server status, reconnect attempts,
 * the connected set and the error count.
 */
import { describe, test, expect } from 'bun:test';
import { createRuntimeStore, createDomainDispatch } from '../../runtime/store/index.ts';
import { selectMcp } from '../../runtime/store/selectors/index.ts';

function makeStore() {
  const store = createRuntimeStore();
  return { store, dispatch: createDomainDispatch(store) };
}

describe('ux:mcp-reconnect-storm', () => {
  test('connecting then connected marks the server connected with its tool count', () => {
    const { store, dispatch } = makeStore();
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTING', serverId: 'a' });
    expect(selectMcp(store.getState()).servers.get('a')?.status).toBe('connecting');

    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'a', toolCount: 4, resourceCount: 1 });

    const mcp = selectMcp(store.getState());
    expect(mcp.servers.get('a')?.status).toBe('connected');
    expect(mcp.servers.get('a')?.toolCount).toBe(4);
    expect(mcp.connectedServerNames).toEqual(['a']);
    expect(mcp.availableToolCount).toBe(4);
  });

  test('the reconnect attempt number follows the event, and the status is reconnecting', () => {
    const { store, dispatch } = makeStore();
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'a', toolCount: 1, resourceCount: 0 });
    dispatch.dispatchMcpEvent({ type: 'MCP_DISCONNECTED', serverId: 'a', reason: 'pipe closed', willRetry: true });
    for (const attempt of [1, 2, 3]) {
      dispatch.dispatchMcpEvent({ type: 'MCP_RECONNECTING', serverId: 'a', attempt, maxAttempts: 5 });
      expect(selectMcp(store.getState()).servers.get('a')?.reconnectAttempts).toBe(attempt);
    }
    expect(selectMcp(store.getState()).servers.get('a')?.status).toBe('reconnecting');
  });

  test('a disconnected server leaves the connected set and its tools stop counting as available', () => {
    const { store, dispatch } = makeStore();
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'a', toolCount: 3, resourceCount: 0 });
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'b', toolCount: 2, resourceCount: 0 });
    expect(selectMcp(store.getState()).availableToolCount).toBe(5);

    dispatch.dispatchMcpEvent({ type: 'MCP_DISCONNECTED', serverId: 'a', reason: 'pipe closed', willRetry: true });

    const mcp = selectMcp(store.getState());
    expect(mcp.connectedServerNames).toEqual(['b']);
    expect(mcp.availableToolCount).toBe(2);
    expect(mcp.servers.get('a')?.lastError).toBe('pipe closed');
  });

  test('a 10-cycle storm ends on the last event and counts one error per disconnect', () => {
    const { store, dispatch } = makeStore();
    let previousRevision = selectMcp(store.getState()).revision;
    for (let i = 1; i <= 10; i++) {
      dispatch.dispatchMcpEvent({ type: 'MCP_DISCONNECTED', serverId: 'a', reason: `drop ${i}`, willRetry: true });
      dispatch.dispatchMcpEvent({ type: 'MCP_RECONNECTING', serverId: 'a', attempt: i, maxAttempts: 10 });
      dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTING', serverId: 'a' });
      const revision = selectMcp(store.getState()).revision;
      expect(revision).toBeGreaterThan(previousRevision);
      previousRevision = revision;
    }
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'a', toolCount: 2, resourceCount: 0 });

    const mcp = selectMcp(store.getState());
    expect(mcp.servers.size).toBe(1);
    expect(mcp.servers.get('a')?.status).toBe('connected');
    expect(mcp.servers.get('a')?.lastError).toBeUndefined();
    expect(mcp.totalErrors).toBe(10);
  });

  test('a storm on one server leaves another server untouched', () => {
    const { store, dispatch } = makeStore();
    dispatch.dispatchMcpEvent({ type: 'MCP_CONNECTED', serverId: 'steady', toolCount: 6, resourceCount: 0 });
    const steady = selectMcp(store.getState()).servers.get('steady');

    for (let i = 1; i <= 10; i++) {
      dispatch.dispatchMcpEvent({ type: 'MCP_DISCONNECTED', serverId: 'noisy', willRetry: true });
      dispatch.dispatchMcpEvent({ type: 'MCP_RECONNECTING', serverId: 'noisy', attempt: i, maxAttempts: 10 });
    }

    const mcp = selectMcp(store.getState());
    expect(mcp.servers.get('steady')).toEqual(steady!);
    expect(mcp.connectedServerNames).toEqual(['steady']);
    expect(mcp.servers.size).toBe(2);
  });

  test('a server first seen through a reconnect event is registered once, not duplicated', () => {
    const { store, dispatch } = makeStore();
    for (let i = 1; i <= 5; i++) {
      dispatch.dispatchMcpEvent({ type: 'MCP_RECONNECTING', serverId: 'late', attempt: i, maxAttempts: 5 });
    }
    expect(selectMcp(store.getState()).servers.size).toBe(1);
  });
});
