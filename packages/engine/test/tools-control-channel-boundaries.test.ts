import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '@goodvibes-jev/engine/platform/platform/channels';
import type { ChannelTargetResolveOptions } from '@goodvibes-jev/engine/platform/platform/channels';
import { createChannelTool } from '@goodvibes-jev/engine/platform/platform/tools';
import { createControlTool } from '../platform/src/platform/tools/control/index.ts';

describe('control tool', () => {
  test('reports the commands and panels its product supplies, not the engine-wide list', async () => {
    const tool = createControlTool({ commands: ['setup', 'login'], panels: ['hooks'] });
    expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!)).toEqual({ count: 2, commands: ['setup', 'login'] });
    expect(JSON.parse((await tool.execute({ mode: 'panels' })).output!)).toEqual({ count: 1, panels: ['hooks'] });
  });

  test('reads a supplied list on every call, so a list that exists only after registration is honoured', async () => {
    let commands: readonly string[] = [];
    const tool = createControlTool({ commands: () => commands });
    expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!)).toEqual({ count: 0, commands: [] });
    commands = ['setup'];
    expect(JSON.parse((await tool.execute({ mode: 'commands' })).output!)).toEqual({ count: 1, commands: ['setup'] });
  });

  test('declares no side effects, since every mode only reads', () => {
    expect(createControlTool().definition.sideEffects).toEqual([]);
  });
});

describe('channel tool boundaries', () => {
  function registryWith(calls: { resolve: ChannelTargetResolveOptions[]; ran: string[] }): ChannelPluginRegistry {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:boundary',
      surface: 'webhook',
      displayName: 'Boundary Surface',
      capabilities: ['ingress'],
      listOperatorActions: async () => [
        { id: 'inspect', surface: 'webhook', label: 'Inspect', description: 'Inspect', dangerous: false, metadata: {} },
        { id: 'cursor-migration-commit', surface: 'webhook', label: 'Commit', description: 'Commit a migration', dangerous: true, metadata: {} },
      ],
      runOperatorAction: async (actionId) => { calls.ran.push(actionId); return { actionId, ok: true }; },
      resolveTarget: async (options) => { calls.resolve.push(options); return null; },
      authorizeActorAction: async (request) => ({
        allowed: true, reason: 'checked', actionAvailable: true, metadata: { actorEvaluated: false, actorId: request.actorId ?? null },
      }),
    });
    return registry;
  }

  test('an action marked dangerous is not run, even with a model-supplied confirmation', async () => {
    const calls = { resolve: [], ran: [] as string[] };
    const tool = createChannelTool(registryWith(calls));
    const refused = await tool.execute({
      mode: 'run_action', surface: 'webhook', actionId: 'cursor-migration-commit', input: { confirm: true, previewId: 'p1' },
    });
    expect(refused.success).toBe(false);
    expect(refused.error).toContain('marked dangerous');
    expect(calls.ran).toEqual([]);
    const allowed = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'inspect' });
    expect(allowed.success).toBe(true);
    expect(calls.ran).toEqual(['inspect']);
  });

  test('authorize does not create the target it is asked about', async () => {
    const calls = { resolve: [] as ChannelTargetResolveOptions[], ran: [] as string[] };
    const tool = createChannelTool(registryWith(calls));
    const result = await tool.execute({ mode: 'authorize', surface: 'webhook', actionId: 'inspect', target: 'unknown-room', actorId: 'anyone' });
    expect(result.success).toBe(true);
    expect(calls.resolve).toHaveLength(1);
    expect(calls.resolve[0]!.createIfMissing).toBe(false);
  });

  test('credential and allowlist changes are the owner\'s, not the tool\'s', async () => {
    const calls = { resolve: [], ran: [] as string[] };
    const registry = registryWith(calls);
    const accountCalls: string[] = [];
    registry.runAccountAction = (async (_surface, action) => { accountCalls.push(action); return { ok: true }; }) as typeof registry.runAccountAction;
    const tool = createChannelTool(registry);
    for (const accountAction of ['setup', 'login', 'logout']) {
      const refused = await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction, input: { botToken: 'secret-value' } });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('Nothing was changed');
      expect(refused.error).not.toContain('secret-value');
    }
    const allowlist = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'edit-allowlist', input: { add: ['U1'] } });
    expect(allowlist.success).toBe(false);
    expect(accountCalls).toEqual([]);
    expect(calls.ran).toEqual([]);
    const retest = await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'retest' });
    expect(retest.success).toBe(true);
    expect(accountCalls).toEqual(['retest']);
  });

  test('run_tool does not reach the owner-only actions its tools wrap', async () => {
    const ran: string[] = [];
    const registry = new ChannelPluginRegistry();
    const tool = (id: string, actionIds: string[], metadata: Record<string, unknown> = {}) =>
      ({ id, surface: 'webhook' as const, name: id, description: id, actionIds, metadata });
    registry.register({
      id: 'surface:tools',
      surface: 'webhook',
      displayName: 'Tools Surface',
      capabilities: ['ingress'],
      listTools: () => [
        tool('webhook:allowlist_edit', ['edit-allowlist']),
        tool('webhook:account_action', ['account-action']),
        tool('webhook:flagged', ['other'], { dangerous: true }),
        tool('webhook:inspect', ['inspect']),
      ],
      runTool: async (toolId) => { ran.push(toolId); return { ok: true }; },
    });
    const channel = createChannelTool(registry);
    for (const toolId of ['webhook:allowlist_edit', 'webhook:account_action', 'webhook:flagged']) {
      const refused = await channel.execute({ mode: 'run_tool', surface: 'webhook', toolId, input: { add: ['U1'] } });
      expect(refused.success).toBe(false);
      expect(refused.error).toContain('Nothing was changed');
    }
    expect(ran).toEqual([]);
    const allowed = await channel.execute({ mode: 'run_tool', surface: 'webhook', toolId: 'webhook:inspect' });
    expect(allowed.success).toBe(true);
    expect(ran).toEqual(['webhook:inspect']);
  });
});
