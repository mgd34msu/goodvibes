import { expect, test } from 'bun:test';
import { drainOwned } from '../src/drain-owned.ts';
import { runInNewContext } from 'node:vm';

test('late rejection is observed while the original synchronous refusal remains visible', async () => {
  let reject: (error: Error) => void = () => {};
  const work = new Promise((_resolve, fail) => { reject = fail; });
  const refused = () => { drainOwned(work); throw new Error('Original authority refusal'); };
  expect(refused).toThrow('Original authority refusal');
  reject(new Error('Late borrowed callback failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('plain and proxy thenables are refused without reading borrowed properties', async () => {
  let reads = 0;
  const borrowed = { get then() { reads++; throw new Error('Hostile then'); } };
  expect(() => { drainOwned(borrowed); throw new Error('Original refusal'); }).toThrow('Original refusal');
  const proxy = new Proxy({}, { get() { reads++; throw new Error('Proxy then'); } });
  expect(() => { drainOwned(proxy); throw new Error('Original refusal'); }).toThrow('Original refusal');
  await new Promise(resolve => setTimeout(resolve, 0)); expect(reads).toBe(0);
});

test('a genuine cross-realm Promise rejection is observed without reading an overridden then', async () => {
  // Own the pending work before it rejects. Bun's test runner reports an
  // already rejected vm promise during runInNewContext, before it returns.
  const { work, reject } = runInNewContext('(() => { let reject; const work = new Promise((_, fail) => { reject = fail; }); return { work, reject }; })()') as { work: Promise<unknown>; reject: (reason: Error) => void };
  let reads = 0;
  Object.defineProperty(work, 'then', { get() { reads++; throw new Error('Borrowed then'); } });
  expect(() => { drainOwned(work); throw new Error('Original refusal'); }).toThrow('Original refusal');
  reject(new Error('Synthetic other-realm failure'));
  await new Promise(resolve => setTimeout(resolve, 0)); expect(reads).toBe(0);
});

test.each(['constructor', 'species'] as const)('intrinsic genuine Promise %s failure is contained without replacing refusal', boundary => {
  const work = Promise.resolve('already fulfilled'); let reads = 0;
  const fail = () => { reads++; throw new Error('Synthetic intrinsic Promise construction failure'); };
  if (boundary === 'constructor') Object.defineProperty(work, 'constructor', { get: fail });
  else Object.defineProperty(work, 'constructor', { value: Object.defineProperty({}, Symbol.species, { get: fail }) });
  expect(() => { drainOwned(work); throw new Error('Original refusal'); }).toThrow('Original refusal');
  expect(reads).toBe(1);
});


test('discarding already fulfilled work does not re-assimilate its later borrowed then accessor', async () => {
  const value = {}; const work = Promise.resolve(value); let gets = 0;
  Object.defineProperty(value, 'then', { get() { gets++; return undefined; } });
  drainOwned(work);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(gets).toBe(0);
});
