import { afterEach, expect, test } from 'bun:test';
import { decisionModelPolicyState, installJudgmentPort, type DecisionModelPolicy } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { forgetDescriptionReadings, ToolContractVerifier } from '../sdk/src/platform/runtime/tools/contract-verifier.js';
import { ToolContractsPanel } from '../sdk/src/platform/runtime/diagnostics/panels/tool-contracts.js';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.js';
import type { Tool } from '../sdk/src/platform/types/tools.js';
import { createContractIntake, type ContractIntakeDeps } from '../sdk/src/platform/contract/intake-route.js';
import { classifyBookkeepingFailure } from '../sdk/src/platform/orchestration/bookkeeping.js';
import { makeContract } from './contract/fixtures.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; forgetDescriptionReadings(); });
const under = <T>(policy: DecisionModelPolicy, work: () => T) => withDecisionModelPolicy(() => policy, work);
function install(port: JudgmentPort | undefined) { previous = installJudgmentPort(port); installed = true; }
const description = 'Retrieve the exact file requested by the owner.';
function tool(name: string, parameters: Tool['definition']['parameters'] = { type: 'object', properties: {} }): Tool {
  return { definition: { name, description, parameters }, execute: async () => ({ success: true }) };
}

test.each(['Classic - Off', 'Preferred'] as const)('%s full registered-tool diagnostics retain native failures and unassessed description provenance', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic outage'); }); install(fake.port);
  await under(policy, async () => {
    const registry = new ToolRegistry();
    registry.register(tool('read'));
    const results = await registry.verifyAllContracts({ strictIdempotency: false });
    const read = results.get('read');
    expect(read).toMatchObject({ passed: true, descriptionQuality: 'not-evaluated', provenance: 'classic' });
    const panel = new ToolContractsPanel(); panel.load(results);
    expect(panel.get('read')).toMatchObject({ descriptionQuality: 'not-evaluated', provenance: 'classic' });
    expect(ToolContractVerifier.formatAllResults(results)).toContain('Description quality was not assessed');
    const invalid = await new ToolContractVerifier().verify(tool('broken', { type: 'tuple' }));
    expect(invalid.passed).toBe(false);
    expect(invalid.violations.some(v => v.severity === 'error' && v.dimension === 'schema')).toBe(true);
    expect(policy === 'Classic - Off' ? fake.requests.length === 0 : fake.requests.length > 0).toBe(true);
    panel.dispose();
  });
});

test('Classic full verification does not consume a description judgment cached by Default - On', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); install(fake.port);
  const verifier = new ToolContractVerifier();
  const structural = verifier.verifyStructure(tool('read'));
  const assessed = await under('Default - On', () => verifier.verify(tool('read')));
  expect(assessed.descriptionQuality).toBe('assessed'); expect(assessed.violations).toHaveLength(structural.violations.length + 1);
  const attempted = fake.requests.length;
  const classic = await under('Classic - Off', () => verifier.verify(tool('read')));
  expect(classic.descriptionQuality).toBe('not-evaluated'); expect(classic.violations).toEqual(structural.violations);
  expect(fake.requests).toHaveLength(attempted);
});

function intakeRunner(waiting: boolean) {
  let starts = 0, replies = 0;
  const runner: ContractIntakeDeps['runner'] = {
    list: () => waiting ? [{ ...makeContract(), sessionId: 'session', escalations: [{
      id: 'pending', at: 1, scope: 'unit', targetId: 'u1', reason: 'unsettled', question: 'Approve this exact work?', unmetCriterionIds: [],
    }] }] : [],
    start: () => { starts++; throw new Error('Unexpected contract start'); },
    reply: async () => { replies++; throw new Error('Unexpected contract reply'); },
  };
  return { runner, counts: () => ({ starts, replies }) };
}

for (const waiting of [false, true]) {
  test.each(['Classic - Off', 'Preferred'] as const)(`%s leaves chat and pending contract replies untouched, waiting=${waiting}`, async policy => {
    const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic outage'); }); install(fake.port);
    const h = intakeRunner(waiting);
    await under(policy, async () => {
      const intake = createContractIntake({ runner: h.runner, projectRoot: '/synthetic' });
      expect(await intake.intake({ text: 'yes, and explain this file', sessionId: 'session' })).toEqual({ kind: 'turn' });
      const attempted = fake.requests.length;
      expect(await intake.intake({ text: 'continue the conversation', sessionId: 'session' })).toEqual({ kind: 'turn' });
      expect(fake.requests).toHaveLength(attempted);
      expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
      expect(h.counts()).toEqual({ starts: 0, replies: 0 });
    });
  });
}

test('Preferred never replays an admitted contract reply when the effect itself reports unavailable', async () => {
  const fake = fakePort((name, question) => name === 'responds' ? noulAnswer(0.99) : choiceAnswer(question, 'contract', 0.99)); install(fake.port);
  const h = intakeRunner(true); let replies = 0;
  h.runner.reply = async () => { replies++; throw new JudgmentError('unavailable', 'Failure after entering reply'); };
  await under('Preferred', async () => {
    const intake = createContractIntake({ runner: h.runner, projectRoot: '/synthetic' });
    await expect(intake.intake({ text: 'yes', sessionId: 'session' })).rejects.toThrow('Failure after entering reply');
    expect(replies).toBe(1); expect(decisionModelPolicyState().operation).toBe('decision');
  });
});

test('Classic intake retains cancellation and native source-admission restrictions', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); install(fake.port);
  await under('Classic - Off', async () => {
    const h = intakeRunner(false); const controller = new AbortController(); controller.abort();
    const intake = createContractIntake({ runner: h.runner, projectRoot: '/synthetic' });
    await expect(intake.intake({ text: 'hello', sessionId: 'session', signal: controller.signal })).rejects.toThrow();
    await expect(createContractIntake({ runner: { ...h.runner, nativeMode: true }, projectRoot: '/synthetic' })
      .intake({ text: 'hello', sessionId: 'session' })).rejects.toThrow('source-bearing host admission');
    expect(fake.requests).toHaveLength(0); expect(h.counts()).toEqual({ starts: 0, replies: 0 });
  });
});

test.each(['Classic - Off', 'Preferred'] as const)('%s preserves an undiagnosed git failure with current native ownership', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic outage'); }); install(fake.port);
  await under(policy, async () => {
    let active = true; const error = new Error('The pre-commit hook rejected this commit.');
    const result = await classifyBookkeepingFailure(error, { assertCurrent: () => { if (!active) throw new Error('Retired owner'); } });
    expect(result).toMatchObject({ classification: 'held', reason: error.message, provenance: 'classic' });
    expect(() => result.assertCurrent()).not.toThrow();
    error.message = 'Replaced failure'; expect(() => result.assertCurrent()).toThrow('source replaced');
    error.message = 'The pre-commit hook rejected this commit.'; active = false;
    expect(() => result.assertCurrent()).toThrow('Retired owner');
    expect(policy === 'Classic - Off' ? fake.requests.length === 0 : fake.requests.length > 0).toBe(true);
  });
});

test('Default and Preferred do not disguise a genuine semantic repository finding as Classic', async () => {
  const fake = fakePort(() => noulAnswer(0.99)); install(fake.port);
  await under('Preferred', async () => {
    const result = await classifyBookkeepingFailure(new Error('The repository index is locked.'));
    expect(result.classification).toBe('negating'); expect(result.provenance).toBeUndefined();
    expect(decisionModelPolicyState().operation).toBe('decision');
  });
});
