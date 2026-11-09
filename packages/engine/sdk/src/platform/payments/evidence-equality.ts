import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';

/** Compare retained JSON facts across the null-prototype hostile-input parser
 * and native objects. This does not retain live object continuity or grant
 * authority; callers separately pin original generations across awaits. */
export function samePaymentEvidence(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(captureOwnedJson(left), captureOwnedJson(right));
}
