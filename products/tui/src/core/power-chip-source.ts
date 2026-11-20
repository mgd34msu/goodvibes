// ---------------------------------------------------------------------------
// power-chip-source.ts, the topology-aware source of truth behind the
// always-visible "sleep disabled" chip.
//
// Embedded topology: the in-process PowerManager IS the daemon's, so reading
// getState() per render is already the whole truth; the local runtime bus's
// OPS_POWER_STATE_CHANGED just triggers an immediate repaint so a
// webui-originated toggle (which lands on the same in-process manager) lights
// the chip without waiting for the next natural render.
//
// External/adopted topology: the local manager is NOT the daemon's, so the
// chip renders the DAEMON's state, kept by the engine's one daemon power source
// (platform/power/daemon-power-source.ts): read on each OPS_POWER_STATE_CHANGED
// the daemon publishes while its event stream is open, on a short poll only
// while it is not. A webui-originated toggle on the daemon lights the TUI chip
// as soon as the daemon publishes it, and a TUI toggle (forwarded over
// power.keepAwake.set by the engine's one forwarder,
// platform/power/keep-awake-remote.ts, wired in interactive.ts) refreshes it at
// once. While the daemon's state is unknown (fetch pending/unreachable) the
// local projection is served rather than a fabricated one.
// ---------------------------------------------------------------------------

import { createDaemonPowerStateSource, type DaemonPowerEventHandlers, type DaemonPowerEventWatch, type PowerState } from '@goodvibes/engine/platform/platform/power';
import { IDLE_POWER_STATE, powerSurfaceFromEvent, powerSurfaceFromState, type PowerStateChangedPayload, type PowerSurfaceState } from './power-status.ts';

export interface PowerChipSourceDeps {
  /** The in-process manager (the whole truth in embedded topology). */
  readonly powerManager: { getState(): PowerState };
  /** Subscribe to the LOCAL bus's OPS_POWER_STATE_CHANGED envelopes; returns unsubscribe. */
  readonly onPowerEvent: (cb: (payload: PowerStateChangedPayload) => void) => () => void;
  /** True only in the external/adopted-daemon topology. */
  readonly isExternalDaemon: () => boolean;
  /** Fetch the DAEMON's power.status.get (null when unreachable). */
  readonly fetchDaemonPowerState: () => Promise<PowerState | null>;
  /** The DAEMON's power event stream; without it the chip polls. */
  readonly watchDaemonPowerEvents?: ((handlers: DaemonPowerEventHandlers) => Promise<DaemonPowerEventWatch | null>) | undefined;
  /** Repaint request when the chip's source state changes. */
  readonly render: () => void;
  /** External-topology poll cadence while no event stream is open (default 5000ms; unref'd). */
  readonly pollIntervalMs?: number | undefined;
  readonly timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } | undefined;
}

export interface PowerChipSource {
  /** The current chip projection, daemon-synced in external topology, local otherwise. */
  get(): PowerSurfaceState;
  /** Read the daemon now (keep-awake changed here, a turn ended). */
  refresh(): void;
  /** Stop the daemon source + event subscription. */
  stop(): void;
}

export function createPowerChipSource(deps: PowerChipSourceDeps): PowerChipSource {
  let lastLocal: PowerSurfaceState = IDLE_POWER_STATE;

  // Local bus events: immediate repaint (embedded truth changes live).
  const unsubscribe = deps.onPowerEvent((payload) => {
    lastLocal = powerSurfaceFromEvent(payload);
    deps.render();
  });

  const daemon = createDaemonPowerStateSource({
    isAdopted: deps.isExternalDaemon,
    fetchDaemon: deps.fetchDaemonPowerState,
    ...(deps.watchDaemonPowerEvents ? { watchEvents: deps.watchDaemonPowerEvents } : {}),
    onChange: deps.render,
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
  });

  return {
    get(): PowerSurfaceState {
      const state = daemon.current();
      if (state) {
        try { return powerSurfaceFromState(state); } catch { /* an answer without the power fields: local truth */ }
      }
      // Local truth: read the manager, else the last live event projection.
      try { return powerSurfaceFromState(deps.powerManager.getState()); } catch { return lastLocal; }
    },
    refresh: () => daemon.refresh(),
    stop(): void {
      unsubscribe();
      daemon.stop();
    },
  };
}
