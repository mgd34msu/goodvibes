/**
 * A refused MCP lifecycle move must not be announced: listeners are told only
 * about states the manager actually entered.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { McpClient } from '../platform/src/platform/mcp/client.ts';
import { McpLifecycleManager } from '../platform/src/platform/runtime/mcp/index.ts';
import type { McpEvent } from '../platform/src/platform/../events/mcp.ts';
import type { McpServerLifecycleState } from '../platform/src/platform/runtime/store/domains/mcp.ts';
import type { McpServerState } from '../platform/src/platform/runtime/mcp/types.ts';

const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

describe('McpLifecycleManager refused transitions', () => {
  test('stop during connect: late connect success is not announced as MCP_CONNECTED', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const c = spyOn(McpClient.prototype, 'connect').mockImplementation(async () => { await gate; });
    const l = spyOn(McpClient.prototype, 'listTools').mockImplementation(async () => []);
    const disconnected: unknown[] = [];
    const d = spyOn(McpClient.prototype, 'disconnect').mockImplementation(async function (this: unknown) { disconnected.push(this); });
    restores.push(() => { c.mockRestore(); l.mockRestore(); d.mockRestore(); });

    const mgr = new McpLifecycleManager();
    const events: McpEvent[] = [];
    mgr.onEvent((e) => events.push(e));
    const starting = mgr.startServer({ name: 'srv', command: 'x', args: [] } as never);
    await new Promise((r) => setTimeout(r, 5));
    await mgr.stopServer('srv', 'user stop');
    release();
    await starting;

    expect(mgr.getState('srv')).toBe('disconnected');
    expect(events.map((e) => e.type)).not.toContain('MCP_CONNECTED');
    // The client that finished connecting after the stop is closed, not kept.
    expect(disconnected.length).toBe(1);
    expect((mgr as unknown as { clients: Map<string, unknown> }).clients.has('srv')).toBe(false);
  });

  test('the two state type names are one type', () => {
    const a: McpServerLifecycleState = 'degraded' as McpServerState;
    const b: McpServerState = a;
    expect(b).toBe('degraded');
  });
});
