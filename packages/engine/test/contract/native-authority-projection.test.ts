/** What a native decision hands the host to establish authority: identity and admission, never a copy of the whole contract. */
import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type EntryType } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { decideNativeContract } from '../../platform/src/platform/contract/native-decisions.js';
import { captureNativeContractSource, nativeSourceCriteria } from '../../platform/src/platform/contract/native-source.js';
import type { Contract, ContractView } from '../../platform/src/platform/contract/types.js';

const authority = { authorityId: 'owned-authority', authorityRevision: '1', scopeId: 'owned-scope', scopeRevision: '1' };

test('the host sees the contract without its file manifest and decision history, and cannot change the original', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const fake = fakePort((_name, question) => choiceAnswer(question, 'act', 0.99));
  const prior = installJudgmentPort(withDecisionLog(fake.port, log));
  const source = captureNativeContractSource({ sourceId: 'owned-source', sourceRevision: '1', inputRevision: 'owned-input',
    criteriaId: 'criteria-v2:11111111-1111-4111-8111-111111111111', criteriaRevision: '1', goal: 'Preserve the original request.', criteria: ['Preserve all requirements.'] });
  const manifest = { id: 'snapshot', files: Array.from({ length: 50_000 }, (_, index) => ({ path: `src/f${index}.ts`, kind: 'file' })) };
  const contract = { id: 'ctr-projection', ownerAgentId: 'owned-owner', status: 'running', ask: source.goal, nativeSource: source, goal: source.goal,
    criteria: nativeSourceCriteria(source), judgmentUsage: { calls: 0, inputTokens: 0, outputTokens: 0 }, inputSnapshot: manifest,
    sessionId: 'owned-session', origin: 'turn', projectRoot: '/owned-synthetic-project', isolation: 'worktree' } as unknown as Contract;
  const seen: ContractView[] = [];
  try {
    await decideNativeContract(contract, { host: { authorityOf: (view) => { seen.push(view); (view as { ask: string }).ask = 'changed by the host'; return authority; } }, changed() {} }, {
      stage: 'stall', targetId: 'u1', action: 'Decide what happens to u1', allowAct: true, state: () => ({ target: 'u1' }) as EntryType,
      continuations: [], signal: new AbortController().signal,
    });
  } finally { installJudgmentPort(prior); }
  expect(seen.length).toBeGreaterThan(0);
  for (const view of seen) {
    expect(view.id).toBe('ctr-projection');
    expect(view.nativeSource).toEqual(source);
    expect(view.inputSnapshot).toBeUndefined();
  }
  expect(contract.ask).toBe(source.goal);
  expect(contract.inputSnapshot).toBe(manifest as never);
});
