import { afterAll, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { createAgentPersonalOpsTool } from '../../tools/agent-personal-ops-tool.ts';
import { personalOpsNativeFields } from '../../tools/agent-personal-ops-native-fields.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

describe('personal_ops action words', () => {
  test('an unrecognised action is an error, not a different read', async () => {
    const calls: Record<string, unknown>[] = [];
    const harness: Tool = { definition: { name: 'agent_harness', description: 'Fake', parameters: { type: 'object', additionalProperties: true } },
      execute: async args => { calls.push(args); return { success: true, output: '{}' }; } };
    const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const tool = createAgentPersonalOpsTool({ commandRegistry: {} as CommandRegistry, commandContext: {} as CommandContext, toolRegistry: registry, harnessTool: harness });
    const result = await tool.execute({ action: 'send', recordId: 'r1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Personal Ops action 'send'");
    expect(result.error).toContain('briefing');
    expect(calls).toEqual([]);
  });

  test('an unrecognised action is not hidden by a recognised mode', async () => {
    const calls: Record<string, unknown>[] = [];
    const harness: Tool = { definition: { name: 'agent_harness', description: 'Fake', parameters: { type: 'object', additionalProperties: true } },
      execute: async args => { calls.push(args); return { success: true, output: '{}' }; } };
    const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, ordinaryResearchOwner());
    const tool = createAgentPersonalOpsTool({ commandRegistry: {} as CommandRegistry, commandContext: {} as CommandContext, toolRegistry: registry, harnessTool: harness });
    const result = await tool.execute({ action: 'delete', mode: 'read', recordId: 'r1' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown Personal Ops action 'delete'");
    expect(calls).toEqual([]);
  });
});

describe('personal ops native field declarations', () => {
  test('filesystem locations and webhook URLs are not declared content, so they stay withheld', () => {
    const declared = personalOpsNativeFields({ record: { title: 'Plan', contentPath: '/home/u/a.md', metadataPath: '/home/u/a.json', workspacePath: '/home/u/w', webhookUrl: 'https://hooks.example/T0/secret' } })
      .map(field => field.path.join('.'));
    expect(declared).toContain('record.title');
    for (const name of ['contentPath', 'metadataPath', 'workspacePath', 'webhookUrl']) expect(declared).not.toContain(`record.${name}`);
  });
});
