import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client as platformClient, GOODVIBES_BASE_URL, WEBUI_VERSION, getCurrentAuth } from '../lib/goodvibes';
import {
  evaluateClientCompatibility,
  getObservedClientCompatibilityFloor,
  subscribeObservedClientCompatibilityFloor,
  type ClientCompatibilityVerdict,
} from '../lib/client-compatibility';
import {
  type DaemonHealth,
  type ConnectionState,
  type AuthState,
  type WorkingState,
  type SseState,
  DAEMON_HEALTH_DEFAULTS,
  taskCountsFromList,
  modelNameFromCurrent,
  clampLatency,
  deriveAuthState,
  daemonCompatibilityFromStatus,
} from '../lib/daemon-health';
import { getActiveRoute, probeConnection, setActiveRoute, subscribeActiveRoute } from '../lib/relay-connection';
import { reviveEventStreams, useEventStreamState, type EventStreamStatus } from '../lib/event-stream';
import { queryKeys } from '../lib/queries';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to probe the daemon while the event stream cannot vouch for it (ms) */
const HEALTH_PROBE_INTERVAL_MS = 15_000;

/** A direct probe that has not answered by then counts as a miss (a LAN address off-network can hang). */
const DIRECT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Ping endpoint, lightweight, always-available. The daemon answers it before
 * authentication (200 with `authenticated: false` for a caller it does not
 * know), so a liveness probe never shows as a failed request in the console.
 * We treat this probe as PURE LIVENESS: ok = status < 500.
 */
const PING_PATH = '/api/control-plane/auth';

const SSE_FROM_STREAM: Record<EventStreamStatus, SseState> = {
  idle: 'disabled',
  connecting: 'connecting',
  live: 'active',
  paused: 'error',
  ended: 'error',
};

// ---------------------------------------------------------------------------
// Internal latency probe
// ---------------------------------------------------------------------------

async function probeLatency(): Promise<{ latencyMs: number | null; ok: boolean }> {
  const start = performance.now();
  try {
    const url = `${GOODVIBES_BASE_URL.replace(/\/+$/, '')}${PING_PATH}`;
    const res = await fetch(url, { credentials: 'include', method: 'GET', signal: AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS) });
    const elapsed = clampLatency(Math.round(performance.now() - start));
    return { latencyMs: elapsed, ok: res.status < 500 };
  } catch {
    return { latencyMs: null, ok: false };
  }
}

/** Read a numeric HTTP status off a thrown error, if the caller attached one. */
function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/** Whether a granted scope covers `required`, by the daemon's rule (`*`, exact, or `prefix:*`). */
function scopeCovers(granted: string, required: string): boolean {
  return granted === '*' || granted === required || (granted.endsWith(':*') && required.startsWith(granted.slice(0, -1)));
}

/**
 * The WORKING axis from the sign-in's own grant, as auth.current reports it: the
 * conversation reads need `read:transcripts`, and a person's own web chats are
 * read under the sessions scopes she makes them with (`read:sessions` or
 * `write:sessions`). A daemon that reports no scope list is not judged.
 */
const CONVERSATION_READ_SCOPES = ['read:transcripts', 'read:sessions', 'write:sessions'] as const;
function workingFromGrant(snapshot: unknown): WorkingState {
  const scopes: unknown = (snapshot as { scopes?: unknown } | null)?.scopes;
  if (!Array.isArray(scopes)) return 'working';
  return (scopes as readonly unknown[]).some((scope) => typeof scope === 'string'
    && CONVERSATION_READ_SCOPES.some((required) => scopeCovers(scope, required)))
    ? 'working'
    : 'blocked';
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns live daemon health: connection state, latency, SSE stream state,
 * active turn count, queued task count, and current model name.
 *
 * - Liveness is the app's shared event stream (lib/event-stream.ts): while it is live
 *   on the direct route nothing is polled. While it is down, not yet open (signed out)
 *   or on the relay (to notice the direct path coming back), a lightweight probe runs
 *   every 15 s, together with the relay when a relay pairing is stored.
 * - Signed in and "can read" come from the app's own auth query (auth.current reports
 *   the grant); this hook adds no request for them.
 * - Tasks and the current model refresh from stream frames, and poll only while the
 *   stream is down. No interval runs while the tab is hidden; returning refreshes.
 */
export function useDaemonHealth(): DaemonHealth {
  // -- Route state ------------------------------------------------------------
  // Reactive view of the module-level active-route store (lib/relay-connection.ts),
  // the SAME store routedFetch reads for every actual request, so this never drifts
  // from what the platform client is genuinely dispatching over. The store only ever holds
  // 'direct' or 'relay' (never a 'down'/null verdict); the connection probe below is
  // what flips it, and the health.route field returned at the bottom maps it to null
  // whenever the daemon is unreachable by either path.
  const storeRoute = useSyncExternalStore(subscribeActiveRoute, getActiveRoute, getActiveRoute);

  // -- Client-build compatibility floor --------------------------------------
  // Reactive view of the module-level observed-floor store (lib/client-compatibility.ts),
  // updated by every requestJson/requestStream response (goodvibes.ts), not a
  // dedicated probe of its own, since the floor rides on responses this hook (and the
  // rest of the app) is already making. Null until at least one response has been
  // observed at all.
  const observedFloor = useSyncExternalStore(
    subscribeObservedClientCompatibilityFloor,
    getObservedClientCompatibilityFloor,
    getObservedClientCompatibilityFloor,
  );
  const compatibility: ClientCompatibilityVerdict | null = observedFloor === undefined
    ? null
    : evaluateClientCompatibility({ clientVersion: WEBUI_VERSION, floor: observedFloor });

  // -- Live updates -----------------------------------------------------------
  // The app lane's own state: 'connecting' until the daemon's `ready` frame, so the
  // strip never shows "Live" on a stream that has not delivered.
  const stream = useEventStreamState('app');
  const sseState: SseState = SSE_FROM_STREAM[stream.status];
  const streamLive = stream.status === 'live';

  // -- Latency + connection probe -------------------------------------------
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('down');

  // With a relay pairing stored, the relay is tried together with the direct probe
  // (lib/relay-connection.ts probeConnection), so a device away from home connects as
  // soon as the relay answers. TanStack pauses the interval in a hidden tab and
  // refetches on return.
  const probeWanted = !streamLive || storeRoute === 'relay';
  const healthQuery = useQuery({
    queryKey: ['daemon-health', 'probe'] as const,
    queryFn: () => probeConnection(probeLatency, () => setConnectionState('connected')),
    networkMode: 'always',
    refetchInterval: probeWanted ? HEALTH_PROBE_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  const refetchHealth = healthQuery.refetch;

  // A stream that drops is checked at once rather than at the next interval, so a dead
  // daemon or a lost direct path shows (and the relay takes over) without the wait.
  const wasLive = useRef(streamLive);
  useEffect(() => {
    if (wasLive.current && !streamLive && stream.status !== 'idle') void refetchHealth();
    wasLive.current = streamLive;
  }, [streamLive, stream.status, refetchHealth]);

  // The browser going offline or online is a reason to probe now, never an answer: it
  // says whether there is a network beyond this machine, and a daemon on loopback (or
  // the same LAN) answers without one. Only the probe decides reachability.
  useEffect(() => {
    const probeNow = () => { void refetchHealth(); };
    window.addEventListener('offline', probeNow);
    window.addEventListener('online', probeNow);
    return () => {
      window.removeEventListener('offline', probeNow);
      window.removeEventListener('online', probeNow);
    };
  }, [refetchHealth]);

  // Derive connection state from the probe. A route that answered: connected over it.
  // No route: a connection that was up shows 'reconnecting' for one probe, then 'down'.
  useEffect(() => {
    if (healthQuery.isSuccess) {
      const { route, latencyMs: probed } = healthQuery.data;
      setLatencyMs(probed);
      if (route) {
        setConnectionState('connected');
        setActiveRoute(route);
        // The daemon answers again: live updates that gave up come back without a reload.
        reviveEventStreams();
        return;
      }
    } else if (healthQuery.isError) {
      setLatencyMs(null);
    } else {
      return; // still pending, nothing to evaluate yet
    }
    setConnectionState((previous) => (previous === 'connected' ? 'reconnecting' : 'down'));
  }, [healthQuery.isSuccess, healthQuery.isError, healthQuery.data, healthQuery.dataUpdatedAt]);

  // A live stream is itself proof the daemon answers over the current route.
  useEffect(() => {
    if (streamLive) setConnectionState('connected');
  }, [streamLive]);

  // -- Tasks ----------------------------------------------------------------
  // `tasks` frames revalidate this key; it polls only while the stream is down.
  const tasksQuery = useQuery({
    queryKey: queryKeys.tasks,
    queryFn: () => platformClient.operator.tasks.list(),
    refetchInterval: streamLive ? false : HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: false,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // -- Signed-in and working axes ---------------------------------------------
  // Read from the app's own auth query (same key and options as App.tsx), never fetched
  // here: auth.current answers whether this credential is signed in and what it may read.
  const auth = useQuery({
    queryKey: queryKeys.auth,
    queryFn: getCurrentAuth,
    retry: false,
    enabled: false,
  });
  const authStatus = auth.isError ? statusOf(auth.error) : null;
  const signedIn: AuthState = auth.isSuccess
    ? 'signed-in'
    : auth.isError ? deriveAuthState({ ok: false, status: authStatus }) : 'unknown';
  const working: WorkingState = auth.isSuccess
    ? workingFromGrant(auth.data)
    : authStatus === 401 ? 'blocked' : 'unknown';

  // -- Daemon build against this UI's floor -----------------------------------
  // One /status read per connection, shared with Settings' status view through its
  // query key, so a daemon too old for this UI is named ("update the daemon") instead
  // of its verbs failing one at a time.
  const daemonStatus = useQuery({
    queryKey: queryKeys.status,
    queryFn: () => platformClient.operator.control.status(),
    enabled: connectionState === 'connected' && signedIn === 'signed-in',
    staleTime: 5 * 60_000,
    retry: false,
  });
  const daemonCompatibility = daemonStatus.isSuccess ? daemonCompatibilityFromStatus(daemonStatus.data) : null;

  // -- Current model --------------------------------------------------------
  // MODEL_CHANGED rides the `providers` domain, which revalidates this key.
  const modelQuery = useQuery({
    queryKey: ['daemon-health', 'model'] as const,
    queryFn: () => platformClient.operator.models.current.get(),
    refetchInterval: streamLive ? false : 60_000,
    refetchIntervalInBackground: false,
    retry: 0,
    staleTime: 30_000,
  });

  // -- Derive counts --------------------------------------------------------
  const { activeTurns, queuedTasks } = tasksQuery.isSuccess
    ? taskCountsFromList(tasksQuery.data)
    : { activeTurns: DAEMON_HEALTH_DEFAULTS.activeTurns, queuedTasks: DAEMON_HEALTH_DEFAULTS.queuedTasks };

  const modelName = modelQuery.isSuccess ? modelNameFromCurrent(modelQuery.data) : null;

  return {
    connection: connectionState,
    // Down means neither path answered, a stale 'relay' from a prior success has no
    // meaning once nothing is reachable, so this reports null rather than a route that
    // is not actually carrying anything right now.
    route: connectionState === 'down' ? null : storeRoute,
    signedIn,
    working,
    latencyMs,
    sse: sseState,
    activeTurns,
    queuedTasks,
    modelName,
    compatibility,
    daemonCompatibility,
  };
}
