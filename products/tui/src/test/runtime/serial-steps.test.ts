/**
 * createSerialSteps, the rule that two overlapping replacements of one shared
 * handle never interleave.
 */
import { describe, expect, test } from 'bun:test';
import { createSerialSteps } from '../../runtime/serial-steps.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('serial steps', () => {
  test('a step starts only after the earlier one has finished, in call order', async () => {
    const run = createSerialSteps();
    const log: string[] = [];
    const gate = deferred();
    const first = run(async () => { log.push('first:start'); await gate.promise; log.push('first:end'); return 1; });
    const second = run(async () => { log.push('second:start'); return 2; });

    await Promise.resolve();
    expect(log).toEqual(['first:start']);

    gate.resolve();
    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(log).toEqual(['first:start', 'first:end', 'second:start']);
  });

  test('a step that fails does not block the next, and each caller gets its own outcome', async () => {
    const run = createSerialSteps();
    const failed = run(async () => { throw new Error('boom'); });
    const next = run(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });
});
