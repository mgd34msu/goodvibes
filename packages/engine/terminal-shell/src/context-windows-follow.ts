/**
 * context-windows-follow.ts: a terminal program follows the daemon's context
 * window sizes.
 *
 * The sizes are the daemon's file (capabilities/builtin/context-windows.ts);
 * this program's provider registry reads it and never writes it. When the
 * daemon sets or clears a size it announces LIST_CHANGED `context-windows`;
 * on that notice, and each time the daemon's event stream opens again after it
 * was lost (a notice may have been missed), the registry reads the file again,
 * so this program's next turn works from the new size with no restart. A
 * stream that cannot be opened is opened again when this program's daemon
 * connection comes back. Nothing here waits on a clock.
 */
import { subscribeDaemonEventFrames } from '@goodvibes/engine/platform/platform/runtime/client';
import type { LearnedContextWindow } from '@goodvibes/engine/platform/platform/providers';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

export interface ContextWindowsFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** This program's provider registry. */
  readonly registry: {
    contextWindowsChanged(): void;
    /** Told each limit or floor this program's own turns learn from a provider (the daemon owns the file). */
    onContextWindowLearned?: ((listener: (learned: LearnedContextWindow) => void) => () => void) | undefined;
  };
  /**
   * Reports what this program's turn learned to the daemon (`context.windows.learned.post`), so the one file holds it and
   * every program has it. A report that does not arrive (no daemon) leaves it in this program's memory, as before.
   */
  readonly report?: ((learned: LearnedContextWindow) => Promise<unknown>) | undefined;
}

/** Follow the daemon's context window sizes for this program's registry; returns the stop. */
export function followDaemonContextWindows(options: ContextWindowsFollowOptions): () => void {
  let stopped = false;
  let stopStream: (() => void) | null = null;
  const open = (): void => {
    stopStream?.();
    stopStream = null;
    void options.daemonEndpoint().then((endpoint) => {
      if (stopped || 'unavailable' in endpoint) return;
      stopStream = subscribeDaemonEventFrames(
        { baseUrl: endpoint.baseUrl, getAuthToken: () => endpoint.token },
        { domains: ['workspace'], events: [], lists: ['context-windows'] },
        () => { options.registry.contextWindowsChanged(); },
      );
    }, () => { /* No daemon yet: opened when this program's daemon connection is back. */ });
  };
  open();
  // What this program's turn learned goes to the daemon, which keeps it in the one file and announces it. A report
  // that does not arrive (no daemon yet, a daemon restarting) is kept and sent again when the daemon is back, so a
  // limit learned while the daemon could not be reached still reaches it; the log says each time one did not arrive.
  const report = options.report;
  const unsent = new Map<string, LearnedContextWindow>();
  const send = (learned: LearnedContextWindow): void => {
    if (!report || stopped) return;
    const key = `${learned.registryKey}\u0000${learned.kind}`;
    unsent.set(key, learned);
    void report(learned).then(() => {
      if (unsent.get(key) === learned) unsent.delete(key);
    }, (error: unknown) => {
      logger.info('A context window limit this program learned did not reach the daemon; it is sent again when the daemon is back', { model: learned.registryKey, error: summarizeError(error) });
    });
  };
  // The daemon back (started again, or reached for the first time): what changed meanwhile is read, the stream opened
  // again, and what did not arrive is sent again.
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    options.registry.contextWindowsChanged();
    open();
    for (const learned of [...unsent.values()]) send(learned);
  });
  const stopLearned = report && options.registry.onContextWindowLearned
    ? options.registry.onContextWindowLearned((learned) => { send(learned); })
    : () => {};
  return () => {
    stopped = true;
    stopLearned();
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
