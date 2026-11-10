import { expect, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { assertSynchronousJudgmentGuard, createSystemOnePort, DEFAULT_MODEL, JudgmentError, noul } from '../src/index.ts';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('synchronous attempt guards preserve receiver, callback order and original thrown errors', () => {
  const calls: string[] = [];
  const owner = { check() { expect(this).toBe(owner); calls.push('original'); } };
  calls.push('before'); assertSynchronousJudgmentGuard(() => owner.check()); calls.push('after');
  expect(calls).toEqual(['before', 'original', 'after']);
  const error = new Error('Original owner refusal');
  let seen: unknown;
  try { assertSynchronousJudgmentGuard(() => { throw error; }); } catch (caught) { seen = caught; }
  expect(seen).toBe(error);
});

for (const value of [null, false, 0, '', 'private callback result']) test(`nonvoid ${typeof value} attempt return is a value-free typed refusal`, () => {
  let seen: unknown;
  try { assertSynchronousJudgmentGuard(() => value); } catch (caught) { seen = caught; }
  expect(seen).toBeInstanceOf(JudgmentError);
  expect(seen).toMatchObject({ kind: 'invalid-request', message: 'the judgment attempt guard must be synchronous and complete without a return value' });
});

for (const mode of ['return', 'throw'] as const) test(`${mode}ed original rejected work is observed without replacing its refusal`, async () => {
  const work = Promise.withResolvers<void>();
  let seen: unknown;
  try { assertSynchronousJudgmentGuard(() => { if (mode === 'throw') throw work.promise; return work.promise; }); }
  catch (error) { seen = error; }
  if (mode === 'throw') expect(seen).toBe(work.promise);
  else expect(seen).toMatchObject({ kind: 'invalid-request' });
  work.reject(new Error('Late original callback rejection'));
  await tick();
});

test('other-realm native work drains and borrowed thenables are not assimilated', async () => {
  const { work, reject } = runInNewContext('(() => { let reject; const work = new Promise((_, fail) => { reject = fail; }); return { work, reject }; })()') as { work: Promise<void>; reject: (error: Error) => void };
  let reads = 0;
  Object.defineProperty(work, 'then', { get() { reads++; throw new Error('Borrowed then'); } });
  expect(() => assertSynchronousJudgmentGuard(() => work)).toThrow(JudgmentError);
  reject(new Error('Late cross-realm rejection'));
  const thenable = { get then() { reads++; throw new Error('Plain then accessor'); } };
  const proxy = new Proxy({}, { get() { reads++; throw new Error('Proxy getter'); } });
  expect(() => assertSynchronousJudgmentGuard(() => thenable)).toThrow(JudgmentError);
  expect(() => assertSynchronousJudgmentGuard(() => proxy)).toThrow(JudgmentError);
  await tick(); expect(reads).toBe(0);
});

for (const mode of ['return', 'throw'] as const) test(`native transport ${mode}ed Promise guard drains and never sends a wire request`, async () => {
  let wires = 0, guards = 0;
  const port = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic-fixture' }, model: DEFAULT_MODEL, timeoutMs: 1000, signal: new AbortController().signal,
    retry: {}, fetch: async () => { wires++; throw new Error('Unexpected dispatch'); } });
  const work = Promise.withResolvers<void>();
  await expect(port.ask({ state: 'synthetic owner', questions: { yes: noul('Synthetic question') },
    beforeAttempt: () => { guards++; if (mode === 'throw') throw work.promise; return work.promise; },
  })).rejects.toMatchObject({ kind: mode === 'return' ? 'invalid-request' : 'rejected' });
  expect(guards).toBe(1); expect(wires).toBe(0);
  work.reject(new Error('Late rejected guard'));
  await tick();
});

for (const mode of ['return', 'throw'] as const) test(`native retention ${mode}ed work rejects without a retained row or unhandled late rejection`, async () => {
  const { SqliteDecisionLog, withDecisionLog } = await import('../src/index.ts');
  using log = new SqliteDecisionLog(':memory:');
  let calls = 0;
  const port = withDecisionLog({ model: DEFAULT_MODEL, async ask() { calls++; throw new Error('Unexpected delegated request'); } }, log);
  const work = Promise.withResolvers<void>();
  await expect(port.ask({ state: 'synthetic retention source', questions: { yes: noul('Synthetic question') },
    assertLogCurrent: () => { if (mode === 'throw') throw work.promise; return work.promise; },
  })).rejects.toMatchObject({ kind: 'rejected', message: 'the judgment request was rejected' });
  expect(calls).toBe(0); expect(log.query()).toEqual([]);
  work.reject(new Error('Late original retention failure'));
  await tick();
});
