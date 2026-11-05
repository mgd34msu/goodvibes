import { expect, test } from 'bun:test';
import { drainOwned } from '../src/drain-owned.ts';

test('late rejection is observed while the original synchronous refusal remains visible', async () => {
  let reject: (error: Error) => void = () => {};
  const work = new Promise((_resolve, fail) => { reject = fail; });
  const refused = () => { drainOwned(work); throw new Error('Original authority refusal'); };
  expect(refused).toThrow('Original authority refusal');
  reject(new Error('Late borrowed callback failure'));
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('hostile then access is observed without replacing the host refusal', async () => {
  let reads = 0;
  const borrowed = { get then() { reads++; throw new Error('Hostile then'); } };
  expect(() => { drainOwned(borrowed); throw new Error('Original refusal'); }).toThrow('Original refusal');
  await new Promise(resolve => setTimeout(resolve, 0)); expect(reads).toBe(1);
});
