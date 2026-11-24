/**
 * The moment this Agent attaches to its connected daemon: at start when it
 * answers, and again each time it answers after a loss. Raised by the
 * memory-spine adoption edge (`onAttach` in runtime/bootstrap.ts), which the
 * existing heartbeat recheck drives; nothing here polls or waits. Readers that
 * failed because the daemon did not answer read again when it fires.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

/** Call `listener` on every attach; returns the unsubscribe. */
export function onDaemonAttached(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The adoption edge: the connected daemon answers (again). */
export function announceDaemonAttached(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A reader's failure to react never undoes or blocks the attach.
    }
  }
}
