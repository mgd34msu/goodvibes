/**
 * The seam between the mailbox poll and the payments composition.
 *
 * The inbox and payments are composed independently and in no fixed order, so
 * neither can hold the other. The inbox calls `observe` for every screened
 * message; payments attaches its handler once it exists. A message observed
 * while nothing is attached is dropped, which only loses an optional report:
 * the message itself is still in the inbox.
 */
import type { OwnerMailObservation } from '@goodvibes/engine/platform/platform/intake';

export type OwnerMailHandler = (mail: OwnerMailObservation) => void;

export interface OwnerMailRelay {
  observe: OwnerMailHandler;
  /** Returns the detach function. A later attach replaces an earlier handler; detaching a replaced handler does nothing. */
  attach(handler: OwnerMailHandler): () => void;
}

export function createOwnerMailRelay(): OwnerMailRelay {
  let current: OwnerMailHandler | undefined;
  return {
    observe(mail) { current?.(mail); },
    attach(handler) {
      current = handler;
      return () => { if (current === handler) current = undefined; };
    },
  };
}
