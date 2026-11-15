import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { explainAgentPolicyDecision } from '../../tools/agent-policy-explanation.ts';

const context = { workspace: {}, platform: { config: { behavior: { autoApprove: false }, permissions: { mode: 'prompt', tools: {} } },
  configManager: { get: (key: string) => key === 'permissions.mode' ? 'prompt' : undefined } }, session: { runtime: {} } } as unknown as CommandContext;

function registryWith(confirmDescription: string, requestDescription: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: 'sample_effect', description: 'Sample effect', parameters: { type: 'object', additionalProperties: false, properties: {
      value: { type: 'string' },
      confirm: { type: 'boolean', description: confirmDescription },
      explicitUserRequest: { type: 'string', description: requestDescription },
    } } },
    execute: async () => ({ success: true, output: '' }),
  });
  return registry;
}

describe('policy explanation for tools whose confirm fields are provenance only', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'write', 0.99)).port); });
  afterEach(() => { installJudgmentPort(previous); });

  test('asks for recorded admission, never for confirm:true, with or without the fields', async () => {
    const registry = registryWith('Optional audit annotation; does not grant effect authority.', 'Optional request provenance; does not grant effect authority.');
    for (const toolArgs of [{ value: 'x' }, { value: 'x', confirm: true, explicitUserRequest: 'please' }]) {
      const result = await explainAgentPolicyDecision(context, registry, { toolName: 'sample_effect', toolArgs });
      if (result.status !== 'found') throw new Error('Missing explanation');
      const explanation = result.explanation as { status: string; requiredActions: string[]; preflight: Record<string, unknown> };
      expect(explanation.status).toBe('held');
      expect(explanation.preflight).toMatchObject({ recordedAdmissionRequired: true, toolConfirmationRequired: false, toolConfirmationSatisfied: false });
      expect(explanation.requiredActions.join(' ')).toContain('recorded');
      expect(explanation.requiredActions.join(' ')).not.toContain('confirm:true');
    }
  });

  test.each([
    ['never grants authority', 'Optional request context; never grants authority.'],
    ['grants no authority', 'Optional caller annotation; grants no authority.'],
    ['admission authorizes writes', 'Optional request provenance. Recorded engine admission authorizes writes.'],
    ['supplies authority', 'Optional audit text for the phase; current recorded effect admission supplies authority.'],
    ['user request provenance', 'Optional user request provenance.'],
    ['optional provenance', 'Optional provenance; never grants write authority.'],
  ])('shipped wording "%s" is recognised as provenance only', async (_label, description) => {
    const registry = registryWith(description, description);
    const result = await explainAgentPolicyDecision(context, registry, { toolName: 'sample_effect', toolArgs: { value: 'x' } });
    if (result.status !== 'found') throw new Error('Missing explanation');
    const explanation = result.explanation as { status: string; requiredActions: string[] };
    expect(explanation.status).toBe('held');
    expect(explanation.requiredActions.join(' ')).not.toContain('confirm:true');
  });

  test('a tool whose fields really gate the call still asks for them', async () => {
    const registry = registryWith('Must be true to run.', 'The authorizing request.');
    const result = await explainAgentPolicyDecision(context, registry, { toolName: 'sample_effect', toolArgs: { value: 'x' } });
    if (result.status !== 'found') throw new Error('Missing explanation');
    expect(result.explanation).toMatchObject({ status: 'confirmation_required' });
  });
});
