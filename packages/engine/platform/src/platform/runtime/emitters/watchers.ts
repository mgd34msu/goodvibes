/**
 * Watcher emitters, typed wrappers for WatcherEvent domain.
 */

import { createEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventEnvelope } from '../events/envelope.js';
import type { RuntimeEventBus } from '../events/index.js';
import type { WatcherEvent, WatcherSourceKind } from '../../../events/watchers.js';
import type { EmitterContext } from './index.js';

function watcherEvent<T extends WatcherEvent['type']>(
  type: T,
  data: Omit<Extract<WatcherEvent, { type: T }>, 'type'>,
  ctx: EmitterContext,
): RuntimeEventEnvelope<T, Extract<WatcherEvent, { type: T }>> {
  // A watcher belongs to no project (the registry keeps none for it): each event says it is about that watcher of the
  // owner's own (events/about.ts), so the stream filter gives it to the owner alone, by what it declares.
  const about = { project: null, kind: 'watcher' as const, id: data.watcherId };
  return createEventEnvelope(type, { type, ...data, about } as Extract<WatcherEvent, { type: T }>, ctx);
}

export function emitWatcherStarted(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; name: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_STARTED', data, ctx));
}

export function emitWatcherHeartbeat(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; seenAt: number; checkpoint: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_HEARTBEAT', data, ctx));
}

export function emitWatcherCheckpointAdvanced(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; checkpoint: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_CHECKPOINT_ADVANCED', data, ctx));
}

export function emitWatcherFailed(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; error: string; retryable: boolean },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_FAILED', data, ctx));
}

export function emitWatcherStopped(
  bus: RuntimeEventBus,
  ctx: EmitterContext,
  data: { watcherId: string; sourceKind: WatcherSourceKind; reason: string },
): void {
  bus.emit('watchers', watcherEvent('WATCHER_STOPPED', data, ctx));
}
