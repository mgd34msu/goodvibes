/**
 * The moment this terminal's daemon connection comes back: the spine's
 * liveness turning online (runtime/bootstrap.ts, `sessionUnionCache`'s
 * transition, the same flip that tells the attach handshake a daemon came
 * back). Raised there; nothing here polls or waits. Readers that failed
 * because the daemon did not answer (a place opened while it was down) read
 * again when it fires. The Agent has the same signal in its own runtime.
 * The program's registration needs nothing here: it ends with the connection that proved it (a daemon that went away
 * closed it), and the next call registers again (platform runtime/client/call-context.ts).
 */

type Listener = () => void;

const listeners = new Set<Listener>();

/** Call `listener` each time the daemon connection comes back; returns the unsubscribe. */
export function onDaemonAttached(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The liveness flip to online: the daemon answers (again). */
export function announceDaemonAttached(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A reader's failure to react never undoes or blocks the attach.
    }
  }
}
