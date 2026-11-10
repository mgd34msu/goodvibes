/** Raw-cache plumbing only: authored unit ports never certify model accuracy. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { noul } from '@goodvibes-jev/judgment';
import { captureStaticInputs, staticInputKey, staticInputStanding, staticInputState, type StaticSourceReadings } from '../scripts/static-source-readings.ts';
import { internalIdentifier } from '../scripts/batteries/static-source.ts';
import { preparedStaticReadings } from './_helpers/static-source-evidence.ts';

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

test('saved raw state and questions must match exactly; malformed and changed snapshots never clear', async () => {
  const captured = captureStaticInputs('internal-identifier', 'platform/src/example.ts', 'const publicValue = 3;')[0]!;
  const readings = await preparedStaticReadings([captured], 0.01), key = staticInputKey(captured), receipt = readings.readings[key];
  if (!object(receipt) || !object(receipt.presence)) throw new Error('Missing authored unit presence observation');
  const original = receipt.presence;
  expect(original.state).toEqual(staticInputState(captured));
  expect(original.questions).toEqual({ violation: internalIdentifier.items.violation.question });
  const standing = (presence: Record<string, unknown>) => staticInputStanding(captured,
    { ...readings, readings: { [key]: { ...receipt, presence } } } satisfies StaticSourceReadings);
  const hashing = spyOn(crypto, 'createHash'), nativeHashing = spyOn(Bun.CryptoHasher, 'hash');
  try {
    for (const field of ['state', 'questions'] as const) {
      const missing = { ...original }; delete missing[field];
      expect(standing(missing).kind).toBe('held');
      for (const malformed of ['', null, 7, [], { unrelated: true }]) {
        expect(standing({ ...original, [field]: malformed }).kind).toBe('held');
      }
    }
    expect(standing({ ...original, state: { source: 'Changed original body.' } }).kind).toBe('held');
    expect(standing({ ...original, questions: { violation: noul('An independently different question.') } }).kind).toBe('held');
    expect(standing(structuredClone(original))).toEqual({ kind: 'clear' });
    expect(hashing).not.toHaveBeenCalled(); expect(nativeHashing).not.toHaveBeenCalled();
  } finally { hashing.mockRestore(); nativeHashing.mockRestore(); }
});
