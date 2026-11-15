import { useEffect, useState, useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { client as platformClient, DEFAULT_SSE_RECONNECT, GOODVIBES_BASE_URL, WEBUI_VERSION, getCurrentAuth } from '../lib/goodvibes';
import { getClientLifetime, isClientLifetimeCurrent, subscribeClientLifetime } from '../lib/client-lifetime';
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
  deriveWorkingState,
} from '../lib/daemon-health';
import { getActiveRoute, probeConnection, setActiveRoute, subscribeActiveRoute } from '../lib/relay-connection';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How often to re-probe the daemon (ms) */
const HEALTH_PROBE_INTERVAL_MS = 15_000;

/** A direct probe that has not answered by then counts as a miss (a LAN address off-network can hang). */
const DIRECT_PROBE_TIMEOUT_MS = 5_000;

/**
 * Ping endpoint, lightweight, always-available.
 * We treat this probe as PURE LIVENESS: ok = status < 500 (includes 401 when
 * the daemon is up but unauthenticated).
 */
const PING_PATH = '/api/local-auth';

/** The turn domain is the lightest stream; the daemon answers it with a `ready` frame. */
const HEALTH_EVENTS_PATH = '/api/control-plane/events?domains=turn';

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

/** Run an authed call and reduce it to an {ok,status} probe result (never throws). */
async function probeCall(fn: () => Promise<unknown>): Promise<{ ok: boolean; status: number | null }> {
  try {
    await fn();
    return { ok: true, status: 200 };
  } catch (error) {
    return { ok: false, status: statusOf(error) };
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Returns live daemon health: connection state, latency, SSE stream state,
 * active turn count, queued task count, and current model name.
 *
 * - Probes the daemon every 15 s via a lightweight fetch (no throw on failure),
 *   together with the relay when a relay pairing is stored.
 * - Reuses the existing queryClient pattern for tasks + model (separate queries).
 * - Opens the turn-domain event stream for SSE state tracking.
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
  const sourceLifetime = useSyncExternalStore(subscribeClientLifetime, getClientLifetime, getClientLifetime);

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

  // -- SSE state ------------------------------------------------------------
  // Stays 'connecting' until the daemon's `ready` frame (or any event) arrives, do NOT
  // set 'active' synchronously before that, as it would show "Live" on a dead stream.
  const [sseState, setSseState] = useState<SseState>('connecting');

  useEffect(() => {
    // The stream opens through routedFetch on both direct and relay routes (the relay
    // tunnel carries event streams, see lib/relay-connection.ts).
    // A route change retires this subscription before opening a fresh one, with
    // reconnect and authentication still owned by the existing platform transport.
    setSseState('connecting');
    let mounted = true;
    const controller = new AbortController();
    const isCurrent = () => mounted && !controller.signal.aborted && isClientLifetimeCurrent(sourceLifetime);
    let dispose: (() => void) | null = null;

    // The daemon writes a `ready` frame as soon as it accepts the stream, so an idle
    // daemon (no turn running) still proves the transport is delivering. Any later
    // error or termination pauses the status until the reconnect's own `ready`.
    platformClient.streams
      .open(
        HEALTH_EVENTS_PATH,
        {
          onReady: () => { if (isCurrent()) setSseState('active'); },
          onEvent: () => { if (isCurrent()) setSseState('active'); },
          onError: () => { if (isCurrent()) setSseState('error'); },
          onTerminate: () => { if (isCurrent()) setSseState('error'); },
        },
        { signal: controller.signal, reconnect: DEFAULT_SSE_RECONNECT },
      )
      .then((close) => {
        if (!mounted) {
          close();
          return;
        }
        dispose = close;
      })
      .catch(() => {
        if (isCurrent()) setSseState('error');
      });

    return () => {
      mounted = false;
      controller.abort();
      dispose?.();
      // Don't flip to error on unmount, component teardown, not a real failure
    };
  }, [storeRoute, sourceLifetime]);

  // -- Latency + connection probe -------------------------------------------
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>('down');

  // Use TanStack Query so we get deduplication and window-focus coordination.
  // refetchIntervalInBackground: true, intentional trade-off: keeps the strip
  // accurate even when the tab is backgrounded (battery/network cost is low at
  // 15 s intervals; a stale connection indicator would be misleading to users
  // who return to the tab expecting current status). With a relay pairing stored,
  // the relay is tried together with the direct probe (lib/relay-connection.ts
  // probeConnection), so a device away from home connects as soon as the relay answers.
  const healthQuery = useQuery({
    queryKey: ['daemon-health', 'probe'] as const,
    queryFn: () => probeConnection(probeLatency, () => setConnectionState('connected')),
    networkMode: 'always',
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  const refetchHealth = healthQuery.refetch;
  const [browserOffline, setBrowserOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    let cancelled = false;
    const offline = () => setBrowserOffline(true);
    const online = () => {
      void refetchHealth().then(() => {
        if (!cancelled && navigator.onLine) setBrowserOffline(false);
      });
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    return () => {
      cancelled = true;
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }, [refetchHealth]);

  // Derive connection state from the probe. A route that answered: connected over it.
  // No route: a connection that was up shows 'reconnecting' for one probe, then 'down'.
  useEffect(() => {
    if (browserOffline) {
      setLatencyMs(null);
      setConnectionState('down');
      return;
    }
    if (healthQuery.isSuccess) {
      const { route, latencyMs: probed } = healthQuery.data;
      setLatencyMs(probed);
      if (route) {
        setConnectionState('connected');
        setActiveRoute(route);
        return;
      }
    } else if (healthQuery.isError) {
      setLatencyMs(null);
    } else {
      return; // still pending, nothing to evaluate yet
    }
    setConnectionState((previous) => (previous === 'connected' ? 'reconnecting' : 'down'));
  }, [browserOffline, healthQuery.isSuccess, healthQuery.isError, healthQuery.data, healthQuery.dataUpdatedAt]);

  // -- Tasks ----------------------------------------------------------------
  const tasksQuery = useQuery({
    queryKey: ['tasks'] as const,
    queryFn: () => platformClient.operator.tasks.list(),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // -- Signed-in axis (auth.current: 200 vs 401) ----------------------------
  const authProbe = useQuery({
    queryKey: ['daemon-health', 'auth'] as const,
    queryFn: () => probeCall(getCurrentAuth),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  // -- Working axis (an authed read that surfaces the read:sessions scope gap) --
  // A token that is signed-in but lacks read:sessions will 401 here → 'blocked',
  // so the strip shows reachable+signed-in but NOT working rather than a false "live".
  const workingProbe = useQuery({
    queryKey: ['daemon-health', 'working'] as const,
    queryFn: () => probeCall(() => platformClient.operator.sessions.list()),
    refetchInterval: HEALTH_PROBE_INTERVAL_MS,
    refetchIntervalInBackground: true,
    retry: 0,
    staleTime: HEALTH_PROBE_INTERVAL_MS / 2,
  });

  const signedIn: AuthState = authProbe.isSuccess ? deriveAuthState(authProbe.data) : 'unknown';
  const working: WorkingState = workingProbe.isSuccess ? deriveWorkingState(workingProbe.data) : 'unknown';

  // -- Current model --------------------------------------------------------
  const modelQuery = useQuery({
    queryKey: ['daemon-health', 'model'] as const,
    queryFn: () => platformClient.operator.models.current.get(),
    // Models change rarely, refresh every 60 s
    refetchInterval: 60_000,
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
  };
}
