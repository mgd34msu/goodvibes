/**
 * relay-stream-overflow.ts, honest accounting of live events dropped for this browser.
 *
 * Live event streams can lose frames two ways: the daemon drops frames for a reader that
 * fell behind (the stream reports a typed gap), and the relay tunnel's bounded send buffer
 * overflows (the tunnelled stream ends with a typed gap error and reconnects from its last
 * event id). Every stream consumer (session updates, control-plane invalidation, chat turns)
 * records either here with the dropped count; nothing is ever written into a stream's body.
 *
 * This tiny module-level store accumulates the dropped count and notifies React subscribers.
 * RelayOverflowBanner refetches every query once per burst, by itself: the missed events were
 * only ever invalidation triggers, so a full refetch restores the true state.
 * acknowledgeRelayOverflow() clears the count when that refetch starts.
 */

export interface RelayOverflowSnapshot {
  /** Total live events dropped over the relay since the last acknowledge. */
  readonly totalDropped: number;
  /** Epoch ms of the most recent overflow notice, or 0 when none is outstanding. */
  readonly lastAt: number;
  /** Bumped on every change so useSyncExternalStore sees a fresh reference. */
  readonly epoch: number;
}

let snapshot: RelayOverflowSnapshot = { totalDropped: 0, lastAt: 0, epoch: 0 };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record an overflow notice. A non-positive count still bumps the notice (events were dropped). */
export function noteRelayOverflow(dropped: number): void {
  const add = Number.isFinite(dropped) && dropped > 0 ? Math.floor(dropped) : 0;
  snapshot = {
    totalDropped: snapshot.totalDropped + add,
    lastAt: Date.now(),
    epoch: snapshot.epoch + 1,
  };
  emit();
}

/** Clear the outstanding overflow count (the resync owner calls it as its refetch starts). */
export function acknowledgeRelayOverflow(): void {
  if (snapshot.totalDropped === 0 && snapshot.lastAt === 0) return;
  snapshot = { totalDropped: 0, lastAt: 0, epoch: snapshot.epoch + 1 };
  emit();
}

export function subscribeRelayOverflow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRelayOverflowSnapshot(): RelayOverflowSnapshot {
  return snapshot;
}
