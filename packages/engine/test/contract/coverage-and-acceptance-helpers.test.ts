/**
 * The plan-coverage conclusion, the final-acceptance policy check and the
 * accepted-research selection, which decide what a contract may publish.
 */
import { expect, test } from 'bun:test';
import { coverageConclusion } from '../../platform/src/platform/contract/batteries/plan-coverage.js';
import { acceptedResearchIds } from '../../platform/src/platform/contract/accepted-research.js';
import { changedFinalAcceptancePolicy } from '../../platform/src/platform/contract/acceptance-policy.js';
import { DELIVERABLE_JUDGES } from '../../platform/src/platform/contract/batteries/deliverable-judge.js';
import { FINAL_ANSWER_REVIEWS } from '../../platform/src/platform/contract/batteries/final-answer-review.js';
import type { ContractView } from '../../platform/src/platform/contract/types.js';
import { amendTarget } from '../../platform/src/platform/contract/amendment.js';
import { readContractConfig } from '../../platform/src/platform/contract/config.js';
import { ContractRun } from '../../platform/src/platform/contract/run-context.js';
import { configReader } from './plan-support.js';
import { makeContract, makeUnit } from './fixtures.js';

function part(verdict: 'yes' | 'no', probability: number, outcome: 'act' | 'confirm' | 'escalate') {
  return { kind: 'unquoted' as const, words: 'w', criteria: [], reading: { verdict, probability, outcome } } as never;
}

test('a plan with no readable parts is not reported as covered at act', () => {
  expect(coverageConclusion([])).toEqual({ uncovered: 'no', signal: 0, outcome: 'escalate' });
});

test('a part that leans yes makes the plan uncovered, and every part reading no at act makes it covered at act', () => {
  expect(coverageConclusion([part('no', 0.05, 'act'), part('yes', 0.95, 'act')])).toMatchObject({ uncovered: 'yes', outcome: 'act' });
  expect(coverageConclusion([part('no', 0.05, 'act'), part('no', 0.1, 'act')])).toMatchObject({ uncovered: 'no', outcome: 'act' });
  expect(coverageConclusion([part('no', 0.05, 'act'), part('no', 0.1, 'confirm')])).toMatchObject({ uncovered: 'no', outcome: 'confirm' });
});

test('accepted research is a passed research unit with a passing, decided check and a read that is not an artifact', () => {
  const passedCheck = { id: 'u.k1', result: 'pass', decisionIds: ['d1'] };
  const read = (path: string) => ({ path, contentKind: 'file' });
  const base = { role: 'research' as const, status: 'passed' as const, checks: [passedCheck] as never };
  const good = makeUnit({ id: 'good', ...base, readEvidence: [read('notes.md')] as never });
  const artifactOnly = makeUnit({ id: 'artifact', ...base, readEvidence: [read('out.md')] as never, touchedPaths: ['out.md'] });
  const declared = makeUnit({ id: 'declared', ...base, readEvidence: [{ path: 'x', contentKind: 'declared-reference' }] as never });
  const notResearch = makeUnit({ id: 'impl', ...base, role: 'implement', readEvidence: [read('a.md')] as never });
  const undecided = makeUnit({ id: 'undecided', ...base, checks: [{ id: 'u.k2', result: 'pass', decisionIds: [] }] as never, readEvidence: [read('a.md')] as never });
  const ids = acceptedResearchIds({ units: [good, artifactOnly, declared, notResearch, undecided] });
  expect([...ids]).toEqual(['good']);
});

test('a final-acceptance policy change asks for a fresh check only for a non-passing saved check made under another policy', () => {
  const stakes = 'high' as const;
  const fulfillment = DELIVERABLE_JUDGES[stakes], content = FINAL_ANSWER_REVIEWS[stakes];
  const policy = (name: string) => ({ fulfillment: { name: fulfillment.name, version: fulfillment.version }, content: { name: content.name, version: content.version }, stakes: name });
  const view = (result: 'pass' | 'nudge', receiptPolicy: unknown): ContractView => {
    const contract = makeContract({ checks: [{ id: 'c.k1', result, decisionIds: ['d1'] } as never] });
    contract.decisions.push({ id: 'c.d1', at: 1, action: 'checked', targetId: `${contract.id}.final-answer-review`, decisionIds: ['d1'],
      reason: JSON.stringify({ schemaVersion: 2, policy: receiptPolicy }) });
    return contract as unknown as ContractView;
  };
  expect(changedFinalAcceptancePolicy(view('nudge', policy('other')), stakes)).toBe(true);
  expect(changedFinalAcceptancePolicy(view('nudge', policy(stakes)), stakes)).toBe(false);
  expect(changedFinalAcceptancePolicy(view('pass', policy('other')), stakes)).toBe(false);
});

test('a native contract refuses a legacy owner amendment without running a planner', async () => {
  const contract = makeContract({ nativeSource: { synthetic: true } as never });
  const unexpected = (): never => { throw new Error('unexpected effect'); };
  const run = new ContractRun(contract, { now: () => 1, config: () => readContractConfig(configReader()), emit: unexpected, touchAgent: unexpected },
    { passGroup: unexpected, finishPassed: unexpected, fail: unexpected, cancel: unexpected });
  const outcome = await amendTarget(run, { scope: 'unit', targetId: 'u1' } as never, 'change it', new Proxy({}, { get: unexpected }) as never);
  expect(outcome.kind).toBe('problems');
});

test('with no repair limit, a planner that repeats the same rejected amendment ends the loop with its problems', async () => {
  const contract = makeContract({ units: [makeUnit()] });
  const unexpected = (): never => { throw new Error('unexpected effect'); };
  const run = new ContractRun(contract, { now: () => 1, config: () => readContractConfig(configReader()), emit: unexpected, touchAgent: unexpected },
    { passGroup: unexpected, finishPassed: unexpected, fail: unexpected, cancel: unexpected });
  let calls = 0;
  const context = {
    configManager: configReader(),
    routeSelector: async () => ({ model: 'm', provider: 'p', reason: 'planner' }),
    decompositionRunner: { run: async () => { calls += 1; return { status: 'completed', output: '{"criteria":[]}' }; } },
  };
  const outcome = await amendTarget(run, { scope: 'unit', targetId: 'u1' } as never, 'change it', context as never);
  expect(outcome.kind).toBe('problems');
  expect(calls).toBe(2);
});
