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

import { useEffect, useRef } from 'react';
import { useOptionalToast } from '../lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import type { RuntimeEventDomain } from '@goodvibes/engine/contracts';
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
  'tasks', 'contracts', 'gate', 'providers', 'knowledge', 'control-plane', 'fleet', 'ops', 'session', 'planner', 'config', 'workspace',
  // A channel switched on or off, an account connected or degraded: Personal, Channels reads them again.
  'surfaces',
  // A schedule made, changed, paused, run or removed, a run started or ended: Automation reads its schedules and runs again.
  'automation',
  // The places (views/places) follow these too: carried all the time, so entering or leaving Places never reopens the
  // lane (which would read every active query again).
  'agents', 'mcp', 'plugins',
];

/**
 * LIST_CHANGED (the `workspace` frame): the daemon wrote one of these lists, so the
 * views showing it read it again. The focus and reconnect re-reads stay as the
 * fallback (lib/queries NO_EVENT_LIST_FRESHNESS).
 */
const LIST_CHANGED_KEYS: Readonly<Record<string, readonly (readonly unknown[])[]>> = {
  memory: [['memory']],
  checkpoints: [queryKeys.checkpoints],
  // The places (views/places) follow these lists themselves (hooks/usePlaceLists.ts); the keys here are other views'.
  'ci-watches': [queryKeys.ciWatches],
  'check-ins': [queryKeys.checkinConfig, queryKeys.checkinReceipts],
  people: [queryKeys.principals],
  // Package E's lists: the inbox and the message read, the calendar's events and calendars, every
  // occasions read, paired devices, local voice and the wake word, Tailscale.
  mail: [['email']],
  calendar: [['calendar']],
  dates: [['occasions']],
  'paired-devices': [queryKeys.pairingTokens],
  voice: [['voice']],
  tailscale: [queryKeys.tailscale],
  // Settings > Payments (RepeatPurchases.tsx): a repeat purchase allowed or stopped.
  payments: [['command-screen', 'repeat-purchases']],
  safety: [queryKeys.permissionRules],
  // Settings > Secure address (SecureAddressSettings.tsx): this machine's group or the group's certificate changed,
  // here or on another machine (the Devices and network place follows the same list itself).
  'machine-group': [['secureAddress', 'get']],
};

/** Session changes are built from checkpoints: every `['sessions', <id>, 'changes']` read follows that list too. */
const isSessionChangesKey = (query: { queryKey: readonly unknown[] }): boolean => query.queryKey[0] === 'sessions' && query.queryKey[2] === 'changes';

/** The list a LIST_CHANGED frame names, read defensively (the frame or its `payload`). */
function changedListOf(frame: unknown): string | undefined {
  const outer = (frame ?? {}) as { type?: unknown; list?: unknown; payload?: unknown };
  const inner = (outer.payload ?? {}) as { type?: unknown; list?: unknown };
  // The daemon's envelope carries the type, and the event itself (with `list`) as its payload.
  for (const event of [inner, outer]) {
    if (event.type === 'LIST_CHANGED' && typeof event.list === 'string') return event.list;
  }
  return undefined;
}

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
  // MODEL_CHANGED, provider metadata and a provider's model list read again ride
  // `providers`; a model change can also replace a session's context window, so
  // mounted context usage is re-read too.
  providers: [queryKeys.providers, ['models'], queryKeys.sessions, ['daemon-health', 'model']],
  knowledge: [['knowledge']],
  'control-plane': [queryKeys.control],
  // Fleet node lifecycle deltas revalidate the snapshot and archive, at most once per
  // REFETCH_WINDOW_MS; the snapshot stays the one source of truth, so no
  // client-side tree is built from the deltas.
  fleet: [queryKeys.fleet, queryKeys.fleetArchived],
  // OPS_POWER_STATE_CHANGED and OPS_MEMORY_PRESSURE ride `ops`.
  ops: [queryKeys.power, queryKeys.opsMemory],
  // A setting changed from any surface (another tab or device, the daemon's CLI):
  // the one settings cache and the restart-pending report are re-read, at most once
  // per window, so a config.setMany burst costs one config.get.
  // A serving setting (network binding, https) changes who can reach the daemon: the origin's
  // posture and the pairing page's reach are re-read with it.
  config: [queryKeys.config, queryKeys.featureRestartStatus, queryKeys.originPosture, queryKeys.pairingAddress],
  [SESSION_UPDATE_WIRE_EVENT]: [queryKeys.sessions],
  [HOSTED_SESSION_UPDATE_WIRE_EVENT]: [queryKeys.hostedSessionsAll],
  // A device asked to pair as a node, or a request was answered from another surface:
  // Settings, Devices re-reads its "Waiting to pair" list.
  'remote-pair-requested': [queryKeys.remotePairRequests, ['command-screen', 'devices-waiting']],
  'remote-pair-approved': [queryKeys.remotePairRequests, ['command-screen', 'devices-waiting']],
  'remote-pair-rejected': [queryKeys.remotePairRequests, ['command-screen', 'devices-waiting']],
  // The channels' own frames (SURFACE_ENABLED, SURFACE_ACCOUNT_DEGRADED, ...): the Channels tab's one list.
  surfaces: [['channels', 'status']],
  // The automation domain's frames (a schedule or a run changed anywhere): Automation's schedules and runs (AutomationPanel.tsx).
  automation: [['command-screen', 'automation-schedules']],
};

const FALLBACK_REFRESH_MS = 15_000;

/**
 * A running contract with many agents sends fleet frames several times a
 * second, and one multi-key settings write sends a config frame per key. For
 * these frames the first refetches at once; frames inside the next window fold
 * into one more refetch at its end, so each is read at most once per window
 * instead of once per frame.
 */
const REFETCH_WINDOW_MS = 250;
const WINDOWED_FRAMES: ReadonlySet<string> = new Set(['fleet', 'config']);

/** A PROVIDER_WARNING frame's message, read defensively (the frame or its `payload`). */
function providerWarningOf(frame: unknown): string | undefined {
  const outer = (frame ?? {}) as { type?: unknown; message?: unknown; payload?: unknown };
  const inner = (outer.payload ?? {}) as { type?: unknown; message?: unknown };
  // The daemon's envelope carries the type, and the event itself (with `message`) as its payload.
  for (const event of [inner, outer]) {
    if (event.type === 'PROVIDER_WARNING' && typeof event.message === 'string' && event.message.trim()) return event.message.trim();
  }
  return undefined;
}

export function useRealtimeInvalidation(enabled: boolean): string | null {
  const queryClient = useQueryClient();
  const stream = useEventStreamState('app');
  const toast = useOptionalToast();
  const toastRef = useRef(toast);
  useEffect(() => { toastRef.current = toast; }, [toast]);

  useEffect(() => {
    if (!enabled) return undefined;
    let disposed = false;
    // Per windowed frame name: the open window's timer, and whether a frame arrived inside it.
    const windows = new Map<string, { timer: ReturnType<typeof setTimeout>; pending: boolean }>();
    const refetchFrame = (frame: string) => {
      for (const key of DOMAIN_INVALIDATIONS[frame] ?? []) void queryClient.invalidateQueries({ queryKey: key });
    };
    const onWindowedFrame = (frame: string) => {
      const open = windows.get(frame);
      if (open) { open.pending = true; return; }
      refetchFrame(frame);
      const close = () => {
        if (disposed) return;
        const current = windows.get(frame);
        if (!current?.pending) { windows.delete(frame); return; }
        refetchFrame(frame);
        windows.set(frame, { timer: setTimeout(close, REFETCH_WINDOW_MS), pending: false });
      };
      windows.set(frame, { timer: setTimeout(close, REFETCH_WINDOW_MS), pending: false });
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
      events: [...Object.keys(DOMAIN_INVALIDATIONS), 'workspace'],
      onEvent: (name, payload) => {
        // A provider warning (a model you use stopped being free, a provider in trouble) is
        // said in its own words, as the terminal app says it, besides re-reading the lists.
        const warning = name === 'providers' ? providerWarningOf(payload) : undefined;
        if (warning) toastRef.current?.toast({ title: 'Model provider', description: warning, tone: 'warning', durationMs: 0 });
        if (name === 'workspace') {
          const list = changedListOf(payload);
          for (const key of (list ? LIST_CHANGED_KEYS[list] : undefined) ?? []) void queryClient.invalidateQueries({ queryKey: key });
          if (list === 'checkpoints') void queryClient.invalidateQueries({ predicate: isSessionChangesKey });
          return;
        }
        if (WINDOWED_FRAMES.has(name)) { onWindowedFrame(name); return; }
        for (const key of DOMAIN_INVALIDATIONS[name] ?? []) invalidate(key, name);
      },
      onReady: (resumed) => {
        if (resumed) void queryClient.invalidateQueries({ type: 'active' });
      },
    });
    return () => {
      disposed = true;
      for (const open of windows.values()) clearTimeout(open.timer);
      windows.clear();
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
