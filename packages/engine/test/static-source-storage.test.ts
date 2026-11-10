/** Lossless storage and actual source-cache entrypoints; no model or digest. */
import { expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';
import { packStaticSourceStorage, unpackStaticSourceStorage, packStaticSourceReadings } from '../scripts/static-source-storage.ts';
import { captureStaticInputs, loadStaticSourceReadings, loadStaticSourceCheckpoint, saveStaticSourceReadings, staticInputStanding, CheckpointValueReader } from '../scripts/static-source-readings.ts';

test('string-table storage preserves literal tag-looking values, own keys and exact numbers', () => {
  const source = JSON.parse('{"__proto__":{"kept":"same text"},"tags":[["s",99],["o",[[99,null]]],["a",[]],["z"]],"same text":"same text","literal":{"storage":"static-source-string-table","version":1,"strings":[],"value":null}}');
  const value = { source, numbers: [0, -0, 0.9876543210987654, 1e-30], unicode: ['\ud800', '😀'] };
  const packed = packStaticSourceStorage(value);
  const decoded = unpackStaticSourceStorage(JSON.parse(JSON.stringify(packed)));
  expect(decoded).toEqual(value);
  if (decoded === null || typeof decoded !== 'object' || !('numbers' in decoded) || !Array.isArray(decoded.numbers)
    || !('source' in decoded) || decoded.source === null || typeof decoded.source !== 'object') throw new Error('Missing decoded original value');
  expect(Object.is(decoded.numbers[1], -0)).toBe(true);
  expect(Object.hasOwn(decoded.source, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(decoded.source)).toBe(Object.prototype);
  expect(packed.strings.filter(text => text === 'same text')).toHaveLength(1);
});

const envelope = (value: unknown, strings = ['field', 'value']) => ({ storage: 'static-source-string-table', version: 1, strings, value });

test.each([-1, 2, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null])('malformed string ordinal %s is refused', ordinal => {
  expect(() => unpackStaticSourceStorage(envelope(['s', ordinal]))).toThrow('Invalid static source storage');
  expect(() => unpackStaticSourceStorage(envelope(['o', [[ordinal, true]]]))).toThrow('Invalid static source storage');
});

test('duplicate encoded keys, duplicate table strings, unknown tags and malformed envelope shapes are refused', () => {
  for (const invalid of [
    envelope(['o', [[0, true], [0, false]]]),
    envelope(['s', 0], ['duplicate', 'duplicate']),
    envelope(['unknown', 0]), envelope(['s', 0, 'extra']), envelope(['z', 0]),
    envelope(['o', [[0]]]), envelope(['a', {}]),
    { ...envelope(null), version: 2 }, { ...envelope(null), extra: true },
    { storage: 'static-source-string-table', version: 1, strings: [] },
  ]) expect(() => unpackStaticSourceStorage(invalid)).toThrow('Invalid static source storage');
});

test('packing refuses holes, extra array keys, cycles and borrowed getters without invoking them', () => {
  let called = 0;
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get() { called++; return 'borrowed'; } });
  const sparse = Array(1), extra = Object.assign(['original'], { named: 'extra' });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [accessor, sparse, extra, cycle, undefined, NaN, Infinity]) {
    expect(() => packStaticSourceStorage(value)).toThrow('Invalid static source storage');
  }
  expect(called).toBe(0);
  expect(() => packStaticSourceReadings([['duplicate', null], ['duplicate', true]])).toThrow('Invalid static source storage');
});

test('packed receipts retain real raw observations through synchronous, streaming and gzip public readers', async () => {
  const root = makeProjectTempDir('static-storage-entrypoints-');
  try {
    const input = captureStaticInputs('internal-identifier', 'platform/src/plain.ts', 'const original = 1;')[0]!;
    const readings = { ...await preparedStaticReadings([input]), readingPlanVersion: 3 as const };
    const text = JSON.stringify(packStaticSourceReadings(Object.entries(readings.readings), 3));
    for (const size of [1, 7, 4093]) {
      const reader = new CheckpointValueReader();
      for (let index = 0; index < text.length; index += size) reader.feed(text.slice(index, index + size));
      expect(reader.finish()).toEqual(readings);
    }
    for (const suffix of ['.json', '.json.gz']) {
      const path = join(root, `readings${suffix}`);
      saveStaticSourceReadings(readings, path);
      expect(loadStaticSourceReadings(path)).toEqual(readings);
      expect(await loadStaticSourceCheckpoint(path)).toEqual(readings);
      expect(staticInputStanding(input, await loadStaticSourceCheckpoint(path))).toEqual({ kind: 'clear' });
    }
    const malformedPath = join(root, 'malformed.json');
    writeFileSync(malformedPath, JSON.stringify(envelope(['o', [[0, 2], [0, 2]]], ['format'])));
    expect(loadStaticSourceReadings(malformedPath)).toBeNull();
    expect(await loadStaticSourceCheckpoint(malformedPath)).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
