import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { captureOwnedJson } from '../gate/judgment-input.js';
import type { ContentPart } from '../providers/interface.js';

/** Exact private inputs for active turns only. Completed-record keys contain no prompt text. */
export class TurnSubmissionOwner {
  readonly #active = new Map<string, unknown>();

  keyFor(input: { readonly sessionId: string; readonly position: number; readonly text: string; readonly content?: readonly ContentPart[] | undefined },
    independent = false): string {
    // Native turn permits already distinguish their independently owned runs.
    if (independent) return randomUUID();
    const captured = captureOwnedJson({ sessionId: input.sessionId, position: input.position, text: input.text, content: input.content ?? [] });
    for (const [key, previous] of this.#active) if (isDeepStrictEqual(captured, previous)) return key;
    const key = randomUUID();
    this.#active.set(key, captured);
    return key;
  }

  release(key: string): void {
    this.#active.delete(key);
  }

  clear(): void { this.#active.clear(); }
}
