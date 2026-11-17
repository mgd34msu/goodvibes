/**
 * useRealtimeInvalidation, refetch React Query caches off the app's live event lane.
 *
 * One app-wide subscriber on the shared event stream (lib/event-stream.ts): every frame
 * name below maps to the query keys it makes stale. Frames only INVALIDATE (trigger a
 * revalidate); nothing renders straight from a frame. While the lane is not live, active
 * queries are revalidated every 15 s in a visible tab instead, and a ready after a drop
 * revalidates them once, since frames may have been missed in between.
 *
 * Returns the lane's message while live updates are paused or stopped, else null.
 */

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { RuntimeEventDomain } from '@goodvibes-jev/engine/contracts';
import { getClientLifetime } from '../lib/client-lifetime';
import { subscribeEvents, useEventStreamState } from '../lib/event-stream';
import { HOSTED_SESSION_UPDATE_WIRE_EVENT } from '../lib/hosted-sessions';
import { queryKeys } from '../lib/queries';
import { SESSION_UPDATE_WIRE_EVENT } from '../lib/sessions-union';

/** The approval broker's wire event; the daemon tags it with the `gate` domain. */
const APPROVAL_UPDATE_WIRE_EVENT = 'approval-update';
/** The owner inbox's wire event for every item that is not an approval, also tagged `gate`. */
const OWNER_INBOX_UPDATE_WIRE_EVENT = 'owner-inbox-update';

/**
 * Every domain this tab needs app-wide; wire events ride the domain the daemon tags them with.
 * `planner` is handled by the Work plan panel's own subscription; it is listed so the app lane's
 * domain set stays the same when that panel opens or closes, which would otherwise reopen the
 * one app-wide stream and refetch every active query.
 */
const APP_DOMAINS: readonly RuntimeEventDomain[] = [
  'tasks', 'contracts', 'gate', 'providers', 'knowledge', 'control-plane', 'fleet', 'ops', 'session', 'planner',
];

/**
 * Frame name -> the query keys it revalidates. A domain frame is named after its domain;
 * the broker's wire events (session-update, hosted-session-update, approval-update,
 * owner-inbox-update) carry their own names on the same stream.
 */
const DOMAIN_INVALIDATIONS: Record<string, readonly (readonly unknown[])[]> = {
  tasks: [queryKeys.tasks],
  contracts: [queryKeys.contracts],
  // PERMISSION_MODE_CHANGED rides `gate` without a session id, so the broad
  // `sessions` prefix revalidates whichever session's permission chip is mounted.
  gate: [queryKeys.approvals, queryKeys.sessions, queryKeys.permissionRules],
  [APPROVAL_UPDATE_WIRE_EVENT]: [queryKeys.approvals, queryKeys.permissionRules],
  // A question posted, answered (from any surface), withdrawn or delivered, and Jev's decisions.
  [OWNER_INBOX_UPDATE_WIRE_EVENT]: [queryKeys.ownerInbox],
  // MODEL_CHANGED and provider metadata ride `providers`; a model change can also
  // replace a session's context window, so mounted context usage is re-read too.
  providers: [queryKeys.providers, queryKeys.sessions, ['daemon-health', 'model']],
  knowledge: [['knowledge']],
  'control-plane': [queryKeys.control],
  // Fleet node lifecycle deltas revalidate the snapshot and archive, at most once per
  // FLEET_REFETCH_WINDOW_MS; the snapshot stays the one source of truth, so no
  // client-side tree is built from the deltas.
  fleet: [queryKeys.fleet, queryKeys.fleetArchived],
  // OPS_POWER_STATE_CHANGED and OPS_MEMORY_PRESSURE ride `ops`.
  ops: [queryKeys.power, queryKeys.opsMemory],
  [SESSION_UPDATE_WIRE_EVENT]: [queryKeys.sessions],
  [HOSTED_SESSION_UPDATE_WIRE_EVENT]: [queryKeys.hostedSessionsAll],
};

const FALLBACK_REFRESH_MS = 15_000;

/**
 * A running contract with many agents sends fleet frames several times a
 * second. The first frame refetches at once; frames inside the next window
 * fold into one more refetch at its end, so the fleet is read at most once
 * per window instead of once per frame.
 */
const FLEET_REFETCH_WINDOW_MS = 250;

export function useRealtimeInvalidation(enabled: boolean): string | null {
  const queryClient = useQueryClient();
  const stream = useEventStreamState('app');

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    let fleetWindow: ReturnType<typeof setTimeout> | null = null;
    let fleetPending = false;
    const refetchFleet = () => {
      for (const key of DOMAIN_INVALIDATIONS.fleet ?? []) void queryClient.invalidateQueries({ queryKey: key });
    };
    const onFleetFrame = () => {
      if (fleetWindow !== null) { fleetPending = true; return; }
      refetchFleet();
      const close = () => {
        if (disposed) return;
        if (!fleetPending) { fleetWindow = null; return; }
        fleetPending = false;
        refetchFleet();
        fleetWindow = setTimeout(close, FLEET_REFETCH_WINDOW_MS);
      };
      fleetWindow = setTimeout(close, FLEET_REFETCH_WINDOW_MS);
    };
    const invalidate = (key: readonly unknown[], frame: string) => {
      const lifetime = getClientLifetime();
      if (frame === 'providers' && key[0] === 'sessions') {
        // Cancel the context read even if it has no cached data yet. Otherwise a
        // model-change event during the first request only marks it stale and
        // its pre-change capacity can win. Other session queries are untouched.
        const filter = { queryKey: key, predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[2] === 'context-usage' };
        void queryClient.cancelQueries(filter).then(() => {
          if (!disposed && getClientLifetime() === lifetime) void queryClient.invalidateQueries(filter);
        });
        return;
      }
      if (key[0] !== 'contracts') { void queryClient.invalidateQueries({ queryKey: key }); return; }
      // An initial query without data otherwise absorbs invalidation while in
      // flight. A contract event must supersede that pre-event snapshot too.
      void queryClient.cancelQueries({ queryKey: key }).then(() => {
        if (!disposed && getClientLifetime() === lifetime) void queryClient.invalidateQueries({ queryKey: key });
      });
    };
    const unsubscribe = subscribeEvents({
      domains: APP_DOMAINS,
      events: Object.keys(DOMAIN_INVALIDATIONS),
      onEvent: (name) => {
        if (name === 'fleet') { onFleetFrame(); return; }
        for (const key of DOMAIN_INVALIDATIONS[name] ?? []) invalidate(key, name);
      },
      onReady: (resumed) => {
        if (resumed) void queryClient.invalidateQueries({ type: 'active' });
      },
    });
    return () => {
      disposed = true;
      if (fleetWindow !== null) clearTimeout(fleetWindow);
      unsubscribe();
    };
  }, [enabled, queryClient]);

  const down = enabled && (stream.status === 'paused' || stream.status === 'ended');

  // Periodic refresh only while the lane is down and someone is looking at the tab.
  useEffect(() => {
    if (!down) return undefined;
    const interval = setInterval(() => {
      if (document.visibilityState !== 'hidden') void queryClient.invalidateQueries({ type: 'active' });
    }, FALLBACK_REFRESH_MS);
    return () => clearInterval(interval);
  }, [down, queryClient]);

  // A refused or revoked sign-in: re-read auth once so the app shows the sign-in gate.
  const refused = enabled && stream.status === 'ended' && stream.final;
  useEffect(() => {
    if (refused) void queryClient.invalidateQueries({ queryKey: queryKeys.auth });
  }, [refused, queryClient]);

  return down ? stream.message : null;
}
