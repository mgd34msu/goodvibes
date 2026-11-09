import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { ntfySurface, surfaceIdFor, surfaceLabel } from '../sdk/src/platform/cluster/surface-id.js';

// Regression source UNRUN until the remaining coding work is finished.
test('repeated election and status lookups reuse an original surface wire identity without retaining plaintext cache keys', () => {
  const surface = ntfySurface('https://ntfy.test/', 'private-consumer-topic');
  const expected = crypto.createHash('sha256').update('goodvibes/cluster/surface/v1').update('\0')
    .update('ntfy:https://ntfy.test/private-consumer-topic').digest('hex').slice(0, 32);
  const hash = spyOn(crypto, 'createHash');
  try {
    for (let index = 0; index < 30; index++) {
      expect(surfaceIdFor(surface)).toBe(expected);
      expect(surfaceLabel(surface)).toBe(`ntfy:${expected.slice(0, 8)}`);
    }
    expect(hash).toHaveBeenCalledTimes(1);
    // An independently constructed key computes the same actual deployed wire
    // selector. There is no global table keyed on private topic spellings.
    expect(surfaceIdFor(ntfySurface('https://ntfy.test', 'private-consumer-topic'))).toBe(expected);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(Object.isFrozen(surface)).toBe(true);
  } finally { hash.mockRestore(); }
});

test('borrowed mutable keys and public copies cannot reuse an original surface result', () => {
  const surface = ntfySurface('https://ntfy.test', 'first-topic'), first = surfaceIdFor(surface);
  const borrowed = { ...surface }, hash = spyOn(crypto, 'createHash');
  try {
    expect(surfaceIdFor(borrowed)).toBe(first);
    borrowed.discriminator = 'https://ntfy.test/another-topic';
    expect(surfaceIdFor(borrowed)).not.toBe(first);
    expect(hash).toHaveBeenCalledTimes(2);
    const nativeGet = WeakMap.prototype.get;
    try {
      WeakMap.prototype.get = () => ({ id: first });
      expect(surfaceIdFor(borrowed)).not.toBe(first);
      expect(surfaceIdFor(surface)).toBe(first);
    } finally { WeakMap.prototype.get = nativeGet; }
  } finally { hash.mockRestore(); }
});
