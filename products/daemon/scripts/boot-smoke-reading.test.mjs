import { expect, test } from 'bun:test';
import { proveNativeMemoryRoundTrip } from './boot-smoke-reading.mjs';

test('unavailable vec0 cannot pass through successful memory HTTP or lexical fallback', async () => {
  const calls = [];
  await expect(proveNativeMemoryRoundTrip(async method => {
    calls.push(method);
    if (method === 'memory.records.add') return { record: { id: 'synthetic' } };
    return { vector: { backend: 'sqlite-vec', enabled: true, available: false, indexedRecords: 0, error: 'synthetic native loader failure' } };
  })).rejects.toThrow();
  expect(calls).toEqual(['memory.records.add', 'memory.vector.stats']);
});
