import { afterEach, expect, test } from 'bun:test';
import { DecisionModelsDisabledError, decisionModelPolicyState, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { classifyInboundIntent, parseWorkProposalReply, renderWorkProposalMessage } from '../sdk/src/platform/agents/conversation-gate.js';
import { readConnectorCapabilities } from '../sdk/src/platform/agents/connector-reading.js';
import { readConversationIntent, readProposalReply } from '../sdk/src/platform/agents/conversation-reading.js';

let previous: JudgmentPort | undefined, installed = false;
afterEach(() => { if (installed) installJudgmentPort(previous); installed = false; });
function install(port: JudgmentPort | undefined) { previous = installJudgmentPort(port); installed = true; }

test.each(['Classic - Off', 'Preferred'] as const)('%s defaults unclassified intake to conversation and leaves conversational proposal approval unanswered', async policy => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => policy, async () => {
    expect(await classifyInboundIntent('Can you change the release configuration?')).toEqual({ kind: 'conversation', reason: 'classic-conversation-default' });
    const attempted = fake.requests.length;
    expect(await parseWorkProposalReply('Yes, start that now.', 'Deploy the stored proposal')).toBeNull();
    expect(await classifyInboundIntent('Hello again.')).toMatchObject({ kind: 'conversation', reason: 'classic-conversation-default' });
    expect(fake.requests).toHaveLength(attempted);
    expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
    expect(renderWorkProposalMessage({ summary: 'An existing saved proposal', expiresInMs: 60_000 })).toContain('does not interpret conversational approval');
  });
});

test('Classic standalone semantic APIs disclose the limitation instead of fabricating classifications', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(readConversationIntent('Change a file.')).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    await expect(readProposalReply('yes', 'Deploy the service')).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    await expect(readConnectorCapabilities([{ name: 'get_mail', description: 'Can send mail.' }])).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(await readConnectorCapabilities([])).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });
});

test('Preferred exhausted connector classification reports unavailable capability without labelling an effectful tool read-only', async () => {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); install(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    await expect(readConnectorCapabilities([{ name: 'get_calendar', description: 'Creates an event and sends invitations.' }])).rejects.toBeInstanceOf(DecisionModelsDisabledError);
    expect(decisionModelPolicyState().operation).toBe('classic');
  });
});

for (const kind of ['rejected', 'invalid-response', 'invalid-request', 'aborted'] as const) {
  test(`Preferred intake ${kind} remains a terminal failure, not conversational fallback or approval`, async () => {
    const fake = fakePort(() => { throw new JudgmentError(kind, 'Synthetic terminal failure'); }); install(fake.port);
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(classifyInboundIntent('Change the file.')).rejects.toThrow();
      await expect(parseWorkProposalReply('yes', 'Deploy')).rejects.toThrow();
      expect(decisionModelPolicyState().operation).toBe('decision');
    });
  });
}

test('Default retains actual semantic work and proposal reply readings', async () => {
  const fake = fakePort((name, question) => choiceAnswer(question, name === 'intent' ? 'work' : 'affirmative', 0.999)); install(fake.port);
  await withDecisionModelPolicy(() => 'Default - On', async () => {
    expect(await classifyInboundIntent('Change the file.')).toMatchObject({ kind: 'work', reason: 'settled-jev-reading' });
    expect(await parseWorkProposalReply('Yes, only that file.', 'Change the file')).toEqual({ decision: 'affirmative', note: 'Yes, only that file.' });
    expect(fake.requests).toHaveLength(2);
  });
});

test('Classic entry points honor cancellation even for empty input', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); install(fake.port);
  const controller = new AbortController(); controller.abort();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    await expect(classifyInboundIntent('', controller.signal)).rejects.toThrow();
    await expect(parseWorkProposalReply('', '', controller.signal)).rejects.toThrow();
    await expect(readConnectorCapabilities([], controller.signal)).rejects.toThrow();
    expect(fake.requests).toHaveLength(0);
  });
});
