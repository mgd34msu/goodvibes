import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentMemoryTool } from '../../tools/agent-memory-tool.ts';
import { createAgentModelsTool } from '../../tools/agent-models-tool.ts';
import { createAgentNotifyTool } from '../../tools/agent-notify-tool.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { executeAdmitted } from '../helpers/admitted-tool.ts';

afterAll(cleanupResearchScreeningFixtures);
beforeEach(() => resetSessionUntrustedContentLedgerForTests());

function fakeTool(name: string, calls: Record<string, unknown>[]): Tool {
  return {
    definition: { name, description: `Fake ${name}`, parameters: { type: 'object', additionalProperties: true } },
    execute: async (args: Record<string, unknown>) => { calls.push({ tool: name, ...args }); return { success: true, output: name }; },
  };
}

function registry(): ToolRegistry {
  const owner = new ToolRegistry(); bindAgentResearchSourceOwner(owner, ordinaryResearchOwner());
  return owner;
}

describe('memory and models tools do not guess a mistyped action', () => {
  test('memory refuses an unknown action instead of inferring one from other arguments', async () => {
    const harness: Record<string, unknown>[] = [], local: Record<string, unknown>[] = [];
    const tool = createAgentMemoryTool({
      commandRegistry: {} as CommandRegistry, commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext, toolRegistry: registry(),
      harnessTool: fakeTool('agent_harness', harness), localRegistryTool: fakeTool('agent_local_registry', local),
    });
    const result = await tool.execute({ action: 'obliterate', id: 'm1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown memory action "obliterate"');
    expect(result.error).toContain('search');
    expect([...harness, ...local]).toEqual([]);
  });

  test('memory search forwards limit and semantic to the local registry', async () => {
    const local: Record<string, unknown>[] = [];
    const tool = createAgentMemoryTool({
      commandRegistry: {} as CommandRegistry, commandContext: { workspace: {}, platform: {}, session: { runtime: {} } } as CommandContext, toolRegistry: registry(),
      harnessTool: fakeTool('agent_harness', []), localRegistryTool: fakeTool('agent_local_registry', local),
    });
    await tool.execute({ action: 'search', query: 'deploy', limit: 12, semantic: false });
    expect(local).toEqual([{ tool: 'agent_local_registry', domain: 'memory', action: 'search', query: 'deploy', limit: 12, semantic: false }]);
  });

  test('models refuses an unknown action instead of running status', async () => {
    const calls: Record<string, unknown>[] = [];
    const tool = createAgentModelsTool({
      commandRegistry: {} as CommandRegistry, commandContext: { workspace: {}, platform: {} } as CommandContext, toolRegistry: registry(),
      harnessTool: fakeTool('agent_harness', calls),
    });
    const result = await tool.execute({ action: 'delete', providerId: 'openai' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown models action "delete"');
    expect(calls).toEqual([]);
  });
});

describe('agent_notify partial delivery', () => {
  test('a send that reached some targets is not a failure to retry whole', async () => {
    const tool = createAgentNotifyTool(
      { getCategory: () => ({ webhookUrls: ['https://one.example/hook', 'https://two.example/hook'] }) },
      { setUrls: () => {}, send: async () => ({ attempted: 2, delivered: 1, failed: 1, results: [{ ok: true, url: 'https://one.example/hook' }, { ok: false, url: 'https://two.example/hook', error: 'timeout' }] }) },
    );
    const result = await executeAdmitted(tool, { message: 'Review the approvals' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('delivery incomplete');
    expect(result.output).toContain('Do not resend the whole message');
  });

  test('a send that reached no target is still a failure', async () => {
    const tool = createAgentNotifyTool(
      { getCategory: () => ({ webhookUrls: ['https://one.example/hook'] }) },
      { setUrls: () => {}, send: async () => ({ attempted: 1, delivered: 0, failed: 1, results: [{ ok: false, url: 'https://one.example/hook', error: 'refused' }] }) },
    );
    const result = await executeAdmitted(tool, { message: 'Review the approvals' });
    expect(result.success).toBe(false);
  });
});
