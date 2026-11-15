/**
 * event-source-connector.ts, the SSE runtime-event connector.
 *
 * Lifted out of runtime-events.ts so the two things a fresh-stream-per-turn
 * client needs have somewhere to live and something to be tested against:
 *
 *  RESUMPTION. The stream underneath already remembers its position across its
 *  OWN reconnects, but a caller that closes the stream and opens a new one for
 *  the next turn used to start from nothing, and a gateway replays "recent
 *  traffic" to a client claiming no position, which hands the new stream the
 *  tail of the previous turn, terminal frames included. The connector now keeps
 *  the last event id it saw and presents it as `Last-Event-ID` on every
 *  (re)establishment, so the gateway replays only what this connector has not
 *  already been given. The same position recovers frames the daemon (`gap`) or
 *  the relay (`relay-overflow`) dropped for a slow client: the stream is
 *  reopened from it and the gateway replays them.
 *
 *  ONE STREAM. Every domain the connector's feeds listen to is carried on one
 *  stream (`domains=a,b,c`, shared-connection.ts); a changed set reopens it
 *  from the current position.
 *
 *  TURN IDENTITY. Second line, for the replays we cannot prevent, a gateway
 *  that cannot resolve the position, a server that predates the resume, a frame
 *  that genuinely arrives twice. Turn frames carry a `turnId`; the gate drops
 *  the ones addressed to a turn this connection is not rendering, so a replayed
 *  `TURN_COMPLETED` can never finish a different turn. On by default,
 *  `turnScope: 'off'` opts out, `{ turnId }` pins the connection to one turn.
 */

import type { RuntimeEventDomain, RuntimeEventRecord } from '@goodvibes-jev/engine/contracts';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import {
  buildUrl,
  normalizeAuthToken,
  openRawServerSentEventStream as openServerSentEventStream,
} from '@goodvibes-jev/engine/transport-http';
import {
  type FetchLike,
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
} from '@goodvibes-jev/engine/transport-core';
import type { DomainEventConnector } from './domain-events.js';
import { readEventEnvelope } from './envelope.js';
import { createSharedDomainConnector } from './shared-connection.js';
import {
  createTurnLifecycleGate,
  readTurnLifecycleFrame,
  type TurnLifecycleGate,
} from './turn-lifecycle-gate.js';
import type {
  AuthTokenSource,
  RuntimeEventConnectorOptions,
  RuntimeEventTurnScope,
} from './connector-options.js';

/** The turn gate a connector applies to its frames; shared by the SSE and WebSocket connectors. */
export function buildGate(scope: RuntimeEventTurnScope | undefined): TurnLifecycleGate | null {
  if (scope === 'off') return null;
  if (typeof scope === 'object' && scope !== null) return createTurnLifecycleGate({ turnId: scope.turnId });
  return createTurnLifecycleGate();
}

/** The stream URL for one domain, or for several carried on the same stream. */
export function buildEventSourceUrl(
  baseUrl: string,
  domains: RuntimeEventDomain | readonly RuntimeEventDomain[],
): string {
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', typeof domains === 'string' ? domains : domains.join(','));
  return url.toString();
}

/** The notices that say frames were dropped between the daemon and this client, and how to word each. */
const LOST_FRAME_NOTICES: ReadonlyMap<string, (count: string) => string> = new Map([
  // The daemon's own stream fell behind this consumer.
  ['gap', (count: string) => `The daemon dropped ${count} event(s)`],
  // The relay's send buffer for this client overflowed.
  ['relay-overflow', (count: string) => `The relay dropped ${count} event chunk(s)`],
]);

export function createEventSourceConnector<TEvent extends RuntimeEventRecord = RuntimeEventRecord>(
  baseUrl: string,
  token: AuthTokenSource,
  fetchImpl: FetchLike,
  options: RuntimeEventConnectorOptions = {},
): DomainEventConnector<RuntimeEventDomain, TEvent> {
  const { observer } = options;
  const handleError = options.onError;
  const getAuthToken = normalizeAuthToken(token ?? undefined);
  // The last event id this connector was handed, held for the life of the
  // connector rather than of one stream: a NEW stream (for the next turn, or
  // for a changed set of domains) resumes where the closed one stopped. The
  // daemon numbers its events in one sequence across every domain, so one
  // position serves whichever domains the next stream carries.
  let position: string | null = null;
  // One gate per connector: turn and tool frames are judged against the same binding.
  const gate = buildGate(options.turnScope);

  const report = (error: Error): void => {
    invokeTransportObserver(() => observer?.onError?.(error), observer?.onObserverError);
    handleError?.(error);
  };

  /**
   * The gateway's `ready` frame states what became of a presented
   * `Last-Event-ID`. An `unresolved` position replays nothing, so the frames
   * between it and now are lost to this connection: say so, forget the
   * position (the next connect starts from the catch-up window) and unbind the
   * gate, whose binding may name a turn this connection never saw start.
   */
  const handleResume = (ready: unknown): void => {
    const resume = (ready as { resume?: { resume?: unknown } } | null)?.resume?.resume;
    if (resume !== 'unresolved') return;
    position = null;
    gate?.reset();
    report(new GoodVibesError('The gateway could not resume the event stream from its last position, so events since then were not replayed.', {
      category: 'protocol',
      source: 'transport',
      recoverable: true,
      hint: 'The daemon restarted or the position aged out of its recent-event window. Re-read current state instead of waiting for events that may already have happened.',
    }));
  };

  // Every domain the connector's feeds listen to rides one stream; a changed
  // set of domains reopens it from the current position.
  return createSharedDomainConnector<RuntimeEventDomain, TEvent>(async (domains, sink) => {
    const url = buildEventSourceUrl(baseUrl, domains);
    const carried = new Set<string>(domains);
    let closed = false;
    // Numbers the raw streams this connection opens; frames from a replaced one are ignored.
    let streamNumber = 0;
    let closeStream: (() => void) | null = null;
    // The position the last recovery resumed from. A second loss before any
    // frame arrived past it means the replay itself overflowed: not chased again.
    let recoveredFrom: string | null = null;

    const onLostFrames = (notice: string, payload: unknown): void => {
      const from = position;
      if (from !== null && from !== recoveredFrom) {
        // Reopen from the last frame this client holds: the daemon replays the
        // dropped frames from its recent-event window, so nothing is lost.
        recoveredFrom = from;
        reopen();
        return;
      }
      // The frames cannot be had back. Forget the position, which would resume
      // past them, and unbind the gate, whose binding may name a turn whose
      // start or end was among them.
      position = null;
      gate?.reset();
      const dropped = (payload as { dropped?: unknown } | null)?.dropped;
      const lead = LOST_FRAME_NOTICES.get(notice)!(typeof dropped === 'number' ? String(dropped) : 'some');
      report(new GoodVibesError(
        `${lead} because this client was too slow; events, possibly including a turn's end, were lost.`,
        { category: 'protocol', source: 'transport', recoverable: true, hint: 'Re-read current state instead of waiting for events that may already have happened.' },
      ));
    };

    const openStream = async (): Promise<void> => {
      const number = ++streamNumber;
      const live = (): boolean => number === streamNumber && !closed;
      // Inject W3C traceparent if OTel is active (async probe for SSE cold-start).
      const sseHeaders: Record<string, string> = {};
      await injectTraceparentAsync(sseHeaders);
      if (!live()) return;
      invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'sse' }), observer?.onObserverError);
      const close = await openServerSentEventStream(fetchImpl, url, {
        onEventId: (id) => { if (live()) position = id; },
        onReady: (ready) => { if (live()) handleResume(ready); },
        onEvent: (eventName, payload) => {
          if (!live()) return;
          if (LOST_FRAME_NOTICES.has(eventName)) {
            onLostFrames(eventName, payload);
            return;
          }
          if (!carried.has(eventName)) return;
          if (!payload || typeof payload !== 'object') return;
          // The shared envelope reader (envelope.ts). Unlike the WS path this must NOT
          // throw (the SSE flush loop has no try/catch around onEvent), so a frame that
          // is not an envelope is reported and dropped.
          const envelope = readEventEnvelope<TEvent>(payload);
          if (!envelope) {
            report(new GoodVibesError('An SSE runtime event frame is not an event envelope: it needs a type and a payload.', {
              category: 'protocol',
              source: 'transport',
              recoverable: true,
            }));
            return;
          }
          if (gate) {
            const frame = readTurnLifecycleFrame(envelope.sessionId, envelope.payload);
            if (frame && !gate.accepts(frame)) return;
          }
          sink.deliver(eventName as RuntimeEventDomain, envelope);
          // Notify observer of inbound event.
          invokeTransportObserver(() => {
            observer?.onTransportActivity?.({ direction: 'recv', url, kind: 'sse' });
          }, observer?.onObserverError);
          if (envelope.payload) {
            invokeTransportObserver(() => {
              (observer as { onEvent?: (e: unknown) => void } | undefined)?.onEvent?.(envelope.payload);
            }, observer?.onObserverError);
          }
        },
        onError: (err) => {
          if (live()) report(transportErrorFromUnknown(err, 'SSE runtime event stream error'));
        },
        // The stream ended and is not coming back by itself (closed with
        // reconnect off, or a failure no reconnect clears). Tell the feeds,
        // which open a new one unless the daemon's answer was final (a
        // refused credential).
        onClose: () => { if (live()) sink.ended({ final: false }); },
        onTerminate: ({ final }) => { if (live()) sink.ended({ final: final === true }); },
      }, {
        // On unless the caller turns it off, with no attempt limit by default:
        // a daemon restart or a sleep must not end the feed.
        reconnect: { ...options.reconnect, enabled: options.reconnect?.enabled ?? true },
        getAuthToken,
        headers: Object.keys(sseHeaders).length > 0 ? sseHeaders : undefined,
        lastEventId: position,
      });
      if (!live()) {
        close();
        return;
      }
      closeStream = close;
    };

    /** Replace the raw stream with one that resumes from the current position. */
    const reopen = (): void => {
      const previous = closeStream;
      closeStream = null;
      // Starting the new stream first numbers it, so whatever the old one still
      // parses from its last read is ignored.
      const opened = openStream();
      previous?.();
      opened.catch((error: unknown) => {
        if (closed) return;
        const failure = transportErrorFromUnknown(error, 'SSE runtime event connection failed');
        report(failure);
        sink.ended({ final: (failure as { recoverable?: unknown }).recoverable === false });
      });
    };

    try {
      await openStream();
    } catch (error) {
      const connectionError = transportErrorFromUnknown(error, 'SSE runtime event connection failed');
      report(connectionError);
      throw connectionError;
    }
    return {
      close: () => {
        closed = true;
        streamNumber += 1;
        const close = closeStream;
        closeStream = null;
        close?.();
      },
    };
  });
}
