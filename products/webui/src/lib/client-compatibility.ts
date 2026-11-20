/**
 * client-compatibility.ts, this tab's view of the client-build floor.
 *
 * A daemon update swaps the daemon binary. It does not restart the clients already
 * attached to it: this browser tab, opened days earlier, keeps running its own build
 * and keeps participating in shared-session work under whatever rules that build
 * shipped with. The daemon publishes the minimum client build it accepts as the
 * `X-Goodvibes-Client-Floor` response header on its authenticated `/status`
 * response; a tab below it says so plainly.
 *
 * The comparison, the header reader and the verdict are the platform's own
 * (control-plane/build-compatibility.ts, an import-free module); only the
 * wording is this surface's: a tab reloads, where a terminal process restarts.
 */

import {
  CLIENT_COMPATIBILITY_FLOOR_HEADER,
  compareBuildVersions,
  evaluateClientCompatibility as evaluatePlatformClientCompatibility,
  readClientCompatibilityFloor,
  type ClientCompatibilityStatus,
  type ClientCompatibilityVerdict,
  type ClientRestartWording,
} from '@goodvibes/engine/platform/platform/control-plane/build-compatibility';
import { subscribeClientLifetime } from './client-lifetime';

export { CLIENT_COMPATIBILITY_FLOOR_HEADER, compareBuildVersions, readClientCompatibilityFloor };
export type { ClientCompatibilityStatus, ClientCompatibilityVerdict };

const TAB_WORDING: ClientRestartWording = {
  subject: 'This tab',
  restart: 'reload the page to pick up the current build',
  reinstall: 'Reload from the current install',
};

/** Judge this build against a floor the daemon announced. */
export function evaluateClientCompatibility(input: {
  readonly clientVersion: string | undefined;
  readonly floor: string | undefined;
}): ClientCompatibilityVerdict {
  return evaluatePlatformClientCompatibility({ ...input, wording: TAB_WORDING });
}

// ---------------------------------------------------------------------------
// Observed-floor store
// ---------------------------------------------------------------------------
//
// goodvibes.ts's requestJson/requestStream is the one HTTP helper every operator
// call passes through; it records the floor the most recent response that
// carried one announced here, so any part of the app can read the daemon's
// current stance without threading a value through every call site, the same
// external-store shape lib/relay-connection.ts's active-route tracking already
// uses (subscribe/get, driven with React's useSyncExternalStore).

let observedFloor: string | undefined;
const listeners = new Set<(floor: string | undefined) => void>();

/**
 * Record a floor a daemon response carried. The daemon announces it only on some
 * responses (the authenticated status one), so a response without the header says
 * nothing and must not clear a floor already seen; the store resets when the client
 * lifetime changes (another account, another relay), which is when a remembered floor
 * could belong to a different daemon.
 */
export function recordObservedClientCompatibilityFloor(floor: string | undefined): void {
  if (floor === undefined || floor === observedFloor) return;
  setObservedFloor(floor);
}

function setObservedFloor(floor: string | undefined): void {
  if (floor === observedFloor) return;
  observedFloor = floor;
  for (const listener of listeners) listener(floor);
}

subscribeClientLifetime(() => setObservedFloor(undefined));

/** The floor the most recent daemon response carried, or undefined if none has. */
export function getObservedClientCompatibilityFloor(): string | undefined {
  return observedFloor;
}

/** Subscribe to floor changes. Returns an unsubscribe function. */
export function subscribeObservedClientCompatibilityFloor(listener: (floor: string | undefined) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
