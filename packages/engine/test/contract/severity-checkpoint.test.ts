import { afterEach, expect, spyOn, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { contractPath, deserializeContract } from '../../sdk/src/platform/contract/store.js';
import { makeHarness, makeRepo, oneUnitPlan, startContract, waitFor, type AgentStep, type Harness } from './runner-support.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const owned: Array<{ readonly harness: Harness; readonly holds: ReturnType<typeof deferred>[]; readonly previous: ReturnType<typeof installJudgmentPort> }> = [];
afterEach(async () => {
  for (const { harness, holds, previous } of owned.splice(0).reverse()) {
    for (const hold of holds) hold.resolve();
    const contracts = harness.runner.list({ includeTerminal: true });
    harness.runner.dispose();
    await Promise.all(contracts.map(contract => harness.runner.join(contract.id)));
    installJudgmentPort(previous);
    harness.dispose();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

async function setup(criteria = 1, followup: readonly AgentStep[] = [{ text: 'Working on the nudge', stop: { kind: 'hang' } }]) {
  const harness = makeHarness({ root: makeRepo(), plan: oneUnitPlan(criteria), scripts: {
    u1: () => [{ files: { 'src/csv.ts': 'export const parse = 1;\n' }, text: 'First incomplete parser [unmet]' }, ...followup],
  } });
  const base = judgmentPort('test.severity-checkpoint');
  const holds: ReturnType<typeof deferred>[] = [];
  const port: JudgmentPort = {
    ...base,
    async ask(request) {
      const response = await base.ask(request);
      if (request.context?.battery !== 'contract.unmet-severity') return response;
      // The response and decision-log entry already exist. Retain its delivery
      // to the runner across a later nudge, terminal event or disposal.
      const hold = deferred();
      holds.push(hold);
      await hold.promise;
      return { ...response, usage: { inputTokens: 7001, outputTokens: 3001 } };
    },
  };
  const previous = installJudgmentPort(port);
  owned.push({ harness, holds, previous });
  const { contract } = await startContract(harness);
  return { h: harness, contract, holds };
}

function persisted(h: Harness, id: string) {
  const contract = deserializeContract(readFileSync(contractPath(h.root, id), 'utf-8'));
  if (contract === null) throw new Error('The contract checkpoint is unreadable');
  return contract;
}

test('late severity changes write an explicit checkpoint without needing another contract event', async () => {
  const { h, contract, holds } = await setup();
  await waitFor(() => holds.length === 1, 'the held severity response');
  const unit = h.store.get(contract.id)!.units[0]!;
  const before = { ...h.store.get(contract.id)!.judgmentUsage };
  h.store.flush();
  const events = h.events.length;
  holds[0]!.resolve();
  await waitFor(() => h.store.get(contract.id)!.judgmentUsage.calls === before.calls + 1, 'late severity accounting');
  expect(h.events).toHaveLength(events);
  const saved = persisted(h, contract.id);
  expect(saved.judgmentUsage).toEqual({ calls: before.calls + 1, inputTokens: before.inputTokens + 7001, outputTokens: before.outputTokens + 3001 });
  expect(saved.units[0]!.criteria[0]!.readings[0]!.severity).toBe('major');
  expect(unit.criteria[0]!.readings[0]!.severityDecisionId).toBeDefined();
});

test('a later check keeps its own reading when an earlier severity response arrives', async () => {
  const { h, contract, holds } = await setup(1, [
    { files: { 'src/csv.ts': 'export const parse = () => [];\n' }, text: 'Fixed parser', tool: true },
    { text: 'Continue working', stop: { kind: 'hang' } },
  ]);
  await waitFor(() => holds.length === 1 && h.store.get(contract.id)!.units[0]!.checks.length >= 2, 'the next check');
  const unit = h.store.get(contract.id)!.units[0]!;
  const later = structuredClone(unit.criteria[0]!.readings[1]!);
  holds[0]!.resolve();
  await waitFor(() => unit.criteria[0]!.readings[0]!.severity !== undefined, 'the original check severity');
  expect(unit.criteria[0]!.readings[1]).toEqual(later);
  const saved = persisted(h, contract.id);
  expect(saved.units[0]!.criteria[0]!.readings[0]!.severity).toBe('major');
  expect(saved.units[0]!.criteria[0]!.readings[1]).toEqual(later);
});

test('cancellation joins late severity responses and checkpoints their usage without applying them', async () => {
  const { h, contract, holds } = await setup();
  await waitFor(() => holds.length === 1, 'the held severity response');
  const before = { ...h.store.get(contract.id)!.judgmentUsage };
  expect(h.runner.cancel(contract.id, 'Cancelled by the operator')).toBe(true);
  h.store.flush();
  let settled = false;
  const joined = h.runner.join(contract.id).then(() => { settled = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  holds[0]!.resolve();
  await joined;
  const saved = persisted(h, contract.id);
  expect(saved.status).toBe('cancelled');
  expect(saved.judgmentUsage).toEqual({ calls: before.calls + 1, inputTokens: before.inputTokens + 7001, outputTokens: before.outputTokens + 3001 });
  expect(saved.units[0]!.criteria[0]!.readings[0]!.severity).toBeUndefined();
});

test('a sibling severity failure saves successful usage after draining instead of losing the batch', async () => {
  const { h, contract, holds } = await setup(2);
  await waitFor(() => holds.length === 2, 'both held severity responses');
  const before = { ...h.store.get(contract.id)!.judgmentUsage };
  holds[0]!.reject(new JudgmentError('unavailable', 'The test endpoint is unavailable'));
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(h.store.get(contract.id)!.status).not.toBe('failed');
  holds[1]!.resolve();
  await waitFor(() => h.store.get(contract.id)!.status === 'failed', 'the drained severity failure');
  await h.runner.join(contract.id);
  const saved = persisted(h, contract.id);
  expect(saved.judgmentUsage).toEqual({ calls: before.calls + 1, inputTokens: before.inputTokens + 7001, outputTokens: before.outputTokens + 3001 });
  expect(saved.units[0]!.criteria.every(criterion => criterion.readings[0]!.severity === undefined)).toBe(true);
});

test('disposal persists late usage into the resumable snapshot without persisting cancellation state', async () => {
  const { h, contract, holds } = await setup();
  await waitFor(() => holds.length === 1, 'the held severity response');
  h.runner.dispose();
  const before = persisted(h, contract.id);
  expect(before.status).toBe('running');
  let settled = false;
  const joined = h.runner.join(contract.id).then(() => { settled = true; });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  holds[0]!.resolve();
  await joined;
  const after = persisted(h, contract.id);
  expect(after.judgmentUsage).toEqual({ calls: before.judgmentUsage.calls + 1, inputTokens: before.judgmentUsage.inputTokens + 7001, outputTokens: before.judgmentUsage.outputTokens + 3001 });
  expect({ ...after, judgmentUsage: before.judgmentUsage }).toEqual(before);
});

test('a failed late checkpoint is a local failure and the drained terminal write retains its usage', async () => {
  const { h, contract, holds } = await setup();
  await waitFor(() => holds.length === 1, 'the held severity response');
  h.store.flush();
  const before = { ...h.store.get(contract.id)!.judgmentUsage };
  const write = h.store.write.bind(h.store);
  const failure = spyOn(h.store, 'write').mockImplementationOnce(() => false).mockImplementation(write);
  try {
    holds[0]!.resolve();
    await waitFor(() => h.store.get(contract.id)!.status === 'failed', 'the local checkpoint failure');
    await h.runner.join(contract.id);
    const saved = persisted(h, contract.id);
    expect(saved.failureKind).toBe('other');
    expect(saved.error).toBe('The severity usage checkpoint could not be saved');
    expect(saved.judgmentUsage).toEqual({ calls: before.calls + 1, inputTokens: before.inputTokens + 7001, outputTokens: before.outputTokens + 3001 });
    expect(failure).toHaveBeenCalledTimes(2);
  } finally { failure.mockRestore(); }
});
