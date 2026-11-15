import { describe, expect, test } from 'bun:test';
import { createExecTool, OverflowHandler, ProcessManager, ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import {
  AGENT_CHANNEL_ACTION_DENIAL_MESSAGE,
  AGENT_READ_ONLY_REGISTRY_TOOL_MODES,
  explainAgentToolPolicyInvocation,
  installAgentToolPolicyGuard,
} from '../../tools/agent-tool-policy-guard.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';

function tool(name: string, properties: Record<string, unknown> = {}): Tool {
  return {
    definition: {
      name,
      description: `${name} full description`,
      parameters: { type: 'object', properties: { mode: { type: 'string' }, ...properties }, additionalProperties: true },
    },
    execute: async () => ({ success: true, output: `${name} ran` }),
  };
}

function guardedRegistry(names: readonly string[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(tool('agent'));
  for (const name of names) registry.register(tool(name));
  installAgentToolPolicyGuard(registry);
  return registry;
}

function description(registry: ToolRegistry, name: string): string {
  return registry.getToolDefinitions().find((definition) => definition.name === name)!.description;
}

describe('the descriptions the model reads match what the Agent guard allows', () => {
  test('a tool the guard narrows to read-only modes is not summarised as one that can mutate', () => {
    const readOnly = ['remote', 'channel', 'team', 'worklist', 'packet', 'query'];
    const registry = guardedRegistry(readOnly);
    compactRegisteredToolDefinitions(registry);
    for (const name of readOnly) {
      expect(description(registry, name)).not.toMatch(/\b(manage|operate|update|track)\b/i);
      expect(description(registry, name)).toMatch(/^Inspect /);
    }
  });

  test('goodvibes_settings is summarised as the set/reset writer it is, not a reader', () => {
    const registry = guardedRegistry(['goodvibes_settings']);
    compactRegisteredToolDefinitions(registry);
    expect(description(registry, 'goodvibes_settings')).not.toMatch(/inspect/i);
    expect(description(registry, 'goodvibes_settings')).toMatch(/set or reset/i);
  });

  test('a refused mode says an approved call is not held to the list', async () => {
    const registry = guardedRegistry(['team']);
    const result = await registry.execute('call-team', 'team', { mode: 'create' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('mode "create" is not available here; available: list, show.');
    expect(result.error).toContain('approved through the Agent approval flow');
  });

  test('the channel refusal names the approval path instead of reading as permanent', async () => {
    const registry = guardedRegistry(['channel']);
    const result = await registry.execute('call-channel', 'channel', { mode: 'run_action', actionId: 'edit-allowlist' });
    expect(result.success).toBe(false);
    expect(result.error).toStartWith(AGENT_CHANNEL_ACTION_DENIAL_MESSAGE);
    expect(AGENT_CHANNEL_ACTION_DENIAL_MESSAGE).toContain('owner approves that exact call');
  });
});

describe('core tool parameters keep what teaches the call', () => {
  test('the compacted exec definition still names bg_stop, bg_status, bg_output and bg_list', () => {
    const registry = new ToolRegistry();
    const root = makeProjectTempDir('tool-surface-honesty');
    registry.register(createExecTool(new ProcessManager(), { defaultWorkingDirectory: root, overflowHandler: new OverflowHandler({ baseDir: root }) }));
    compactRegisteredToolDefinitions(registry);
    const compacted = JSON.stringify(registry.getToolDefinitions().find((definition) => definition.name === 'exec')!.parameters);
    for (const word of ['bg_list', 'bg_status', 'bg_output', 'bg_stop']) expect(compacted).toContain(word);
  });

  test('a deferred-detail tool keeps a short description for a destructive parameter', () => {
    const registry = new ToolRegistry();
    registry.register(tool('rarely_used', {
      force: { type: 'boolean', description: 'Replace the existing file.' },
      label: { type: 'string', description: 'A label nobody needs on every request.' },
    }));
    compactRegisteredToolDefinitions(registry);
    const properties = (registry.getToolDefinitions()[0]!.parameters as { properties: Record<string, { description?: string }> }).properties;
    expect(properties.force!.description).toBe('Replace the existing file.');
    expect(properties.label!.description).toBeUndefined();
  });
});

describe('policy explanation follows the wrapper outcome', () => {
  test('a registry content mode is explained as denied, the same as the wrapper refuses it', async () => {
    const registry = guardedRegistry(['registry']);
    const args = { mode: 'content', path: '/etc/passwd' };
    const executed = await registry.execute('call-registry', 'registry', args);
    const explained = explainAgentToolPolicyInvocation('registry', args);
    expect(executed.success).toBe(false);
    expect(explained.status).toBe('denied');
    expect(executed.error).toBe(explained.reason);
  });

  test('an allowed registry mode is explained as allowed', () => {
    expect(explainAgentToolPolicyInvocation('registry', { mode: AGENT_READ_ONLY_REGISTRY_TOOL_MODES[0] }).status).toBe('allowed');
  });
});

describe('the installed settings tool is the engine admitted wrapper', () => {
  test('it carries the engine description, and request text is not authority for a hazardous key', async () => {
    const registry = guardedRegistry(['goodvibes_settings']);
    expect(description(registry, 'goodvibes_settings')).toContain('actual owning runtime');
    expect(description(registry, 'goodvibes_settings')).not.toContain('needs the user to ask for it first');

    const withRequest = { mode: 'set', key: 'permissions.mode', value: 'allow-all', explicitUserRequest: 'please turn off prompts' };
    const without = { mode: 'set', key: 'permissions.mode', value: 'allow-all' };
    const outcomes: string[] = [];
    for (const args of [withRequest, without]) {
      try {
        const result = await registry.execute('call-settings', 'goodvibes_settings', args);
        outcomes.push(`result:${result.success}:${result.error ?? ''}`);
      } catch (error) {
        outcomes.push(`threw:${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(outcomes[0]).not.toContain('result:true');
    expect(outcomes[0]).toBe(outcomes[1]!);
  });

  test('a read mode is refused by the installed tool: it only sets or resets', async () => {
    const registry = guardedRegistry(['goodvibes_settings']);
    const result = await registry.execute('call-settings-get', 'goodvibes_settings', { mode: 'get', key: 'display.theme' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Settings accepts only set or reset.');
  });
});
