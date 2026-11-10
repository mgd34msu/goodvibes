import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { AsyncDisposalError } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { closeE2EFixture, makeHome, startStubModel } from './harness.ts';
import { startE2EJudgments } from './judgment-fixture.ts';

for (const owner of ['model', 'judgment'] as const) test(`${owner} original stop is awaited before removing the TUI fixture home`, async () => {
  const model = startStubModel(() => ({ text: 'Unused cleanup fixture response' }));
  let judgments: ReturnType<typeof startE2EJudgments> | undefined;
  let ownedHome: Awaited<ReturnType<typeof makeHome>> | null = null;
  let releaseHeld: (() => void) | undefined;
  let restoreStop: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  try {
    const decision = startE2EJudgments(); judgments = decision;
    const home = await makeHome(model); ownedHome = home;
    const selected = owner === 'model' ? model : decision;
    const originalStop = selected.stop.bind(selected);
    const gate = Promise.withResolvers<void>(); releaseHeld = gate.resolve;
    const entered = Promise.withResolvers<void>();
    const stop = spyOn(selected, 'stop').mockImplementation(async () => {
      entered.resolve(); await gate.promise;
      const draining = originalStop(); expect(draining).toBeInstanceOf(Promise); await draining;
    });
    restoreStop = () => stop.mockRestore();
    let settled = false;
    closing = closeE2EFixture(home, () => model.stop(), () => decision.stop())
      .finally(() => { settled = true; });
    try {
      await entered.promise;
      expect(settled).toBe(false);
      expect(existsSync(home.root)).toBe(true);
      gate.resolve(); await closing;
      expect(settled).toBe(true);
      expect(existsSync(home.root)).toBe(false);
    } finally { gate.resolve(); await closing.catch(() => {}); stop.mockRestore(); }
  } catch (error) { failure = { error }; throw error; }
  finally {
    releaseHeld?.(); await closing?.catch(() => {}); restoreStop?.();
    try { await closeE2EFixture(ownedHome, () => model.stop(), () => judgments?.stop()); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure.error, cleanup], 'Cleanup control setup/assertion and drainage failed');
      throw cleanup;
    }
  }
});

test('TUI fixture cleanup attempts every owner and preserves original failures and the home on unsuccessful drainage', async () => {
  const model = startStubModel(() => ({ text: 'Unused cleanup fixture response' }));
  let judgments: ReturnType<typeof startE2EJudgments> | undefined;
  let ownedHome: Awaited<ReturnType<typeof makeHome>> | null = null;
  let failure: { error: unknown } | undefined;
  try {
    const decision = startE2EJudgments(); judgments = decision;
    const home = await makeHome(model); ownedHome = home;
    const first = new Error('First original owner failure'), second = new Error('Second original owner failure');
    const calls: string[] = [];
    const result = await closeE2EFixture(home,
      () => { calls.push('first'); throw first; },
      async () => { calls.push('second'); throw second; },
      async () => { calls.push('model'); await model.stop(); },
      async () => { calls.push('judgment'); await decision.stop(); },
    ).then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(AsyncDisposalError);
    if (!(result instanceof AsyncDisposalError)) throw new Error('Original cleanup failures were not retained');
    expect(result.failures.map(failure => failure.error)).toEqual([first, second]);
    expect(calls).toEqual(['first', 'second', 'model', 'judgment']);
    expect(existsSync(home.root)).toBe(true);
  } catch (error) { failure = { error }; throw error; }
  finally {
    try { await closeE2EFixture(ownedHome, () => model.stop(), () => judgments?.stop()); }
    catch (cleanup) {
      if (failure) throw new AggregateError([failure.error, cleanup], 'Cleanup control setup/assertion and drainage failed');
      throw cleanup;
    }
  }
});

test('no-home setup failure still drains the original model and retains a simultaneous cleanup failure', async () => {
  const model = startStubModel(() => ({ text: 'Unused failed-setup fixture response' }));
  const setup = new Error('Original home setup failure'), cleanup = new Error('Independent cleanup failure');
  const originalStop = model.stop.bind(model);
  let drained = false;
  try {
    const result = await (async () => {
      try { throw setup; }
      catch (error) {
        try {
          await closeE2EFixture(null,
            async () => { await originalStop(); drained = true; },
            () => { throw cleanup; },
          );
        } catch (disposal) { throw new AggregateError([error, disposal], 'Original setup and cleanup failed'); }
        throw error;
      }
    })().then(() => undefined, (error: unknown) => error);
    expect(result).toBeInstanceOf(AggregateError);
    if (!(result instanceof AggregateError)) throw new Error('Setup failure was not retained');
    expect(result.errors[0]).toBe(setup);
    expect(result.errors[1]).toBeInstanceOf(AsyncDisposalError);
    if (!(result.errors[1] instanceof AsyncDisposalError)) throw new Error('Cleanup failure was not retained');
    expect(result.errors[1].failures.map(failure => failure.error)).toEqual([cleanup]);
    expect(drained).toBe(true);
  } finally { await originalStop(); }
});
