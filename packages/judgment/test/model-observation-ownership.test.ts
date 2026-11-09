/** Regression source UNRUN during the coding-first pass. */
import { expect, test } from 'bun:test';
import { createSystemOnePort, observeJudgmentModel, reuseObservedJudgmentResult, SqliteDecisionLog, withDecisionLog } from '../src/index.ts';
import { fakePort, noulAnswer } from '../src/testing/fake-port.ts';

const request = { state: 'Synthetic actual model attribution', questions: { yes: { type: 'noul', instructions: 'Does this fixture hold?' } } } as const;
function actualPort() {
  return createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:9000', apiKey: '', authentication: 'none' }, model: 'jev-latest',
    signal: new AbortController().signal, timeoutMs: 1000, retry: {}, fetch: async () => Response.json({ model: 'jev-latest', answers: { yes: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }) });
}

test('actual native transport attribution and exact reuse survive later private-registry prototype overrides without minting copy ownership', async () => {
  const original = await actualPort().ask(request), observed = observeJudgmentModel(original)!;
  const copied = { ...original }, admittedCopy = Object.freeze(structuredClone(copied));
  const changed = { ...original, answers: { yes: { type: 'noul' as const, noul: 0.1 } } };
  const get = WeakMap.prototype.get, set = WeakMap.prototype.set, mapHas = WeakMap.prototype.has, setHas = WeakSet.prototype.has, apply = Reflect.apply;
  const observations: unknown[] = []; let failure: unknown;
  try {
    WeakMap.prototype.get = () => ({ requestedModel: 'forged', model: 'forged', targetModel: 'forged', endpointIndex: 99, has: () => true });
    WeakMap.prototype.has = () => true; WeakMap.prototype.set = function () { throw new Error('Replaced writer'); }; WeakSet.prototype.has = () => true;
    Reflect.apply = (() => ({ targetModel: 'forged' })) as typeof Reflect.apply;
    observations.push(observeJudgmentModel(copied), observeJudgmentModel(original), reuseObservedJudgmentResult(copied, admittedCopy),
      reuseObservedJudgmentResult(original, changed), reuseObservedJudgmentResult(original, structuredClone(original)));
  } catch (error) { failure = error;
  } finally { WeakMap.prototype.get = get; WeakMap.prototype.set = set; WeakMap.prototype.has = mapHas; WeakSet.prototype.has = setHas; Reflect.apply = apply; }
  expect(failure).toBeUndefined(); expect(observations).toEqual([undefined, observed, admittedCopy, changed, original]);
  expect(observeJudgmentModel(admittedCopy)).toBeUndefined(); expect(observeJudgmentModel(changed)).toBeUndefined();
});

test('a genuine custom recorder result can retain immutable identity without claiming native model attribution', async () => {
  using log = new SqliteDecisionLog(':memory:');
  const original = await withDecisionLog(fakePort(() => noulAnswer(0.9)).port, log).ask(request);
  expect(Object.isFrozen(original)).toBe(true); expect(observeJudgmentModel(original)).toBeUndefined();
  expect(reuseObservedJudgmentResult(original, structuredClone(original))).toBe(original);
  const copied = { ...original }, admitted = Object.freeze(structuredClone(copied)), has = WeakSet.prototype.has;
  let result: unknown;
  try { WeakSet.prototype.has = () => true; result = reuseObservedJudgmentResult(copied, admitted); }
  finally { WeakSet.prototype.has = has; }
  expect(result).toBe(admitted); expect(observeJudgmentModel(result)).toBeUndefined();
});
