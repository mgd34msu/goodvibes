/**
 * waiting-sources.ts, the one list of Waiting for you that a terminal program
 * supplies itself (waiting-place.ts names it): the kinds of approval, the same
 * list the capability approval.kinds reads. Everything else the place lists is
 * the daemon's (the owner inbox, Telegram, the purchases). Kept apart from the
 * declaration, which the web UI imports.
 */
import { APPROVAL_KINDS } from '@goodvibes/engine/platform/platform/capabilities';
import type { PlaceProgramSource } from './place-host.js';

/** Waiting for you's program sources: the kinds of approval. */
export function waitingPlaceSources(): Readonly<Record<string, PlaceProgramSource>> {
  return {
    'approval-kinds': { read: () => APPROVAL_KINDS, subscribe: () => () => {} },
  };
}
