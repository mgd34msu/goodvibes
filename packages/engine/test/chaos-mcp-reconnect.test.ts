/**
 * Chaos: MCP reconnect flapping and auth-expiry.
 *
 * The real lifecycle manager is driven with a client whose connection fails or
 * flaps, and a fake clock for the back-off timers, so what is checked is what the
 * manager does: it retries a bounded number of times, gives up as `disconnected`
 * and says so, recovers when a retry lands, and stops retrying once stopped. No
 * real network or timer is involved.
 */

import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { McpClient } from '../platform/src/platform/mcp/client.ts';
import { McpLifecycleManager } from '../platform/src/platform/runtime/mcp/index.ts';
import type { McpEvent } from '../platform/src/events/mcp.ts';
import { McpPermissionManager } from './_helpers/runtime-seam.ts';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  jest.useRealTimers();
});

const RECONNECT = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 } as const;
const SERVER = { name: 'flaky', command: 'unused', args: [] } as never;

/** Lets the promise chains a connect attempt started run to the end; no timer is involved. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

/** A client whose connect() fails for the first `failures` attempts and then succeeds. */
function stubClient(failures: number): { readonly attempts: () => number } {
  let attempts = 0;
  const connect = spyOn(McpClient.prototype, 'connect').mockImplementation(async () => {
    attempts += 1;
    if (attempts <= failures) throw new Error('401 Unauthorized: token expired');
  });
  const listTools = spyOn(McpClient.prototype, 'listTools').mockImplementation(async () => []);
  const disconnect = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async () => {});
  restores.push(() => { connect.mockRestore(); listTools.mockRestore(); disconnect.mockRestore(); });
  return { attempts: () => attempts };
}

function watch(manager: McpLifecycleManager): McpEvent[] {
  const events: McpEvent[] = [];
  manager.onEvent((event) => events.push(event));
  return events;
}

describe('chaos: MCP reconnect flapping', () => {
  test('a server that never connects is retried maxAttempts times, then given up on as disconnected', async () => {
    jest.useFakeTimers();
    const client = stubClient(Number.POSITIVE_INFINITY);
    const manager = new McpLifecycleManager({ reconnect: RECONNECT });
    const events = watch(manager);

    await manager.startServer(SERVER);
    expect(manager.getState('flaky')).toBe('reconnecting');
    for (let attempt = 0; attempt < RECONNECT.maxAttempts; attempt += 1) {
      jest.advanceTimersByTime(RECONNECT.maxDelayMs);
      await flushMicrotasks();
    }

    // The first try plus one per scheduled reconnect, and no more.
    expect(client.attempts()).toBe(1 + RECONNECT.maxAttempts);
    expect(manager.getState('flaky')).toBe('disconnected');
    expect(events.filter((event) => event.type === 'MCP_RECONNECTING').map((event) => (event as { attempt: number }).attempt)).toEqual([1, 2, 3]);
    const gaveUp = events.filter((event) => event.type === 'MCP_DISCONNECTED');
    expect(gaveUp).toHaveLength(1);
    expect(gaveUp[0]).toMatchObject({ willRetry: false, reason: 'max reconnect attempts (3) exceeded' });

    // Nothing is left scheduled: time passing does not start another attempt.
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();
    expect(client.attempts()).toBe(1 + RECONNECT.maxAttempts);
  });

  test('the back-off doubles per attempt and is capped by maxDelayMs', async () => {
    jest.useFakeTimers();
    const client = stubClient(Number.POSITIVE_INFINITY);
    const manager = new McpLifecycleManager({ reconnect: { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 25 } });

    await manager.startServer(SERVER);
    // Waits are 10, 20, then 25 (not 40), then 25.
    for (const [waited, expectedAttempts] of [[9, 1], [1, 2], [19, 2], [1, 3], [24, 3], [1, 4], [24, 4], [1, 5]] as const) {
      jest.advanceTimersByTime(waited);
      await flushMicrotasks();
      expect(client.attempts()).toBe(expectedAttempts);
    }
  });

  test('a server that comes back on a retry is connected again with its retry budget restored', async () => {
    jest.useFakeTimers();
    const client = stubClient(2);
    const manager = new McpLifecycleManager({ reconnect: RECONNECT });
    const events = watch(manager);

    await manager.startServer(SERVER);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      jest.advanceTimersByTime(RECONNECT.maxDelayMs);
      await flushMicrotasks();
    }

    expect(client.attempts()).toBe(3);
    expect(manager.getState('flaky')).toBe('connected');
    expect(manager.getServer('flaky')?.reconnectAttempts).toBe(0);
    expect(events.some((event) => event.type === 'MCP_CONNECTED')).toBe(true);
    expect(events.some((event) => event.type === 'MCP_DISCONNECTED')).toBe(false);
  });

  test('stopping a server that is waiting to reconnect cancels the pending attempt', async () => {
    jest.useFakeTimers();
    const client = stubClient(Number.POSITIVE_INFINITY);
    const manager = new McpLifecycleManager({ reconnect: RECONNECT });

    await manager.startServer(SERVER);
    expect(manager.getState('flaky')).toBe('reconnecting');
    await manager.stopServer('flaky', 'operator stop');
    jest.advanceTimersByTime(10_000);
    await flushMicrotasks();

    expect(client.attempts()).toBe(1);
    expect(manager.getState('flaky')).toBe('disconnected');
  });

  test('a server given up on can be started again and then connects', async () => {
    jest.useFakeTimers();
    const client = stubClient(1 + RECONNECT.maxAttempts);
    const manager = new McpLifecycleManager({ reconnect: RECONNECT });

    await manager.startServer(SERVER);
    for (let attempt = 0; attempt < RECONNECT.maxAttempts; attempt += 1) {
      jest.advanceTimersByTime(RECONNECT.maxDelayMs);
      await flushMicrotasks();
    }
    expect(manager.getState('flaky')).toBe('disconnected');

    await manager.startServer(SERVER);
    expect(client.attempts()).toBe(2 + RECONNECT.maxAttempts);
    expect(manager.getState('flaky')).toBe('connected');
  });

  describe('MCP permission manager: trust enforcement during flap', () => {
    test('unregistered server denies all tool calls', async () => {
      const mgr = new McpPermissionManager();
      const result = (await mgr.evaluateToolCall('ghost-server', 'dangerous-tool', {}));
      expect(result.allowed).toBe(false);
    });

    test('a registered server allows tools inside its scope by default', async () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server');
      const result = (await mgr.evaluateToolCall('my-server', 'read-file', {}));
      expect(result.allowed).toBe(true);
    });

    test('explicitly denied tool is blocked even if server is registered', async () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server');
      mgr.denyTool('my-server', 'drop-database');
      const result = (await mgr.evaluateToolCall('my-server', 'drop-database', {}));
      expect(result.allowed).toBe(false);
    });

    test('reconnect does not grant new permissions (server deny persists after re-register)', async () => {
      const mgr = new McpPermissionManager();
      mgr.registerServer('my-server');
      mgr.denyTool('my-server', 'write-fs');

      // Simulate reconnect: re-register the server (idempotent)
      mgr.registerServer('my-server');

      // Deny should still hold (no permission escalation on reconnect)
      const result = (await mgr.evaluateToolCall('my-server', 'write-fs', {}));
      expect(result.allowed).toBe(false);
    });
  });
});
