/**
 * list-change-updates.ts, how a terminal screen hears that the daemon changed a list it shows.
 *
 * The daemon publishes `LIST_CHANGED` (`{ list, change, id? }`) on the `workspace`
 * domain after the write that changed the list (runtime/list-changes.ts). A screen
 * that shows one of those lists opens the daemon's event stream narrowed to that
 * domain while it is open, and reads the list again on each notice for it.
 *
 * A stream that cannot be opened or ends quietly stops: the screen still reads the
 * list when it opens. Nothing here retries or waits on a clock.
 */
import { openRawServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** The wire event and domain `LIST_CHANGED` travels on. */
export const LIST_CHANGE_WIRE_EVENT = 'workspace';
export const LIST_CHANGE_DOMAIN = 'workspace';

export interface ListChangeSubscriberOptions {
  readonly baseUrl: string | (() => string);
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** The `list` a frame's LIST_CHANGED names (the envelope or its payload), or undefined for any other frame. */
export function listChangeOf(frame: unknown): string | undefined {
  const outer = (typeof frame === 'object' && frame !== null ? frame : {}) as { type?: unknown; list?: unknown; payload?: unknown };
  const inner = (typeof outer.payload === 'object' && outer.payload !== null ? outer.payload : {}) as { type?: unknown; list?: unknown };
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && typeof event.list === 'string') return event.list;
  }
  return undefined;
}

/**
 * Follow the daemon's LIST_CHANGED notices for `lists`; `onChange` is called with the list's
 * name for each. Returns the unsubscribe (which also closes the stream).
 */
export function subscribeDaemonListChanges(
  options: ListChangeSubscriberOptions,
  lists: readonly string[],
  onChange: (list: string) => void,
): () => void {
  let closed = false;
  let close: (() => void) | null = null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') return () => { closed = true; };
  const wanted = new Set(lists);
  void (async () => {
    try {
      const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
      const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
      url.searchParams.set('domains', LIST_CHANGE_DOMAIN);
      const opened = await openRawServerSentEventStream(
        fetchImpl,
        url.toString(),
        {
          onEvent: ({ name: eventName, payload }) => {
            if (closed || eventName !== LIST_CHANGE_WIRE_EVENT) return;
            const list = listChangeOf(payload);
            if (list === undefined || !wanted.has(list)) return;
            try {
              onChange(list);
            } catch (error) {
              logger.debug('[list changes] a subscriber threw', { error: summarizeError(error) });
            }
          },
          onGap: () => { close?.(); close = null; },
          onEnd: () => {},
        },
        options.getAuthToken ? { getAuthToken: options.getAuthToken } : {},
      );
      if (closed) { opened(); return; }
      close = opened;
    } catch (error) {
      logger.debug('[list changes] the daemon event stream could not be opened; the screen reads its list when it opens', { error: summarizeError(error) });
    }
  })();
  return () => {
    closed = true;
    close?.();
    close = null;
  };
}
