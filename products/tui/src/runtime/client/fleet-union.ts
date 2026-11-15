/**
 * fleet-union.ts, the Agents modal shows everything running, not just what this
 * terminal started.
 *
 * ── What moved to the platform, and what stays here ────────────────────────────
 *
 * The platform's `@goodvibes-jev/engine/platform/platform/runtime/client` now owns the
 * policy every surface needs for this: `createDaemonFleetRowsPoller` (the poll
 * cadence and last-known-rows retention when a poll fails), `mergeFleetNodes`
 * (the local-wins dedupe by node id) and `daemonOnlyFleetActRefusal` (the
 * reason string a steer/archive against a daemon-only row gets, rather than a
 * bare false). This module is now a thin wrapper over that policy.
 *
 * What stays here is the modal binding: the TUI's own `FleetReadModel`
 * interface (interrupt/resume/kill/steer/archive, subscribe, snapshots) and
 * `buildFleetSnapshot`, the tree-builder + honest cost/token aggregator this
 * repo's Agents modal renders from. Rebuilding through the SAME builder the
 * local view uses, rather than summing two halves, is what keeps the
 * rollups, the cost/token totals and the blocked-on-user ordering computed
 * once, over the whole fleet.
 *
 * ── Who wins ──────────────────────────────────────────────────────────────
 *
 * Local rows are AUTHORITATIVE for processes this terminal spawned. They are
 * live, the registry pushes on every state change, with sub-second latency,
 * and they carry the capabilities that make a row actionable here (interrupt,
 * resume, kill, steer all reach a real child process). The daemon's copy of
 * the same row, arriving over a poll, is necessarily staler; where both
 * describe the same node id, the local one is kept (`mergeFleetNodes`).
 *
 * ── Acting on a row you do not own ────────────────────────────────────────
 *
 * `interrupt`/`resume`/`kill`/`steer` reach this process's own children. A
 * daemon row has no child here to signal, so those refuse, and `steer`,
 * which has a reason channel, says why rather than returning a bare false
 * that reads as "the agent ignored you". The modal's own act surface
 * (fleet-gateway.ts) already drives the daemon's verbs for the acts the
 * daemon serves.
 */
import {
  createFleetUnionRowsPoller,
  daemonOnlyFleetActRefusal,
  DEFAULT_FLEET_REFRESH_MS,
  mergeFleetNodes,
  readDaemonFleetRows,
  type DaemonFleetRows,
  type DaemonFleetRowsPoller,
  type DaemonFleetRowsPollerOptions,
  type DaemonVerbCaller,
} from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { buildFleetSnapshot, type FleetReadModel, type FleetSnapshot } from '../../views/fleet-read-model.ts';

/** Re-exported so an importer that only needs the platform's policy has one import site. */
export { DEFAULT_FLEET_REFRESH_MS, daemonOnlyFleetActRefusal, mergeFleetNodes, readDaemonFleetRows };
export type { DaemonFleetRows, DaemonFleetRowsPoller, DaemonFleetRowsPollerOptions };

export interface FleetUnionOptions {
  /** This surface's own live registry view, authoritative for what it spawned. */
  readonly local: FleetReadModel;
  readonly verbs: DaemonVerbCaller;
  readonly refreshIntervalMs?: number;
  readonly log?: Pick<typeof logger, 'debug'>;
}

export interface FleetUnionReadModel extends FleetReadModel {
  /** Stop the refresh timer. Idempotent. */
  stop(): void;
  /** Re-read the daemon's rows now. Never throws. */
  refresh(): Promise<void>;
}

/** How this terminal names itself in a daemon-only-row act refusal. */
const SURFACE_LABEL = 'this terminal';

/** The elapsed column's resolution; a build older than this is redone so running times keep moving. */
const ELAPSED_STEP_MS = 1_000;

/**
 * Wrap a local fleet read model so its snapshot also carries the adopted
 * daemon's rows, over the platform's poll/merge/refusal policy.
 *
 * Inert until the first poll lands: before then, and whenever the daemon
 * cannot answer, the snapshot is exactly the local one, which is the honest
 * answer, not a degraded one. A daemon that stops answering keeps its LAST
 * known rows rather than dropping them (the poller's own retention), so a
 * momentary blip does not make half the fleet blink out and back.
 */
export function createFleetUnionReadModel(options: FleetUnionOptions): FleetUnionReadModel {
  const local = options.local;
  const poller = createFleetUnionRowsPoller(options);

  // The merged view is built once per change. The poller and, while anything is
  // subscribed, the local registry bump these counters; a read with both
  // unchanged returns the last build. Elapsed times on that build age, so it is
  // also rebuilt once the elapsed column (one-second steps) would show a new value.
  let pollerRevision = 0;
  let localRevision = 0;
  let localWatchers = 0;
  let unsubscribeLocalWatch: (() => void) | null = null;
  let built: { readonly pollerRevision: number; readonly localRevision: number; readonly at: number; readonly snapshot: FleetSnapshot; readonly localIds: ReadonlySet<string> } | null = null;

  const listeners = new Set<() => void>();
  const unsubscribePoller = poller.subscribe(() => {
    pollerRevision++;
    for (const listener of listeners) listener();
  });

  const build = (): NonNullable<typeof built> => {
    const now = Date.now();
    if (built && localWatchers > 0 && built.pollerRevision === pollerRevision && built.localRevision === localRevision && now - built.at < ELAPSED_STEP_MS) {
      return built;
    }
    const localSnapshot = local.getSnapshot();
    // Ids this surface owns right now, the set the daemon's copy defers to; computed once per build.
    const localIds = new Set(localSnapshot.rows.map((row) => row.node.id));
    const merged = poller.mergedRows(localSnapshot.rows.map((row) => row.node));
    let snapshot = localSnapshot;
    if (merged) {
      const union = buildFleetSnapshot(merged.nodes, Math.max(localSnapshot.capturedAt, merged.capturedAt));
      snapshot = merged.truncated && merged.totalCount !== undefined
        ? { ...union, daemonPartial: { shown: merged.nodes.filter((node) => !localIds.has(node.id)).length, total: merged.totalCount } }
        : union;
    }
    built = { pollerRevision, localRevision, at: now, snapshot, localIds };
    return built;
  };
  const isLocalId = (id: string): boolean => build().localIds.has(id);
  const acted = <T>(result: T): T => { built = null; return result; };

  return {
    getSnapshot(): FleetSnapshot {
      return build().snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (localWatchers++ === 0) unsubscribeLocalWatch = local.subscribe(() => { localRevision++; });
      const unsubscribeLocal = local.subscribe(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
        unsubscribeLocal();
        if (--localWatchers === 0) {
          unsubscribeLocalWatch?.();
          unsubscribeLocalWatch = null;
          built = null;
        }
      };
    },

    // An act on a local row changes the local fleet now; the next read rebuilds
    // instead of waiting for the registry's next change notice.
    interrupt: (id) => acted(local.interrupt(id)),
    resume: (id) => acted(local.resume(id)),
    kill: (id, opts) => acted(local.kill(id, opts)),
    steer: (id, text) => (isLocalId(id) ? acted(local.steer(id, text)) : { queued: false, reason: daemonOnlyFleetActRefusal(id, SURFACE_LABEL) }),
    subscribeConsumed: (listener) => local.subscribeConsumed(listener),
    // The archive is this surface's own view state; the daemon keeps its own.
    getArchivedSnapshot: () => local.getArchivedSnapshot(),
    archive: (id) =>
      isLocalId(id) ? acted(local.archive(id)) : { archived: false, count: 0, reason: daemonOnlyFleetActRefusal(id, SURFACE_LABEL) },
    archiveFinished: () => acted(local.archiveFinished()),
    unarchive: (id) => acted(local.unarchive(id)),

    refresh: () => poller.refresh(),
    stop(): void {
      poller.stop();
      unsubscribePoller();
      unsubscribeLocalWatch?.();
      unsubscribeLocalWatch = null;
      localWatchers = 0;
      built = null;
      listeners.clear();
    },
  };
}
