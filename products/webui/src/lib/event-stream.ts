/**
 * event-stream.ts, the one owner of this tab's live event connections.
 *
 * The browser gives one origin about six connections on plain HTTP/1.1, shared by every
 * tab of that origin, and a long-lived event stream holds one for as long as it is open.
 * The daemon multiplexes any set of domains onto one stream (`?domains=a,b,c`, one
 * `event: <name>` per frame), so the tab never needs more than two:
 *
 *   - the `app` lane: every app-wide domain (lists, approvals, session lifecycle, fleet),
 *     open while anything subscribes to it;
 *   - the `detail` lane: the high-volume `turn`, `tools` and `compaction` domains, open
 *     only while a session detail or an attached hosted session asks for them, so the
 *     app lane never carries their traffic and never reopens when a detail opens.
 *
 * Hooks subscribe in-process with the domains they need and the frame names they handle;
 * a lane's domain set is the union of its subscribers' and the lane reopens only when that
 * union changes (coalesced to one reopen per tick). Each lane's state (`connecting`,
 * `live`, `paused` while the transport reconnects, `ended`) is the one answer to "are live
 * updates flowing", read by the health strip, the banners and the poll fallbacks.
 */

import { useSyncExternalStore } from 'react';
import type { RuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { createStreamTextAssembler, type StreamTextAssembler } from '@goodvibes-jev/engine/transport-core/event-envelope';
import { client as platformClient, DEFAULT_SSE_RECONNECT } from './goodvibes';
import { getClientLifetime, subscribeClientLifetime, type ClientLifetime } from './client-lifetime';
import { getActiveRoute, subscribeActiveRoute, type ConnectionRoute } from './relay-connection';
import { RELAY_OVERFLOW_EVENT, noteRelayOverflow, readDroppedCount } from './relay-stream-overflow';

export type EventLane = 'app' | 'detail';

export type EventStreamStatus = 'idle' | 'connecting' | 'live' | 'paused' | 'ended';

export interface EventStreamState {
  readonly status: EventStreamStatus;
  /** What is wrong and what happens next while paused or ended; null otherwise. */
  readonly message: string | null;
  /** Ended in a way only a new credential can clear (refused or revoked sign-in). */
  readonly final: boolean;
}

export interface EventSubscription {
  /** Domains the stream must carry for this subscriber. A domain of the detail lane puts the whole subscription there. */
  readonly domains: readonly RuntimeEventDomain[];
  /** Frame names this subscriber handles (a domain name, or a wire name such as `session-update`). */
  readonly events: readonly string[];
  readonly onEvent: (name: string, payload: unknown) => void;
  /** The lane is live. `resumed` is true when this subscriber saw an earlier ready, so frames may have been missed in between. */
  readonly onReady?: (resumed: boolean) => void;
  /** The relay dropped frames on this lane. */
  readonly onGap?: () => void;
}

const DETAIL_DOMAINS: ReadonlySet<string> = new Set<RuntimeEventDomain>(['turn', 'tools', 'compaction']);

const IDLE: EventStreamState = { status: 'idle', message: null, final: false };
const CONNECTING: EventStreamState = { status: 'connecting', message: null, final: false };
const LIVE: EventStreamState = { status: 'live', message: null, final: false };

const MESSAGES: Record<EventLane, { paused: string; ended: string; refused: string; revoked: string }> = {
  app: {
    paused: 'Live updates paused: reconnecting. Views fall back to periodic refresh until the stream returns.',
    ended: 'Live updates stopped: the daemon stopped answering the event stream. They resume when it answers again; views refresh periodically meanwhile.',
    refused: 'Live updates stopped: the daemon refused this sign-in. Sign in again to resume them.',
    revoked: 'Live updates stopped: this sign-in was revoked.',
  },
  detail: {
    paused: 'Live session output paused: reconnecting.',
    ended: 'Live session output stopped: the daemon stopped answering. It resumes when the daemon answers again.',
    refused: 'Live session output stopped: the daemon refused this sign-in. Sign in again to resume it.',
    revoked: 'Live session output stopped: this sign-in was revoked.',
  },
};

interface Subscriber {
  readonly spec: EventSubscription;
  sawReady: boolean;
}

interface LaneRecord {
  readonly name: EventLane;
  readonly subscribers: Set<Subscriber>;
  /** frame name -> subscribers that handle it, rebuilt when the subscriber set changes */
  byEvent: Map<string, Subscriber[]>;
  /** The `?domains=` value of the open connection, or null when closed. */
  openDomains: string | null;
  /** The `?domains=` value of the last open attempt, kept after it ended. */
  attempted: string | null;
  controller: AbortController | null;
  close: (() => void) | null;
  lifetime: ClientLifetime | null;
  route: ConnectionRoute | null;
  state: EventStreamState;
}

function newLane(name: EventLane): LaneRecord {
  return { name, subscribers: new Set(), byEvent: new Map(), openDomains: null, attempted: null, controller: null, close: null, lifetime: null, route: null, state: IDLE };
}

const lanes: Record<EventLane, LaneRecord> = { app: newLane('app'), detail: newLane('detail') };
const stateListeners = new Set<() => void>();
let reconcileQueued = false;
let watchingIdentity = false;

function setState(lane: LaneRecord, state: EventStreamState): void {
  if (lane.state === state) return;
  lane.state = state;
  for (const listener of stateListeners) listener();
}

function failureStatus(error: unknown): number | null {
  const status = (error as { transport?: { status?: unknown }; status?: unknown } | null);
  const value = status?.transport?.status ?? status?.status;
  return typeof value === 'number' ? value : null;
}

function ended(lane: LaneRecord, final: boolean, message?: string): EventStreamState {
  const text = MESSAGES[lane.name];
  return { status: 'ended', final, message: message ?? (final ? text.refused : text.ended) };
}

function laneDomains(lane: LaneRecord): string {
  const domains = new Set<string>();
  for (const { spec } of lane.subscribers) for (const domain of spec.domains) domains.add(domain);
  return [...domains].sort().join(',');
}

function rebuildRoutes(lane: LaneRecord): void {
  const byEvent = new Map<string, Subscriber[]>();
  for (const subscriber of lane.subscribers) {
    for (const name of subscriber.spec.events) {
      const list = byEvent.get(name);
      if (list) list.push(subscriber); else byEvent.set(name, [subscriber]);
    }
  }
  lane.byEvent = byEvent;
}

function shutLane(lane: LaneRecord): void {
  lane.controller?.abort();
  lane.close?.();
  lane.controller = null;
  lane.close = null;
  lane.openDomains = null;
}

/**
 * A `turn` frame with its stream delta made whole: between resync points the
 * daemon sends a delta's new `content` only, and the lane's assembler fills in
 * `accumulated`, so every subscriber reads the turn's text so far.
 */
function completeTurnFrame(streamText: StreamTextAssembler, frame: unknown): unknown {
  if (!frame || typeof frame !== 'object') return frame;
  const envelope = frame as Record<string, unknown>;
  const payload = streamText.complete(envelope.payload);
  return payload === envelope.payload ? frame : { ...envelope, payload };
}

function openLane(lane: LaneRecord, domains: string): void {
  shutLane(lane);
  const controller = new AbortController();
  lane.controller = controller;
  lane.openDomains = domains;
  lane.attempted = domains;
  lane.lifetime = getClientLifetime();
  lane.route = getActiveRoute();
  setState(lane, CONNECTING);
  const current = () => lane.controller === controller && !controller.signal.aborted;
  const text = MESSAGES[lane.name];
  const streamText = createStreamTextAssembler();

  platformClient.streams
    .open(
      `/api/control-plane/events?domains=${domains}`,
      {
        onReady: () => {
          if (!current()) return;
          setState(lane, LIVE);
          for (const subscriber of [...lane.subscribers]) {
            const resumed = subscriber.sawReady;
            subscriber.sawReady = true;
            subscriber.spec.onReady?.(resumed);
          }
        },
        onEvent: (name: string, payload: unknown) => {
          if (!current()) return;
          if (name === RELAY_OVERFLOW_EVENT) {
            noteRelayOverflow(readDroppedCount(payload));
            for (const subscriber of [...lane.subscribers]) subscriber.spec.onGap?.();
            return;
          }
          if (name === 'closed') {
            // The daemon revoked this credential and says what to do; reconnecting with it cannot help.
            const next = (payload as { next?: unknown } | null)?.next;
            shutLane(lane);
            setState(lane, ended(lane, true, typeof next === 'string' && next ? `${text.revoked} ${next}` : undefined));
            return;
          }
          // Every turn frame passes the assembler, handled or not, so a subscriber that arrives mid-turn reads whole text.
          const frame = name === 'turn' ? completeTurnFrame(streamText, payload) : payload;
          const handlers = lane.byEvent.get(name);
          if (!handlers) return;
          for (const subscriber of handlers) subscriber.spec.onEvent(name, frame);
        },
        // The transport's error text can be a raw response body; only fixed copy is shown.
        onError: () => {
          if (current()) setState(lane, { status: 'paused', message: text.paused, final: false });
        },
        onTerminate: ({ final }) => {
          if (!current()) return;
          shutLane(lane);
          setState(lane, ended(lane, final === true));
        },
      },
      { signal: controller.signal, reconnect: DEFAULT_SSE_RECONNECT },
    )
    .then((close) => {
      if (current()) lane.close = close;
      else close();
    })
    .catch((error: unknown) => {
      if (!current()) return;
      // The first connect failed; the transport does not retry that one.
      const status = failureStatus(error);
      shutLane(lane);
      setState(lane, ended(lane, status === 401 || status === 403));
    });
}

function reconcileLane(lane: LaneRecord, force: boolean): void {
  if (lane.subscribers.size === 0) {
    shutLane(lane);
    lane.attempted = null;
    setState(lane, IDLE);
    return;
  }
  const domains = laneDomains(lane);
  const stale = lane.lifetime !== getClientLifetime() || lane.route !== getActiveRoute();
  if (!stale && !force) {
    if (lane.openDomains === domains) return;
    // An ended lane waits for a new credential, a revival or a different domain set; a refused one only for a new credential.
    if (lane.state.status === 'ended' && (lane.state.final || lane.attempted === domains)) return;
  }
  openLane(lane, domains);
}

function reconcileSoon(): void {
  if (reconcileQueued) return;
  reconcileQueued = true;
  queueMicrotask(() => {
    reconcileQueued = false;
    reconcileLane(lanes.app, false);
    reconcileLane(lanes.detail, false);
  });
}

function watchIdentity(): void {
  if (watchingIdentity) return;
  watchingIdentity = true;
  // A new credential or route means the open connections were made for another identity or path.
  subscribeClientLifetime(reconcileSoon);
  subscribeActiveRoute(reconcileSoon);
}

/** Subscribe to live frames. Returns the unsubscribe function. */
export function subscribeEvents(spec: EventSubscription): () => void {
  watchIdentity();
  const lane = spec.domains.some((domain) => DETAIL_DOMAINS.has(domain)) ? lanes.detail : lanes.app;
  const subscriber: Subscriber = { spec, sawReady: false };
  lane.subscribers.add(subscriber);
  rebuildRoutes(lane);
  // A subscriber that joins a lane already live is told at once, as if it had seen the ready.
  if (lane.state.status === 'live' && lane.openDomains !== null && spec.domains.every((domain) => lane.openDomains?.split(',').includes(domain))) {
    subscriber.sawReady = true;
    queueMicrotask(() => { if (lane.subscribers.has(subscriber) && lane.state.status === 'live') spec.onReady?.(false); });
  }
  reconcileSoon();
  return () => {
    if (!lane.subscribers.delete(subscriber)) return;
    rebuildRoutes(lane);
    reconcileSoon();
  };
}

export function subscribeEventStreamState(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => stateListeners.delete(listener);
}

/**
 * Reopen every lane that ended for a reason a new connection can clear. The health probe
 * calls it when the daemon answers again, so live updates come back without a reload.
 */
export function reviveEventStreams(): void {
  for (const lane of [lanes.app, lanes.detail]) {
    if (lane.state.status !== 'ended' || lane.state.final || lane.subscribers.size === 0) continue;
    reconcileLane(lane, true);
  }
}

/** React view of one lane's state. */
export function useEventStreamState(lane: EventLane = 'app'): EventStreamState {
  return useSyncExternalStore(subscribeEventStreamState, () => lanes[lane].state, () => lanes[lane].state);
}
