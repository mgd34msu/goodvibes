import { describe, expect, test } from 'bun:test';
import { createDomainDispatch, createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { selectDomainHealth } from '../platform/src/platform/runtime/store/selectors/index.js';

function connect(dispatch: ReturnType<typeof createDomainDispatch>, transportId: string): void {
  dispatch.dispatchTransportEvent({ type: 'TRANSPORT_CONNECTED', transportId, endpoint: `stdio://subagent/${transportId}` });
  dispatch.dispatchTransportEvent({ type: 'TRANSPORT_SYNCING', transportId });
}

describe('ACP transport health across subagent connections', () => {
  test('a running subagent connection reads healthy', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    connect(dispatch, 'acp:a');
    expect(selectDomainHealth(store.getState(), 'acp')).toBe('healthy');
  });

  test('a failure beside a live connection is reported, not overwritten', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    connect(dispatch, 'acp:a');
    connect(dispatch, 'acp:b');
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_TERMINAL_FAILURE', transportId: 'acp:a', error: 'boom' });
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_SYNCING', transportId: 'acp:b' });
    expect(store.getState().acp.managerTransportState).toBe('degraded');
    expect(selectDomainHealth(store.getState(), 'acp')).toBe('degraded');
  });

  test('one agent finishing does not mark others as disconnected', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    connect(dispatch, 'acp:a');
    connect(dispatch, 'acp:b');
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_DISCONNECTED', transportId: 'acp:a', reason: 'done', willRetry: false });
    expect(store.getState().acp.managerTransportState).toBe('syncing');
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_DISCONNECTED', transportId: 'acp:b', reason: 'done', willRetry: false });
    expect(store.getState().acp.managerTransportState).toBe('disconnected');
  });

  test('a daemon terminal failure clears isRunning', () => {
    const store = createRuntimeStore();
    const dispatch = createDomainDispatch(store);
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_CONNECTED', transportId: 'daemon:primary', endpoint: 'ipc://daemon.sock' });
    expect(store.getState().daemon.isRunning).toBe(true);
    dispatch.dispatchTransportEvent({ type: 'TRANSPORT_TERMINAL_FAILURE', transportId: 'daemon:primary', error: 'gone' });
    expect(store.getState().daemon.isRunning).toBe(false);
  });
});
