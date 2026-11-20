/** Require both the close response and the matching real lifecycle frame. */
export interface LifecycleHandlers {
  onReady: () => void;
  onEvent: (event: { readonly name: string; readonly payload: unknown }) => void;
  /** Frames were dropped: the matching frame may be among them. */
  onGap: (gap: { readonly dropped: number }) => void;
  /** The stream ended (`closed` is this proof's own cleanup). */
  onEnd: (end: { readonly kind: string }) => void;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function requireSessionCloseReceipt(options: {
  sessionId: string;
  eventName: string;
  open: (handlers: LifecycleHandlers) => Promise<() => void>;
  close: () => Promise<unknown>;
  timeoutMs?: number;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let finished = false;
    let started = false;
    let acknowledged = false;
    let received = false;
    let dispose: (() => void) | undefined;
    const finish = (error?: Error) => {
      if (finished) return;
      // Successful proof also owns cleanup: wait for the opener's closer.
      // Failures/timeouts must still settle if the opener never returns.
      if (!error && !dispose) return;
      finished = true;
      clearTimeout(timer);
      let cleanupError: Error | undefined;
      try { dispose?.(); }
      catch (cause) { cleanupError = new Error('Session lifecycle stream cleanup failed', { cause }); }
      if (error) reject(error); // Preserve the original close/stream failure.
      else if (cleanupError) reject(cleanupError);
      else resolve();
    };
    const complete = () => {
      if (acknowledged && received) finish();
    };
    const timer = setTimeout(() => finish(new Error(
      `Session close proof timed out (ready=${String(started)}, acknowledged=${String(acknowledged)}, matchingFrame=${String(received)})`,
    )), options.timeoutMs ?? 10_000);
    const handlers: LifecycleHandlers = {
      onReady: () => {
        if (finished || started) return;
        started = true;
        void Promise.resolve().then(() => finished ? undefined : options.close()).then((response) => {
          if (finished) return;
          const session = object(object(response)?.session);
          if (session?.id !== options.sessionId || session.status !== 'closed') {
            finish(new Error('sessions.close did not acknowledge the requested closed session'));
            return;
          }
          acknowledged = true;
          complete();
        }, (error: unknown) => finish(new Error('sessions.close failed', { cause: error })));
      },
      onEvent: ({ name: eventName, payload }) => {
        if (finished || !started || eventName !== options.eventName) return;
        const update = object(payload);
        const session = object(update?.payload);
        if (update?.event !== 'session-closed' || session?.id !== options.sessionId || session.status !== 'closed') return;
        received = true;
        complete();
      },
      onGap: (gap) => finish(new Error(`Session lifecycle stream dropped ${gap.dropped} frame(s) before proof completed`)),
      onEnd: (end) => {
        if (end.kind !== 'closed') finish(new Error('Session lifecycle stream ended before proof completed', { cause: end }));
      },
    };
    // The stream can call handlers before its asynchronous open returns a closer.
    void Promise.resolve().then(() => options.open(handlers)).then((close) => {
      if (finished) {
        // An earlier failure already settled the proof. Cleanup is still attempted,
        // but its failure must not replace that result or leak an unhandled rejection.
        try { close(); } catch { /* Original failure remains authoritative. */ }
      } else {
        dispose = close;
        complete();
      }
    }, (error: unknown) => finish(new Error('Session lifecycle stream could not open', { cause: error })));
  });
}
