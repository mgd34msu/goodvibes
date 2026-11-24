/**
 * list-changes.ts, one notice from a store when a list a client shows changed
 * (a memory record, a workspace checkpoint, a CI watch, a check-in setting or
 * receipt, a person or device in the people list), so a client reads the list
 * again on the event instead of showing it stale.
 *
 * A store calls `noteListChanged` after its write is durable; the daemon
 * forwards every notice as the runtime event LIST_CHANGED (workspace domain).
 * Process-wide like the stores it serves; a notice costs one call per listener
 * and nothing with none.
 */

/**
 * The lists that announce their changes: also the mailbox (mail arrived or a
 * message was changed), the calendar (an event written, a feed read with
 * changes), dates (occasions, their plans and gifts), paired devices (a pairing
 * token issued or revoked), delegated Telegram messages held for review, the
 * local voice install, and Tailscale (its serve state changed).
 */
export type ChangedList = 'memory' | 'checkpoints' | 'ci-watches' | 'check-ins' | 'people'
  | 'mail' | 'calendar' | 'dates' | 'paired-devices' | 'telegram-intake' | 'voice' | 'tailscale' | 'relay';

export interface ListChange {
  readonly list: ChangedList;
  readonly change: 'created' | 'changed' | 'deleted';
  /** The record that changed, when the store names one. */
  readonly id?: string | undefined;
}

const listeners = new Set<(change: ListChange) => void>();

/** Told of every list change in this process; returns the unsubscribe. */
export function onListChanged(listener: (change: ListChange) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Say a list changed; never throws into the store that wrote. */
export function noteListChanged(change: ListChange): void {
  for (const listener of [...listeners]) {
    try { listener(change); } catch { /* A listener cannot fail a store's write. */ }
  }
}
