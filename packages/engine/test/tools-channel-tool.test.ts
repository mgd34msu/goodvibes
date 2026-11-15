import { describe, expect, test } from 'bun:test';
import { ChannelPluginRegistry } from '@goodvibes-jev/engine/platform/platform/channels';
import { createChannelTool } from '@goodvibes-jev/engine/platform/platform/tools';
import { BuiltinChannelRuntime } from '../platform/src/platform/channels/builtin-runtime.js';
import type { BuiltinChannelRuntimeDeps } from '../platform/src/platform/channels/builtin/shared.js';

describe('channel tool', () => {
  test('lists channel capabilities and accounts from the active registry', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:test',
      surface: 'webhook',
      displayName: 'Test Surface',
      capabilities: ['ingress', 'egress'],
      listAccounts: async () => [{
        id: 'acct-1',
        surface: 'webhook',
        label: 'Test Account',
        enabled: true,
        configured: true,
        linked: true,
        state: 'healthy',
        authState: 'linked',
        accountId: 'acct-1',
        secrets: [],
        actions: [],
        metadata: {},
      }],
      listCapabilities: async () => [{
        id: 'cap-1',
        surface: 'webhook',
        label: 'Inbound',
        scope: 'surface',
        supported: true,
        detail: 'Accepts inbound events',
        metadata: {},
      }],
      listOperatorActions: async () => [{
        id: 'inspect',
        surface: 'webhook',
        label: 'Inspect',
        description: 'Inspect the channel',
        dangerous: false,
        metadata: {},
      }],
      listTools: async () => [{
        id: 'webhook:inspect',
        surface: 'webhook',
        name: 'webhook_inspect',
        description: 'Inspect webhook state',
        actionIds: ['inspect'],
        metadata: {},
      }],
      runTool: async (toolId) => ({ toolId, ok: true }),
      runOperatorAction: async (actionId) => ({ actionId, ok: true }),
      runAccountAction: async (action, accountId) => ({
        surface: 'webhook',
        accountId,
        action,
        ok: true,
        metadata: {},
      }),
      resolveTarget: async (options) => ({
        surface: 'webhook',
        input: options.input,
        normalized: options.input.toLowerCase(),
        kind: 'service',
        to: options.input,
        source: 'synthetic',
        sessionTarget: `channel:webhook:${options.input.toLowerCase()}`,
        metadata: {},
      }),
      authorizeActorAction: async () => ({
        allowed: true,
        reason: 'allowed',
        actionAvailable: true,
        metadata: {},
      }),
      listAgentTools: () => [{
        definition: {
          name: 'webhook_direct',
          description: 'Direct webhook tool',
          parameters: { type: 'object' },
        },
        execute: async () => ({ success: true, output: 'ok' }),
      }],
    });

    const channelTool = createChannelTool(registry);
    const accounts = await channelTool.execute({ mode: 'accounts' });
    expect(accounts.success).toBe(true);
    expect(accounts.output).toContain('acct-1');

    const capabilities = await channelTool.execute({ mode: 'capabilities', surface: 'webhook' });
    expect(capabilities.success).toBe(true);
    expect(capabilities.output).toContain('Inbound');

    const actions = await channelTool.execute({ mode: 'actions', surface: 'webhook' });
    expect(actions.success).toBe(true);
    expect(actions.output).toContain('Inspect');

    const tools = await channelTool.execute({ mode: 'tools', surface: 'webhook' });
    expect(tools.success).toBe(true);
    expect(tools.output).toContain('webhook_inspect');

    const toolInvoke = await channelTool.execute({ mode: 'run_tool', surface: 'webhook', toolId: 'webhook:inspect' });
    expect(toolInvoke.success).toBe(true);
    expect(toolInvoke.output).toContain('"toolId": "webhook:inspect"');

    const invoke = await channelTool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'inspect' });
    expect(invoke.success).toBe(true);
    expect(invoke.output).toContain('"ok": true');

    const accountAction = await channelTool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'retest', accountId: 'acct-1' });
    expect(accountAction.success).toBe(true);
    expect(accountAction.output).toContain('"action": "retest"');

    const target = await channelTool.execute({ mode: 'resolve_target', surface: 'webhook', target: 'https://example.com/hook' });
    expect(target.success).toBe(true);
    expect(target.output).toContain('"sessionTarget": "channel:webhook:https://example.com/hook"');

    const agentTools = await channelTool.execute({ mode: 'agent_tools', surface: 'webhook' });
    expect(agentTools.success).toBe(true);
    expect(agentTools.output).toContain('webhook_direct');

    const authorize = await channelTool.execute({ mode: 'authorize', surface: 'webhook', actionId: 'inspect' });
    expect(authorize.success).toBe(true);
    expect(authorize.output).toContain('"allowed": true');
  });

  test('returns a useful error when the active registry is missing or the request is invalid', async () => {
    const registry = new ChannelPluginRegistry();
    registry.register({
      id: 'surface:test-2',
      surface: 'slack',
      displayName: 'Slack Test',
      capabilities: ['ingress'],
    });

    const channelTool = createChannelTool(registry);
    const missingSurface = await channelTool.execute({ mode: 'directory' });
    expect(missingSurface.success).toBe(false);
    expect(missingSurface.error).toContain('requires "surface"');
  });
});

/** A stub surface that records every mutating call, so a refused call is shown not to have reached it. */
function recordingRegistry() {
  const calls = { operatorActions: [] as string[], accountActions: [] as Array<{ action: string; input: unknown }>, tools: [] as string[], resolveTarget: [] as Array<{ createIfMissing?: boolean | undefined }>, authorize: [] as Array<{ actionId: string; actorId?: string | undefined }> };
  const registry = new ChannelPluginRegistry();
  registry.register({
    id: 'surface:recording',
    surface: 'webhook',
    displayName: 'Recording Surface',
    capabilities: ['egress'],
    listOperatorActions: async () => [
      { id: 'inspect', surface: 'webhook', label: 'Inspect', description: 'Read only', dangerous: false, metadata: {} },
      { id: 'wipe', surface: 'webhook', label: 'Wipe', description: 'Destroys state', dangerous: true, metadata: {} },
      { id: 'edit-allowlist', surface: 'webhook', label: 'Edit allowlist', description: 'Widens access', dangerous: false, metadata: {} },
    ],
    runOperatorAction: async (actionId) => {
      calls.operatorActions.push(actionId);
      return actionId === 'unknown-to-plugin' ? null : { actionId, ran: true };
    },
    runAccountAction: async (action, accountId, input) => {
      calls.accountActions.push({ action, input });
      return { surface: 'webhook', accountId: accountId ?? 'acct', action, ok: true, metadata: {} };
    },
    runTool: async (toolId) => { calls.tools.push(toolId); return null; },
    resolveTarget: async (options) => {
      calls.resolveTarget.push({ createIfMissing: options.createIfMissing });
      return { surface: 'webhook', input: options.input, normalized: options.input, kind: 'service', to: options.input, source: 'synthetic', sessionTarget: `channel:webhook:${options.input}`, metadata: {} };
    },
    authorizeActorAction: async (request) => {
      calls.authorize.push({ actionId: request.actionId, actorId: request.actorId });
      return { allowed: true, reason: 'stub', actionAvailable: true, metadata: {} };
    },
  });
  return { calls, tool: createChannelTool(registry) };
}

describe('channel tool refuses what only the owner may run', () => {
  test('run_action refuses a dangerous action and edit-allowlist without reaching the plugin, and runs a plain one', async () => {
    const { calls, tool } = recordingRegistry();

    const dangerous = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'wipe', input: { confirm: true } });
    expect(dangerous.success).toBe(false);
    expect(dangerous.error).toContain("'wipe' on 'webhook' is marked dangerous");
    expect(dangerous.error).toContain('Nothing was changed');

    const allowlist = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'edit-allowlist', input: { add: ['mallory'], confirm: true } });
    expect(allowlist.success).toBe(false);
    expect(allowlist.error).toContain('changes credentials or access');
    expect(calls.operatorActions).toEqual([]);

    const plain = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'inspect' });
    expect(plain.success).toBe(true);
    expect(calls.operatorActions).toEqual(['inspect']);
  });

  test.each(['setup', 'connect', 'login', 'wait_login', 'disconnect', 'logout'])('account_action %s is refused with its credentials never reaching the plugin', async (accountAction) => {
    const { calls, tool } = recordingRegistry();
    const result = await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction, accountId: 'acct-1', input: { token: 'raw-secret-token' } });
    expect(result.success).toBe(false);
    expect(result.error).toContain(`Account action '${accountAction}' on 'webhook' changes credentials or access`);
    expect(calls.accountActions).toEqual([]);
  });

  test('account_action runs a read-only lifecycle action and passes its input through', async () => {
    const { calls, tool } = recordingRegistry();
    const result = await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'retest', accountId: 'acct-1', input: { probe: true } });
    expect(result.success).toBe(true);
    expect(calls.accountActions).toEqual([{ action: 'retest', input: { probe: true } }]);
  });

  test('authorize forwards the actor and never lets the check create the conversation it asks about', async () => {
    const { calls, tool } = recordingRegistry();
    const result = await tool.execute({ mode: 'authorize', surface: 'webhook', actionId: 'inspect', actorId: 'user-7', target: 'room-1', input: {} });
    expect(result.success).toBe(true);
    expect(calls.authorize).toEqual([{ actionId: 'inspect', actorId: 'user-7' }]);
    expect(calls.resolveTarget).toEqual([{ createIfMissing: false }]);
  });

  test('requests that name nothing real fail with a message naming the problem', async () => {
    const { tool } = recordingRegistry();
    expect((await tool.execute({ mode: 'nope' })).error).toBe('Unknown mode: nope');
    expect((await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'unknown-to-plugin' })).error)
      .toBe("Unknown channel action 'unknown-to-plugin' for surface 'webhook'.");
    expect((await tool.execute({ mode: 'run_tool', surface: 'webhook', toolId: 'missing' })).error)
      .toBe("Unknown channel tool 'missing' for surface 'webhook'.");
    expect((await tool.execute({ mode: 'run_action', surface: 'webhook' })).error).toContain('requires "actionId"');
    expect((await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'explode' })).error).toContain('valid "accountAction"');
    expect((await createChannelTool(null).execute({ mode: 'accounts' })).error).toBe('No active channel registry is available in this runtime.');
  });
});

function builtinDeps(channelPlugins: ChannelPluginRegistry, secretWrites: string[]): BuiltinChannelRuntimeDeps {
  return {
    channelPlugins,
    configManager: { get: () => undefined, getCategory: () => ({ webhook: {}, telegram: {} }), set: () => undefined },
    secretsManager: { get: () => undefined, set: async (key: string) => { secretWrites.push(key); } },
    serviceRegistry: { get: () => undefined, resolveSecret: async () => null },
    routeBindings: { start: async () => undefined, getBinding: () => undefined, listBindings: () => [] },
    channelPolicy: { start: async () => undefined, getPolicy: () => ({ allowlistUserIds: ['owner'] }), upsertPolicy: async (_surface: string, input: Record<string, unknown>) => input },
    deliveryRouter: {},
    surfaceDeliveryEnabled: () => false,
  } as unknown as BuiltinChannelRuntimeDeps;
}

describe('channel tool against the built-in surfaces', () => {
  function builtinTool() {
    const secretWrites: string[] = [];
    const registry = new ChannelPluginRegistry();
    new BuiltinChannelRuntime(builtinDeps(registry, secretWrites)).registerPlugins();
    return { secretWrites, tool: createChannelTool(registry) };
  }

  test('authorize evaluates the actor against the allowlist, and refuses an action the surface does not have', async () => {
    const { tool } = builtinTool();
    const unknown = await tool.execute({ mode: 'authorize', surface: 'webhook', actionId: 'made-up-action', actorId: 'outsider' });
    expect(unknown.success).toBe(true);
    const parsed = JSON.parse(unknown.output!) as { result: { allowed: boolean; reason: string; metadata: { actorEvaluated: boolean; actorAllowlisted: boolean; actorId: string | null } } };
    expect(parsed.result.allowed).toBe(false);
    expect(parsed.result.reason).toContain("Unknown action 'made-up-action'");
    expect(parsed.result.metadata.actorEvaluated).toBe(true);
    expect(parsed.result.metadata.actorAllowlisted).toBe(false);
    expect(parsed.result.metadata.actorId).toBe('outsider');
  });

  test('edit-allowlist is refused on a built-in surface before any allowlist is touched', async () => {
    const { tool } = builtinTool();
    const result = await tool.execute({ mode: 'run_action', surface: 'webhook', actionId: 'edit-allowlist', input: { add: ['outsider'] } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('changes credentials or access');
  });

  test('account setup with a raw token is refused and nothing is written to the secret store', async () => {
    const { secretWrites, tool } = builtinTool();
    const result = await tool.execute({ mode: 'account_action', surface: 'webhook', accountAction: 'setup', input: { token: 'raw-secret-token' } });
    expect(result.success).toBe(false);
    expect(secretWrites).toEqual([]);
  });

  test('the Telegram cursor commit is refused as dangerous before it can reach the ingress', async () => {
    const { tool } = builtinTool();
    const result = await tool.execute({ mode: 'run_action', surface: 'telegram', actionId: 'cursor-migration-commit', input: { previewId: 'p1', confirm: true } });
    expect(result.success).toBe(false);
    expect(result.error).toContain("'cursor-migration-commit' on 'telegram' is marked dangerous");
  });
});

