import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { formatAgentOperatorBriefing } from '../../input/commands/brief-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeContext(stores: { readonly workPlan?: () => unknown[]; readonly jobs?: () => unknown[] }): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-brief-unavailable');
  const shellPaths = createShellPathService({ workingDirectory: join(root, 'work'), homeDirectory: root });
  const configValues = new Map<string, unknown>([['controlPlane.host', '127.0.0.1'], ['controlPlane.port', 3421]]);
  return {
    print: () => undefined,
    renderRequest: () => undefined,
    exit: () => undefined,
    session: { runtime: { provider: 'openai-subscriber', model: 'gpt-5.5', debugMode: false, systemPrompt: '', reasoningEffort: 'medium', sessionId: 'session-brief' } },
    provider: { providerRegistry: { getCurrentModel: () => ({ displayName: 'GPT 5.5' }) } },
    workspace: { shellPaths, workPlanStore: { listItems: stores.workPlan ?? (() => []) } },
    platform: {
      configManager: { get: (key: string) => configValues.get(key) },
      voiceProviderRegistry: { list: () => [] },
      mediaProviderRegistry: { list: () => [] },
    },
    ops: { automationManager: { listJobs: stores.jobs ?? (() => []) } },
    extensions: {},
    clients: { agentKnowledgeApi: { memory: { getAll: () => [], reviewQueue: () => [] } } },
  } as unknown as CommandContext;
}

describe('/brief with an unreadable store', () => {
  test('an empty work plan and schedule list read as empty', () => {
    const output = formatAgentOperatorBriefing(makeContext({}));
    expect(output).toContain('work plan empty');
    expect(output).toContain('schedules 0/0 visible jobs enabled');
  });

  test('a work plan that throws is reported as unavailable, not as empty', () => {
    const output = formatAgentOperatorBriefing(makeContext({ workPlan: () => { throw new Error('work plan file is locked'); } }));
    expect(output).toContain('work plan unavailable: work plan file is locked');
    expect(output).not.toContain('work plan empty');
  });

  test('a schedule list that throws is reported as unavailable, not as 0/0', () => {
    const output = formatAgentOperatorBriefing(makeContext({ jobs: () => { throw new Error('automation manager stopped'); } }));
    expect(output).toContain('schedules unavailable: automation manager stopped');
    expect(output).not.toContain('schedules 0/0');
  });
});
