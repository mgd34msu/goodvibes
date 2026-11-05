import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { CommandContext } from '../../input/command-registry.ts';
import { explainAgentPolicyDecision } from '../../tools/agent-policy-explanation.ts';
import { computeApprovalPosture } from '../../permissions/approval-posture.ts';

function context(mode: string, autoApprove = false): CommandContext {
  return {
    workspace: {},
    platform: {
      config: { behavior: { autoApprove }, permissions: { mode, tools: {} } },
      configManager: { get: (key: string) => key === 'permissions.mode' ? mode : key === 'behavior.autoApprove' ? autoApprove : undefined },
    },
    session: { runtime: {} },
  } as CommandContext;
}

function registry(onExecute: () => void): ToolRegistry {
  const tools = new ToolRegistry();
  tools.register({
    definition: { name: 'write', description: 'Write a file', parameters: { type: 'object', additionalProperties: true } },
    execute: async () => { onExecute(); return { success: true, output: '' }; },
  });
  return tools;
}

describe('policy explanation observes execution mode without performing the operation', () => {
  let previous: ReturnType<typeof installJudgmentPort>;
  beforeEach(() => { previous = installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'write', 0.99)).port); });
  afterEach(() => { installJudgmentPort(previous); });

  test.each(['safe-owner', 'safe-jev', 'yolo', 'plan', 'prompt', 'allow-all', 'auto'])(
    '%s reports the same posture as status and performs zero effects', async mode => {
      let effects = 0;
      const result = await explainAgentPolicyDecision(context(mode), registry(() => { effects++; }), { toolName: 'write', toolArgs: { file: 'example.txt', content: 'example' } });
      expect(result.status).toBe('found');
      if (result.status !== 'found') throw new Error('Missing explanation');
      const expected = computeApprovalPosture({ mode, autoApprove: false });
      expect(result.explanation.posture).toMatchObject({
        mode: expected.mode, label: expected.label, detail: expected.detail,
        autoApprove: expected.autoApprove, automaticApprovals: expected.automaticApprovals,
        bypassesPrompts: expected.bypassesPrompts,
      });
      expect(effects).toBe(0);
      expect(result.explanation.preflight).toMatchObject({ permissionEvaluated: false, permissionOutcome: 'unknown' });
    });

  test('legacy auto-approve is displayed as YOLO', async () => {
    const result = await explainAgentPolicyDecision(context('safe-owner', true), registry(() => { throw new Error('Must not execute'); }), { toolName: 'write' });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('Missing explanation');
    expect(result.explanation.posture).toMatchObject({ mode: 'yolo', automaticApprovals: true, bypassesPrompts: true });
  });

  test('an uncertain category remains explicitly unevaluated', async () => {
    installJudgmentPort(fakePort((_name, question) => choiceAnswer(question, 'read', 0.4)).port);
    const result = await explainAgentPolicyDecision(context('safe-owner'), registry(() => { throw new Error('Must not execute'); }), { toolName: 'write' });
    expect(result.status).toBe('found');
    if (result.status !== 'found') throw new Error('Missing explanation');
    expect(result.explanation).toMatchObject({ categoryConfident: false, preflight: { permissionEvaluated: false } });
  });

  test('unavailable classification remains an operational error', async () => {
    installJudgmentPort(undefined);
    await expect(explainAgentPolicyDecision(context('safe-owner'), registry(() => {}), { toolName: 'write' })).rejects.toThrow('judgment port');
  });
});
