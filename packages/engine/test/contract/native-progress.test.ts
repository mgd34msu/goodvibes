/** The progress a native contract shows while several of its units decide at once. */
import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { decideNativeContract } from '../../platform/src/platform/contract/native-decisions.js';
import { captureNativeContractSource, nativeSourceCriteria } from '../../platform/src/platform/contract/native-source.js';
import type { Contract } from '../../platform/src/platform/contract/types.js';
import { waitFor } from '../_helpers/test-timeout.js';

const authority = { authorityId: 'owned-authority', authorityRevision: '1', scopeId: 'owned-scope', scopeRevision: '1' };

function contract(): Contract {
  const source = captureNativeContractSource({ sourceId: 'owned-source', sourceRevision: '1', inputRevision: 'owned-input',
    criteriaId: 'criteria-v2:11111111-1111-4111-8111-111111111111', criteriaRevision: '1', goal: 'Preserve the original request.', criteria: ['Preserve all requirements.'] });
  return { id: 'ctr-progress', ownerAgentId: 'owned-owner', status: 'running', ask: source.goal, nativeSource: source, goal: source.goal,
    criteria: nativeSourceCriteria(source), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    sessionId: 'owned-session', origin: 'turn', projectRoot: '/owned-synthetic-project', isolation: 'shared' } as unknown as Contract;
}

function decide(value: Contract, targetId: string, signal: AbortSignal, conditions: boolean) {
  const waiting = { ref: { id: 'evidence', revision: '1' }, description: 'External evidence', current: () => ({ id: 'evidence', revision: '1' }),
    wait: (until: AbortSignal) => new Promise<void>((_resolve, reject) => { until.addEventListener('abort', () => reject(until.reason), { once: true }); }) };
  return decideNativeContract(value, { host: { authorityOf: () => authority, ...(conditions ? { conditions: () => [waiting] } : {}) }, changed() {} }, {
    stage: 'stall', targetId, action: `Decide what happens to ${targetId}`, allowAct: true, state: () => ({ target: targetId }) as EntryType,
    continuations: [], signal,
  });
}


test('a unit that decides cannot hide another unit that still waits on an external condition', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((_name, question) => choiceAnswer(question, fake.requests.length === 1 ? 'defer_0' : 'act', 0.99));
  const prior = installJudgmentPort(withDecisionLog(fake.port, log));
  const waiter = new AbortController();
  const value = contract();
  try {
    const first = decide(value, 'u1', waiter.signal, true).catch(() => undefined);
    await waitFor(() => value.nativeProgress?.state === 'deferred');
    const second = await decide(value, 'u2', new AbortController().signal, false);
    expect(second.decision.outcome).toBe('act');
    expect(value.nativeProgress).toMatchObject({ state: 'deferred', targetId: 'u1' });
    waiter.abort();
    await first;
  } finally { installJudgmentPort(prior); }
});

test('a reading that throws leaves nothing shown as deciding', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort(() => { throw new Error('the model is unreachable'); });
  const prior = installJudgmentPort(withDecisionLog(fake.port, log));
  const value = contract();
  try {
    await expect(decide(value, 'u1', new AbortController().signal, false)).rejects.toThrow();
    expect(value.nativeProgress).toBeUndefined();
  } finally { installJudgmentPort(prior); }
});
