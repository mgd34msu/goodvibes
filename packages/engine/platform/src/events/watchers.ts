/**
 * WatcherEvent, discriminated union covering managed watcher and listener lifecycle events.
 */
import type { EventAbout } from './about.js';

export const WATCHER_SOURCE_KINDS = ['poll', 'webhook', 'tail', 'file', 'api', 'stream'] as const;

export type WatcherSourceKind = (typeof WATCHER_SOURCE_KINDS)[number];

export type WatcherEvent = (
  /** A watcher began watching its source; `sourceKind` is how it reads it (poll, webhook, tail, file, api, stream) and `name` is its display name. */
  | {
      type: 'WATCHER_STARTED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      name: string;
    }
  /** A watcher ran and saw its source at `seenAt`; `checkpoint` is how far it has read. Published after every run. */
  | {
      type: 'WATCHER_HEARTBEAT';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      seenAt: number;
      checkpoint: string;
    }
  /** Published after a run whose checkpoint differs from the previous one; a run that sees the same checkpoint publishes only WATCHER_HEARTBEAT. */
  | {
      type: 'WATCHER_CHECKPOINT_ADVANCED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      checkpoint: string;
    }
  /** A watcher run failed; `retryable` says whether it will try again. */
  | {
      type: 'WATCHER_FAILED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      error: string;
      retryable: boolean;
    }
  /** A watcher stopped watching; `reason` says why (`stopped` by default, `removed` when it was deleted). */
  | {
      type: 'WATCHER_STOPPED';
      watcherId: string;
      sourceKind: WatcherSourceKind;
      reason: string;
    }
) & {
  /** The watcher the event is about and the project it belongs to (null: none, the owner's), for the stream filter. */
  readonly about?: EventAbout | undefined;
};

export type WatcherEventType = WatcherEvent['type'];
