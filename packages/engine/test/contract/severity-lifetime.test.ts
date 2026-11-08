import { afterEach, expect, test } from 'bun:test';
import { JudgmentError, type JudgmentPort, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { emptyJudgmentUsage, readUnmetSeverities } from '../../sdk/src/platform/contract/check.js';
import { nativeSourceCriteria } from '../../sdk/src/platform/contract/native-source.js';
import type { NativeContractServices } from '../../sdk/src/platform/contract/native-decisions.js';
import type { NativeContractSource } from '../../sdk/src/platform/contract/types.js';
import { checkPort } from './check-port.js';
import { makeContract, makeCriterion, makeUnit } from './fixtures.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const restores: Array<ReturnType<typeof installJudgmentPort>> = [];
afterEach(() => { for (const previous of restores.splice(0).reverse()) installJudgmentPort(previous); });

function heldPort() {
  const base = checkPort({ severity: { choice: 'major', confidence: 0.9 } }).port;
  const calls: Array<{ readonly request: JudgmentRequest<Questions>; readonly finish: () => void; readonly fail: (error: unknown) => void }> = [];
  const port: JudgmentPort = {
    model: base.model,
    async ask(request) {
      const response = await base.ask(request);
      const hold = deferred();
      calls.push({ request, finish: hold.resolve, fail: hold.reject });
      await hold.promise;
      return { ...response, usage: { inputTokens: 7, outputTokens: 3 } };
    },
  };
  restores.push(installJudgmentPort(port));
  async function until(count: number) {
    for (let attempt = 0; attempt < 200 && calls.length < count; attempt++) await Promise.resolve();
    expect(calls.length).toBe(count);
  }
  return { calls, until };
}

function unitWith(count: number) {
  return makeUnit({ criteria: Array.from({ length: count }, (_, index) => makeCriterion({ id: `u1.c${index + 1}`, text: `original criterion ${index + 1}` })) });
}

test('a failed severity batch drains its admitted siblings, retains their usage and stops queued work', async () => {
  const held = heldPort();
  const usage = emptyJudgmentUsage();
  const unit = unitWith(9);
  let settled = false;
  const batch = readUnmetSeverities({ contract: makeContract(), unit, criterionIds: unit.criteria.map(c => c.id), usage });
  const outcome = batch.then(() => { settled = true; return null; }, error => { settled = true; return error as unknown; });
  await held.until(4);
  held.calls[0]!.finish();
  await held.until(5);
  const failure = new JudgmentError('unavailable', 'The test endpoint is unavailable');
  held.calls[1]!.fail(failure);
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  expect(settled).toBe(false);
  expect(held.calls).toHaveLength(5);
  for (const call of held.calls.slice(2)) call.finish();
  expect(await outcome).toBe(failure);
  expect(usage).toEqual({ calls: 4, inputTokens: 28, outputTokens: 12 });
  expect(held.calls).toHaveLength(5);
});

test('queued severities retain their original words and output order across concurrent edits', async () => {
  const held = heldPort();
  const unit = unitWith(6);
  const contract = { ask: makeContract().ask };
  const originalAsk = contract.ask;
  const originalGoal = unit.goal;
  const batch = readUnmetSeverities({ contract, unit, criterionIds: unit.criteria.map(c => c.id) });
  await held.until(4);
  contract.ask = 'A later owner request';
  unit.goal = 'A later goal';
  for (const criterion of unit.criteria) criterion.text = 'A later criterion';
  held.calls[3]!.finish();
  await held.until(5);
  held.calls[2]!.finish();
  await held.until(6);
  for (const call of held.calls) call.finish();
  const result = await batch;
  expect([...result.severities.keys()]).toEqual(['u1.c1', 'u1.c2', 'u1.c3', 'u1.c4', 'u1.c5', 'u1.c6']);
  for (const [index, call] of held.calls.entries()) {
    expect(call.request.state).toEqual({ request: originalAsk, goal: originalGoal, criterion: `original criterion ${index + 1}` });
  }
  expect(result.usage).toEqual({ calls: 6, inputTokens: 42, outputTokens: 18 });
});

test('cancellation keeps its original owner and waits for late responses before final accounting', async () => {
  const held = heldPort();
  const controller = new AbortController();
  const replacement = new AbortController();
  const unit = unitWith(7);
  const usage = emptyJudgmentUsage();
  const input = { contract: makeContract(), unit, criterionIds: unit.criteria.map(c => c.id), signal: controller.signal, usage };
  let settled = false;
  const outcome = readUnmetSeverities(input).then(() => { settled = true; return null; }, error => { settled = true; return error as unknown; });
  await held.until(4);
  input.signal = replacement.signal;
  const stopped = new Error('Original severity owner cancelled');
  controller.abort(stopped);
  held.calls[0]!.finish();
  for (let turn = 0; turn < 20; turn++) await Promise.resolve();
  expect(settled).toBe(false);
  for (const call of held.calls.slice(1)) call.finish();
  expect(await outcome).toBe(stopped);
  expect(held.calls).toHaveLength(4);
  expect(usage).toEqual({ calls: 4, inputTokens: 28, outputTokens: 12 });
  expect(replacement.signal.aborted).toBe(false);
});

test('a native post-response authority refusal still accounts for the completed response', async () => {
  const held = heldPort();
  const source: NativeContractSource = {
    sourceId: 'severity-source', sourceRevision: '1', inputRevision: '1', criteriaId: 'criteria', criteriaRevision: '1',
    goal: 'Preserve the parser requirements', criteria: ['The parser accepts every documented form'],
  };
  const contract = makeContract({ nativeSource: source, goal: source.goal, criteria: nativeSourceCriteria(source) });
  const unit = unitWith(1);
  let revision = '1';
  const services: NativeContractServices = {
    host: { authorityOf: () => ({ authorityId: 'host', authorityRevision: revision, scopeId: 'project', scopeRevision: '1' }) },
    changed() {},
  };
  const usage = emptyJudgmentUsage();
  const outcome = readUnmetSeverities({ native: { contract, services }, contract, unit, criterionIds: ['u1.c1'], usage })
    .then(() => null, error => error as unknown);
  await held.until(1);
  revision = '2';
  held.calls[0]!.finish();
  expect(await outcome).toBeInstanceOf(JudgmentError);
  expect(usage).toEqual({ calls: 1, inputTokens: 7, outputTokens: 3 });
});
