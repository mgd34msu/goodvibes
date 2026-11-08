import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../../gate/judgment-input.js';

let ownerSequence = 0;

/** One live owner's latest exact selection. Labels reveal no selected values
 * and convey no permission. Recovery binds durable host/principal records
 * separately; these labels are not persisted revisions or cross-process IDs.
 */
export class OwnedSelectionObservation {
  readonly #owner: number;
  #revision = 0;
  #current: { readonly value: unknown; readonly identity: string } | undefined;

  constructor() {
    if (!Number.isSafeInteger(++ownerSequence)) throw new Error('Selection owner identity exhausted');
    this.#owner = ownerSequence;
    Object.freeze(this);
  }

  readonly observe = (value: unknown): string => {
    let captured: unknown;
    try { captured = captureOwnedJson(value); }
    catch (error) { this.#current = undefined; throw error; }
    if (this.#current && isDeepStrictEqual(this.#current.value, captured)) return this.#current.identity;
    if (!Number.isSafeInteger(++this.#revision)) throw new Error('Selection revision exhausted');
    const identity = `selection-${this.#owner}-${this.#revision}`;
    this.#current = { value: captured, identity };
    return identity;
  };

  /** A failed read retires the last selection even if a later read recovers it. */
  readonly retire = (): void => { this.#current = undefined; };
}
