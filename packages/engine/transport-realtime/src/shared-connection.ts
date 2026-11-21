/**
 * shared-connection.ts, one connection per connector for every domain its
 * feeds listen to.
 *
 * A feed asks its connector for one domain at a time (`DomainEventConnector`).
 * Answering each call with its own stream or socket cost a connection, an auth
 * round trip and a reconnect loop per domain; a browser ran out of its six
 * connections per origin, and over the relay a client listening to nine or
 * more domains had the rest refused. The daemon accepts a list of domains on
 * one connection, so the connectors keep the set here and carry it on one:
 * changed in place when the transport can (a WebSocket subscribe frame),
 * reopened with the new set otherwise (an SSE stream resumes from its last
 * event id). Dispatch stays per domain.
 */

import type { EventLike } from '@goodvibes/engine/transport-core';
import type {
  DomainEventConnectionEnd,
  DomainEventConnector,
  SerializedEventEnvelope,
} from './domain-events.js';

/** What a shared connection reports to the connector that opened it. */
export interface SharedConnectionSink<TDomain extends string, TEvent extends EventLike> {
  /** An envelope arrived for one of the domains the connection carries. */
  deliver(domain: TDomain, envelope: SerializedEventEnvelope<TEvent>): void;
  /** The connection is over and will not come back by itself; every feed on it is told. */
  ended(end: DomainEventConnectionEnd): void;
  /**
   * The daemon will send nothing for these domains on this connection (the
   * credential may not read them, or no such domain exists): only their feeds
   * are ended, with `end`, and every other feed on the connection keeps running.
   */
  endedDomains(domains: readonly string[], end: DomainEventConnectionEnd): void;
}

export interface SharedConnection<TDomain extends string> {
  /**
   * Carry `domains` from now on without a new connection. Returns false (or is
   * absent) when only a new connection can, and the connector then opens one.
   */
  retarget?(domains: readonly TDomain[]): boolean;
  /** Close it; no sink call follows. */
  close(): void;
}

/**
 * Open one connection for `domains`. `signal` aborts when the connector lets
 * this open go (the last listener left, or a newer set replaced it): the
 * opener stops waiting and rejects. A connection that still lands is closed.
 */
export type OpenSharedConnection<TDomain extends string, TEvent extends EventLike> = (
  domains: readonly TDomain[],
  sink: SharedConnectionSink<TDomain, TEvent>,
  signal: AbortSignal,
) => Promise<SharedConnection<TDomain>>;

/**
 * Read the domains a daemon frame (`ready`, `subscribed`, a WebSocket `auth` ok)
 * says it will not serve, and end exactly those feeds: `withheldDomains` (the
 * credential may not read them) with EVENT_ACCESS_DENIED, `unrecognisedDomains`
 * (no such domain) with UNKNOWN_EVENT_DOMAIN. One array read per frame.
 */
export function endUnservedDomains<TDomain extends string, TEvent extends EventLike>(
  frame: unknown,
  sink: SharedConnectionSink<TDomain, TEvent>,
): void {
  if (!frame || typeof frame !== 'object') return;
  const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  const record = frame as { readonly withheldDomains?: unknown; readonly unrecognisedDomains?: unknown };
  const withheld = names(record.withheldDomains);
  const unrecognised = names(record.unrecognisedDomains);
  if (withheld.length > 0) {
    sink.endedDomains(withheld, {
      final: true, code: 'EVENT_ACCESS_DENIED',
      reason: `This credential may not receive the ${withheld.join(', ')} event domain(s), so the daemon sends nothing for them. Sign in with a credential that may, or stop listening to them.`,
    });
  }
  if (unrecognised.length > 0) {
    sink.endedDomains(unrecognised, {
      final: true, code: 'UNKNOWN_EVENT_DOMAIN',
      reason: `The daemon has no runtime event domain named ${unrecognised.join(', ')}, so nothing arrives for it. The daemon may be older than this client.`,
    });
  }
}

interface Subscriber<TEvent extends EventLike> {
  readonly onEnvelope: (envelope: SerializedEventEnvelope<TEvent>) => void;
  readonly onEnded: ((end?: DomainEventConnectionEnd) => void) | undefined;
  /** Set while the feed still waits for a connection that carries its domain. */
  waiting: { resolve(release: () => void): void; reject(error: unknown): void } | undefined;
}

/**
 * Turn an opener of one connection for a set of domains into the per-domain
 * connector the feeds call. Domain-set changes made in one turn of the event
 * loop (a view subscribing to nine domains as it mounts, or nine feeds
 * reopening after the same drop) are applied together, so they cost one
 * connection, not nine.
 */
export function createSharedDomainConnector<TDomain extends string, TEvent extends EventLike>(
  open: OpenSharedConnection<TDomain, TEvent>,
): DomainEventConnector<TDomain, TEvent> {
  const subscribers = new Map<TDomain, Set<Subscriber<TEvent>>>();
  // Bumped whenever the current connection is let go of, so a late sink call
  // or open result from an earlier one changes nothing.
  let generation = 0;
  let connection: SharedConnection<TDomain> | null = null;
  let carried: ReadonlySet<TDomain> = new Set();
  let opening = false;
  // Aborts the open in flight when it is let go of, so an unsubscribe never waits on it.
  let openAbort: AbortController | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  const wanted = (): TDomain[] => [...subscribers.keys()].sort();
  const sameSet = (domains: readonly TDomain[], set: ReadonlySet<TDomain>): boolean => (
    domains.length === set.size && domains.every((domain) => set.has(domain))
  );
  const everySubscriber = (): Subscriber<TEvent>[] => [...subscribers.values()].flatMap((set) => [...set]);

  const release = (domain: TDomain, subscriber: Subscriber<TEvent>) => (): void => {
    const set = subscribers.get(domain);
    if (!set?.delete(subscriber)) return;
    if (set.size === 0) subscribers.delete(domain);
    // The last listener left: close at once rather than on the next turn.
    if (subscribers.size === 0) {
      letGo();
      return;
    }
    scheduleSync();
  };

  /** Hand the connection to every feed that waits for one of the domains it carries. */
  const settleWaiting = (): void => {
    for (const [domain, set] of subscribers) {
      if (!carried.has(domain)) continue;
      for (const subscriber of set) {
        const waiting = subscriber.waiting;
        if (!waiting) continue;
        subscriber.waiting = undefined;
        waiting.resolve(release(domain, subscriber));
      }
    }
  };

  /** Drop the current connection (or the one being opened) without telling the feeds. */
  const letGo = (): void => {
    generation += 1;
    opening = false;
    openAbort?.abort(new Error('The connection being opened is no longer wanted.'));
    openAbort = null;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = null;
    const previous = connection;
    connection = null;
    carried = new Set();
    previous?.close();
  };

  /** The connection is gone: every feed on it, waiting or served, is told and forgotten. */
  const endAll = (end: DomainEventConnectionEnd, failure?: unknown): void => {
    const all = everySubscriber();
    subscribers.clear();
    letGo();
    for (const subscriber of all) {
      const waiting = subscriber.waiting;
      subscriber.waiting = undefined;
      if (waiting && failure !== undefined) {
        waiting.reject(failure);
        continue;
      }
      subscriber.onEnded?.(end);
      waiting?.resolve(() => {});
    }
  };

  const sinkFor = (owner: number): SharedConnectionSink<TDomain, TEvent> => ({
    deliver(domain, envelope) {
      if (owner !== generation) return;
      const set = subscribers.get(domain);
      if (!set) return;
      for (const subscriber of [...set]) subscriber.onEnvelope(envelope);
    },
    ended(end) {
      if (owner !== generation) return;
      endAll(end);
    },
    endedDomains(domains, end) {
      if (owner !== generation) return;
      let changed = false;
      for (const name of domains) {
        const domain = name as TDomain;
        const set = subscribers.get(domain);
        if (!set) continue;
        subscribers.delete(domain);
        changed = true;
        for (const subscriber of set) {
          const waiting = subscriber.waiting;
          subscriber.waiting = undefined;
          subscriber.onEnded?.(end);
          waiting?.resolve(() => {});
        }
      }
      // The connection stops carrying them (a subscription change, or a reopen without them).
      if (!changed) return;
      if (subscribers.size === 0) letGo();
      else scheduleSync();
    },
  });

  const openFor = (domains: readonly TDomain[]): void => {
    const owner = ++generation;
    opening = true;
    const abort = new AbortController();
    openAbort = abort;
    let pending: Promise<SharedConnection<TDomain>>;
    try {
      pending = Promise.resolve(open(domains, sinkFor(owner), abort.signal));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then((opened) => {
      if (owner !== generation) {
        opened.close();
        return;
      }
      if (openAbort === abort) openAbort = null;
      opening = false;
      connection = opened;
      carried = new Set(domains);
      settleWaiting();
      if (!sameSet(wanted(), carried)) scheduleSync();
    }, (error: unknown) => {
      if (owner !== generation) return;
      if (openAbort === abort) openAbort = null;
      // Feeds still waiting get the failure and retry on their own schedule;
      // feeds that were served by the connection this one replaces are told it ended.
      endAll({ final: (error as { recoverable?: unknown } | null)?.recoverable === false }, error);
    });
  };

  const sync = (): void => {
    syncTimer = null;
    if (opening) return; // re-checked when the open settles
    const domains = wanted();
    if (domains.length === 0) {
      letGo();
      return;
    }
    if (connection) {
      if (sameSet(domains, carried)) {
        settleWaiting();
        return;
      }
      if (connection.retarget?.(domains) === true) {
        carried = new Set(domains);
        settleWaiting();
        return;
      }
      letGo();
    }
    openFor(domains);
  };

  function scheduleSync(): void {
    if (syncTimer) return;
    syncTimer = setTimeout(sync, 0);
  }

  return (domain, onEnvelope, onEnded, signal) => new Promise<() => void>((resolve, reject) => {
    const left = (): DOMException => new DOMException('The listener left before its connection opened.', 'AbortError');
    if (signal?.aborted) { reject(left()); return; }
    const subscriber: Subscriber<TEvent> = { onEnvelope, onEnded, waiting: undefined };
    const set = subscribers.get(domain) ?? new Set<Subscriber<TEvent>>();
    set.add(subscriber);
    subscribers.set(domain, set);
    if (connection && carried.has(domain)) {
      resolve(release(domain, subscriber));
      return;
    }
    const abandon = (): void => {
      const waiting = subscriber.waiting;
      if (!waiting) return;
      subscriber.waiting = undefined;
      const current = subscribers.get(domain);
      if (current?.delete(subscriber) && current.size === 0) subscribers.delete(domain);
      // Nobody else wants a connection: the open in flight is aborted at once.
      if (subscribers.size === 0) letGo();
      else scheduleSync();
      waiting.reject(left());
    };
    subscriber.waiting = {
      resolve: (value) => { signal?.removeEventListener('abort', abandon); resolve(value); },
      reject: (error) => { signal?.removeEventListener('abort', abandon); reject(error); },
    };
    signal?.addEventListener('abort', abandon, { once: true });
    scheduleSync();
  });
}
