// ---------------------------------------------------------------------------
// power-status.ts, the surface-facing view of host sleep ownership (power.*).
//
// The platform's PowerManager owns the policy: a keep-awake toggle (daemon-held,
// persisted), automatic work-signal inhibition ("held because X"), and the
// honest lid-split note when idle-sleep can be blocked but lid-close suspend
// can't. This module is the read-only projection every surface renders from,
// the always-visible "sleep disabled" chip, and the ops/status detail lines,
// seeded from powerManager.getState() and kept live by OPS_POWER_STATE_CHANGED.
//
// Owner ruling: the chip IS the safety mechanism. No timers, no AC-only
// options, the keep-awake toggle is exactly one boolean.
// ---------------------------------------------------------------------------

import { KEEP_AWAKE_NOT_HELD, LID_SWITCH_HONEST_SPLIT, type PowerState } from '@goodvibes/engine/platform/platform/power';

/** The always-visible chip text shown while keep-awake holds (danger-mode idiom). */
export const SLEEP_DISABLED_CHIP = 'sleep disabled';

/** The flattened power state a surface renders from. */
export interface PowerSurfaceState {
  /** The owner keep-awake toggle, the "sleep disabled" chip source. */
  readonly keepAwake: boolean;
  /** True while any sleep inhibitor (work or keep-awake) is held. */
  readonly inhibited: boolean;
  /** Live reasons the WORK inhibitor is held ("held because X"). */
  readonly workReasons: readonly string[];
  /** The honest-split note when part of the requested coverage was refused (verbatim). */
  readonly note: string | null;
  /** Why work is not checkpointed before sleep and caught up on wake (verbatim); null while the hooks can fire. */
  readonly sleepEdgeNote: string | null;
}

/** The neutral state (no inhibition, nothing held), the pre-event seed default. */
export const IDLE_POWER_STATE: PowerSurfaceState = {
  keepAwake: false,
  inhibited: false,
  workReasons: [],
  note: null,
  sleepEdgeNote: null,
};

/** Flatten the full PowerState (power.status.get) into the surface projection. */
export function powerSurfaceFromState(state: PowerState): PowerSurfaceState {
  return {
    keepAwake: state.keepAwake.enabled,
    inhibited: state.keepAwake.held || state.work.held,
    workReasons: state.work.reasons,
    note: state.keepAwake.note,
    sleepEdgeNote: state.sleepEdge?.note ?? null,
  };
}

/** The OPS_POWER_STATE_CHANGED payload shape the surface consumes. */
export interface PowerStateChangedPayload {
  readonly inhibited: boolean;
  readonly keepAwake: boolean;
  readonly workReasons: readonly string[];
  readonly note?: string | undefined;
  readonly sleepEdgeNote?: string | undefined;
}

/** Flatten an OPS_POWER_STATE_CHANGED event payload into the surface projection. */
export function powerSurfaceFromEvent(ev: PowerStateChangedPayload): PowerSurfaceState {
  return {
    keepAwake: ev.keepAwake,
    inhibited: ev.inhibited,
    workReasons: ev.workReasons,
    note: ev.note ?? null,
    sleepEdgeNote: ev.sleepEdgeNote ?? null,
  };
}

/**
 * True while keep-awake is on AND its inhibitor is actually held. Keep-awake
 * that the OS refused is on but holds nothing, so the host can still sleep.
 */
export function keepAwakeHolding(state: Pick<PowerSurfaceState, 'keepAwake' | 'note'>): boolean {
  return state.keepAwake && state.note !== KEEP_AWAKE_NOT_HELD;
}

/** True when the platform served the honest lid-split note (idle blocked, lid-close is the OS's). */
export function hasLidSplitNote(state: PowerSurfaceState): boolean {
  return state.note === LID_SWITCH_HONEST_SPLIT;
}
