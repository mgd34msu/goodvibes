import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { canonicalJson, toJson } from '@goodvibes-jev/judgment';
import { captureStaticInputs, staticInputKey, staticInputStanding, staticInputState, type StaticSourceReadings } from '../scripts/static-source-readings.ts';
import { internalIdentifier } from '../scripts/batteries/static-source.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const changedPin = (original: string): string => (original[0] === '0' ? '1' : '0') + original.slice(1);

test('malformed saved state or question commitments reject before hashing expected wire inputs; valid mismatches still compare', async () => {
  const captured = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const publicValue = 3;')[0]!;
  const readings = await preparedStaticReadings([captured], 0.01), key = staticInputKey(captured), receipt = readings.readings[key];
  if (!object(receipt) || !object(receipt.presence)) throw new Error('Missing actual authored presence receipt');
  const original = receipt.presence;
  if (typeof original.stateHash !== 'string' || typeof original.questionsHash !== 'string') throw new Error('Missing original wire commitments');
  const stateWire = canonicalJson(staticInputState(captured));
  const questionsWire = canonicalJson(toJson({ violation: internalIdentifier.items.violation.question }));
  const standing = (presence: Record<string, unknown>) => staticInputStanding(captured,
    { ...readings, readings: { [key]: { ...receipt, presence } } } satisfies StaticSourceReadings);
  const stateHashes = spyOn(Bun.CryptoHasher, 'hash'), questionUpdates = spyOn(crypto.Hash.prototype, 'update');
  const count = () => ({
    state: stateHashes.mock.calls.filter(([algorithm, input]) => algorithm === 'sha256' && input === stateWire).length,
    questions: questionUpdates.mock.calls.filter(([input]) => input === questionsWire).length,
  });
  const clear = () => { stateHashes.mockClear(); questionUpdates.mockClear(); };
  try {
    for (const field of ['stateHash', 'questionsHash'] as const) {
      const missing = { ...original }; delete missing[field]; clear();
      expect(standing(missing).kind).toBe('held'); expect(count()).toEqual({ state: 0, questions: 0 });
      for (const malformed of ['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 7]) {
        clear();
        expect(standing({ ...original, [field]: malformed }).kind).toBe('held');
        expect(count()).toEqual({ state: 0, questions: 0 });
      }
    }
    clear();
    expect(standing({ ...original, stateHash: changedPin(original.stateHash) }).kind).toBe('held');
    expect(count()).toEqual({ state: 1, questions: 0 });
    clear();
    expect(standing({ ...original, questionsHash: changedPin(original.questionsHash) }).kind).toBe('held');
    expect(count()).toEqual({ state: 1, questions: 1 });
    clear();
    expect(standing(original)).toEqual({ kind: 'clear' });
    expect(count()).toEqual({ state: 1, questions: 1 });
  } finally { stateHashes.mockRestore(); questionUpdates.mockRestore(); }
});
