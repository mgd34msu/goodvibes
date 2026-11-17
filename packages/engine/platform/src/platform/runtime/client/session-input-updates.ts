/**
 * session-input-updates.ts, how a surface hears that a session's inputs changed.
 *
 * The daemon publishes every input lifecycle move (queued, delivered,
 * completed, failed, ...) on the `session-update` wire event, tagged with the
 * `session` domain. A surface that hosts sessions reads that stream and reads a
 * session's inputs when one of them moved, instead of listing every hosted
 * session every two seconds (session-dispatch.ts keeps a slow reconcile read
 * for whatever the stream missed).
 *
 * A stream that cannot be opened, or that ends, is reported through `onEnd`,
 * never a throw: the dispatcher then goes back to its short interval.
 */
import { openRawServerSentEventStream } from '../transports/sse-stream.js';
import { buildUrl } from '../transports/transport-paths.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { SessionInputChangeHandlers } from './session-dispatch.js';

/** The wire event the session broker publishes input moves on. */
export const SESSION_UPDATE_WIRE_EVENT = 'session-update';
/** The event domain `session-update` is tagged with. */
export const SESSION_UPDATE_DOMAIN = 'session';

export interface SessionInputChangeSubscriberOptions {
  readonly baseUrl: string | (() => string);
  readonly getAuthToken?: (() => string | null | Promise<string | null>) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** The session an input-lifecycle `session-update` frame is about, or undefined for any other frame. */
export function inputChangeSessionId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const event = (payload as Record<string, unknown>)['event'];
  if (typeof event !== 'string' || !(event.startsWith('session-input-') || event.startsWith('session-follow-up-'))) return undefined;
  const inner = (payload as Record<string, unknown>)['payload'];
  const sessionId = typeof inner === 'object' && inner !== null ? (inner as Record<string, unknown>)['sessionId'] : undefined;
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Build a `subscribeInputChanges` for a session-inputs wire client: it opens the
 * daemon's event stream narrowed to the session domain and calls `onChange`
 * with the session id of every input move. Returns the unsubscribe.
 */
export function createSessionInputChangeSubscriber(
  options: SessionInputChangeSubscriberOptions,
): (onChange: (sessionId: string) => void, handlers?: SessionInputChangeHandlers) => () => void {
  return (onChange, handlers) => {
    let closed = false;
    let close: (() => void) | null = null;
    let ended = false;
    const end = (): void => {
      if (ended) return;
      ended = true;
      if (!closed) handlers?.onEnd?.();
    };
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      queueMicrotask(end);
      return () => { closed = true; };
    }
    void (async () => {
      try {
        const baseUrl = typeof options.baseUrl === 'function' ? options.baseUrl() : options.baseUrl;
        const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
        url.searchParams.set('domains', SESSION_UPDATE_DOMAIN);
        const opened = await openRawServerSentEventStream(
          fetchImpl,
          url.toString(),
          {
            onEvent: (eventName, payload) => {
              if (closed || eventName !== SESSION_UPDATE_WIRE_EVENT) return;
              const sessionId = inputChangeSessionId(payload);
              if (sessionId === undefined) return;
              try {
                onChange(sessionId);
              } catch (error) {
                logger.debug('[session dispatch] an input-change subscriber threw', { error: summarizeError(error) });
              }
            },
            onTerminate: end,
            onClose: end,
          },
          options.getAuthToken ? { getAuthToken: options.getAuthToken } : {},
        );
        if (closed) { opened(); return; }
        close = opened;
        handlers?.onOpen?.();
      } catch (error) {
        logger.debug('[session dispatch] the session-update stream could not be opened; inputs are read on the short interval', { error: summarizeError(error) });
        end();
      }
    })();
    return () => {
      closed = true;
      close?.();
      close = null;
    };
  };
}
