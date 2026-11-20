import type { WatcherRecord } from '../../store/domains/watchers.js';
import type { ProcessNode, ProcessServes, ProcessState } from '../types.js';

/**
 * The watchers the platform registers for its own upkeep (registerPollingWatcher
 * with a run of its own): the runtime heartbeat (terminal-shell
 * bootstrap-runtime-bindings.ts), the daemon heartbeat (daemon/facade-lifecycle.ts)
 * and the CI watch poller (ci-watch/poller.ts CI_WATCH_POLLER_ID). Every other
 * watcher was registered by the person or an agent (the watchers API).
 */
const PLATFORM_WATCHER_IDS: ReadonlySet<string> = new Set(['runtime-heartbeat', 'daemon-heartbeat', 'ci-watch-poller']);

/** Whom a watcher works for, from the table above. */
export function watcherServes(id: string): ProcessServes {
  return PLATFORM_WATCHER_IDS.has(id) ? 'system' : 'you';
}

/**
 * WatcherRecord → ProcessNode. WatcherRegistry.list() already normalizes each
 * record through its sourceStatusFor derivation (healthy/lagging/stale/
 * failed), so the mapping here reads the post-derivation state:
 * running → 'idle' (alive, armed between checks), starting → 'queued',
 * degraded → 'stalled' when its heartbeat is stale (two intervals) or it reports an
 * error, 'idle' while a beat is only due (lagging),
 * failed → 'failed', stopped → 'killed'.
 */
export function adaptWatcher(record: WatcherRecord, now: number): ProcessNode {
  let state: ProcessState;
  switch (record.state) {
    case 'running':
      state = 'idle';
      break;
    case 'starting':
      state = 'queued';
      break;
    case 'degraded':
      // A beat that is only due (lagging: past one interval, inside two) is a timer firing a
      // moment late, not a service that stopped answering; stale (two intervals) or an error is.
      state = record.sourceStatus === 'lagging' && !record.lastError ? 'idle' : 'stalled';
      break;
    case 'failed':
      state = 'failed';
      break;
    case 'stopped':
      state = 'killed';
      break;
  }
  const alive = record.state === 'running' || record.state === 'starting' || record.state === 'degraded';
  const statusText = record.degradedReason ?? record.sourceStatus;
  return {
    id: record.id,
    kind: 'watcher',
    serves: watcherServes(record.id),
    ...(record.intervalMs !== undefined && record.intervalMs > 0 ? { schedule: { cadence: { kind: 'every' as const, intervalMs: record.intervalMs } } } : {}),
    parentId: undefined,
    label: record.label,
    state,
    startedAt: record.source.createdAt,
    elapsedMs: alive ? Math.max(0, now - record.source.createdAt) : 0,
    costUsd: null,
    costState: 'unpriced',
    currentActivity: statusText
      ? { kind: 'phase', text: statusText, at: record.lastHeartbeatAt ?? record.source.createdAt }
      : undefined,
    capabilities: { interruptible: false, killable: alive, pausable: false, resumable: false, steerable: false },
    raw: record,
  };
}
