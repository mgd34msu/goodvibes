/**
 * mcp-lazy-start.test.ts
 *
 * A bare `goodvibes-agent` boot, no prompt, no tool call, spawned every
 * server in mcp.json, because `scheduleBackgroundMcpDiscovery()` calls
 * `connectAll()` as its first act. On a real machine that put two
 * browser-automation servers into the process tree at startup, one of them
 * configured with a start-url pointing at a cloud console.
 *
 * Nobody ordered browser automation at boot. These tests pin that servers start
 * on first USE and never before it.
 */

import { describe, expect, test } from 'bun:test';
import { createLazyMcpRegistry } from '../../runtime/mcp-lazy-start.ts';
import type { McpRegistry } from '@goodvibes-jev/engine/platform/platform/mcp';

/** A registry that records whether anything would have been spawned, and which servers. */
function fakeRegistry(options: { readonly failConnect?: number } = {}): { registry: McpRegistry; connects: string[]; starts: number; calls: string[] } {
  const state = { connects: [] as string[], starts: 0, calls: [] as string[] };
  const live = new Set<string>();
  let failures = options.failConnect ?? 0;
  const registry = {
    connectAll: async (): Promise<void> => { state.connects.push('*'); },
    connectConfigured: async (_roots: unknown, name: string): Promise<void> => {
      state.connects.push(name);
      await Promise.resolve();
      if (failures > 0) { failures -= 1; throw new Error('server not installed'); }
      live.add(name);
    },
    startConfigured: (): void => { state.starts += 1; },
    getClient: (name: string): unknown => (live.has(name) ? { isConnected: true } : undefined),
    listAllTools: async (): Promise<unknown[]> => { state.calls.push('listAllTools'); return []; },
    callTool: async (): Promise<unknown> => { state.calls.push('callTool'); return null; },
    getToolSchema: async (): Promise<unknown> => { state.calls.push('getToolSchema'); return null; },
    // SYNCHRONOUS in the real registry, modelling it as async once hid a
    // defect where gating it returned a promise and broke every caller.
    listServerSecurity: (): unknown[] => { state.calls.push('listServerSecurity'); return []; },
    get serverNames(): string[] { state.calls.push('serverNames'); return ['playwright', 'zen-devtools']; },
  } as unknown as McpRegistry;
  return {
    registry,
    get connects() { return state.connects; },
    get starts() { return state.starts; },
    get calls() { return state.calls; },
  } as { registry: McpRegistry; connects: string[]; starts: number; calls: string[] };
}

const ROOTS = {} as Parameters<McpRegistry['connectAll']>[0];

describe('MCP servers do not start at boot', () => {
  test('wrapping the registry starts nothing', () => {
    const fake = fakeRegistry();
    createLazyMcpRegistry(fake.registry, ROOTS);
    // This is the boot: the agent composed its services and did nothing else.
    expect(fake.connects).toEqual([]);
    expect(fake.starts).toBe(0);
  });

  test('asking what is configured does not spawn anything', () => {
    // `serverNames` is what the suggestion scan reads two seconds into a boot.
    // If it connected, the fix would be undone by its own diagnostics.
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    expect(lazy.registry.serverNames).toEqual(['playwright', 'zen-devtools']);
    expect(fake.connects).toEqual([]);
    expect(lazy.isConnected()).toBe(false);
  });

  test('synchronous registry methods stay synchronous and start nothing', () => {
    // Gating a sync method turns it into a promise. `listServerSecurity()`
    // returns an array that callers immediately `.filter()`.
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    expect(Array.isArray(lazy.registry.listServerSecurity())).toBe(true);
    expect(fake.connects).toEqual([]);
  });
});

describe('a use connects only the server it addresses', () => {
  test('calling a tool connects that server first, then calls', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await lazy.registry.callTool('mcp:playwright:navigate', {});
    expect(fake.connects).toEqual(['playwright']);
    expect(fake.calls).toEqual(['callTool']);
    expect(lazy.isConnected()).toBe(true);
  });

  test('concurrent calls to one server connect it once', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await Promise.all([
      lazy.registry.callTool('mcp:a:b', {}),
      lazy.registry.getToolSchema('mcp:a:c'),
      lazy.registry.callTool('mcp:other:d', {}),
    ]);
    expect([...fake.connects].sort()).toEqual(['a', 'other']);
  });

  test('listing starts the servers in the background and does not wait for them', async () => {
    const fake = fakeRegistry();
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await lazy.registry.listAllTools();
    expect(fake.starts).toBe(1);
    expect(fake.connects).toEqual([]);
  });

  test('a failed connect rejects with the real reason and the next call tries again', async () => {
    const fake = fakeRegistry({ failConnect: 1 });
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS);
    await expect(lazy.registry.callTool('mcp:s:t', {})).rejects.toThrow('MCP connect failed: server not installed');
    expect(fake.calls).toEqual([]);
    await lazy.registry.callTool('mcp:s:t', {});
    expect(fake.connects).toEqual(['s', 's']);
    expect(fake.calls).toEqual(['callTool']);
  });

  test('the first-connect hook runs once', async () => {
    const fake = fakeRegistry();
    let hooks = 0;
    const lazy = createLazyMcpRegistry(fake.registry, ROOTS, { onFirstConnect: () => { hooks += 1; } });
    await lazy.registry.callTool('mcp:a:b', {});
    await lazy.registry.callTool('mcp:c:d', {});
    expect(hooks).toBe(1);
  });
});
