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

export interface ContextWindowsFollowOptions {
  /** The daemon's address and credential for its event stream, or why there is none. */
  readonly daemonEndpoint: () => Promise<{ readonly baseUrl: string; readonly token: string | null } | { readonly unavailable: string }>;
  /** Told each time this program's daemon connection comes back; returns the stop. */
  readonly onDaemonBack: (listener: () => void) => () => void;
  /** This program's provider registry. */
  readonly registry: { contextWindowsChanged(): void };
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
  // The daemon back (started again, or reached for the first time): what changed meanwhile is read, and the stream opened again.
  const stopBack = options.onDaemonBack(() => {
    if (stopped) return;
    options.registry.contextWindowsChanged();
    open();
  });
  return () => {
    stopped = true;
    stopBack();
    stopStream?.();
    stopStream = null;
  };
}
