/**
 * power/runtime-wiring.ts, one-call composition of sleep ownership for the
 * runtime-services root: pick the platform seam (Linux logind on linux,
 * caffeinate + the unified-log sleep-edge watcher on macOS, the honest
 * unavailable seam elsewhere), start
 * the PowerManager (which re-applies a persisted keep-awake toggle), bind the
 * bus work signals (turns / agents / scheduled runs), register the sleep-edge
 * hooks, and broadcast every state change as runtime.ops
 * OPS_POWER_STATE_CHANGED for the always-visible chip.
 */
import { platform as osPlatform } from 'node:os';
import { PowerManager, type PowerSleepEdgeHooks } from './manager.js';
import type { PowerWorkSignalBus } from './work-signals.js';
import { createLinuxLogindSeam } from './linux-logind.js';
import { createDarwinCaffeinateSeam } from './darwin-caffeinate.js';
import { createUnavailablePowerSeam, type PowerPlatformSeam } from './types.js';
import { emitOpsPowerStateChanged } from '../runtime/emitters/ops.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';

export interface RuntimePowerWiringInput {
  readonly readConfig: (key: string) => unknown;
  readonly writeConfig: (key: string, value: boolean) => void;
  /** Live config subscription (ConfigManager.subscribe shape) so power.keepAwake changes apply live. */
  readonly subscribeConfig?: ((key: string, cb: (newValue: unknown) => void) => () => void) | undefined;
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  /** Checkpoint hook for PrepareForSleep(true), checkpoint what's checkpointable. */
  readonly sleepCheckpoint?: (() => void | Promise<void>) | undefined;
  /** Catch-up hooks for wake: re-arm timers, reconnect, deliver missed receipts. */
  readonly wakeCatchUp?: ReadonlyArray<() => void | Promise<void>> | undefined;
  /** Injectable seam override (tests, or a host that opts into the real OS seam). */
  readonly seam?: PowerPlatformSeam | undefined;
}

/**
 * The real host power seam for an OS (default: this one): Linux logind (which
 * spawns the systemd-inhibit inhibitor children and the read-only sleep-edge
 * dbus-monitor watcher), macOS caffeinate (which spawns the caffeinate
 * inhibitor child and the read-only sleep-edge `log stream` watcher), or the
 * honest unavailable seam elsewhere. Spawning a real sleep-edge watcher
 * is a host-level side effect, so the runtime-services factories pass the
 * non-spawning unavailable seam unless their caller sets `powerSeam` (test
 * determinism); the standalone daemon and both terminal products set it. A
 * surface and a daemon on one host therefore each run a PowerManager over the
 * same `power.keepAwake` key; the surface forwards its toggle to an adopted
 * daemon (see keep-awake-remote.ts) so the daemon's hold outlives the surface.
 */
export function createHostPowerSeam(platform: NodeJS.Platform = osPlatform()): PowerPlatformSeam {
  if (platform === 'linux') return createLinuxLogindSeam();
  if (platform === 'darwin') return createDarwinCaffeinateSeam();
  return createUnavailablePowerSeam(`no power seam for ${platform}`);
}

/** Compose and start the runtime's PowerManager. Never throws; never blocks startup. */
export function wireRuntimePower(input: RuntimePowerWiringInput): PowerManager {
  const seam = input.seam ?? createHostPowerSeam();
  const manager = new PowerManager({
    seam,
    readConfig: input.readConfig,
    writeConfig: input.writeConfig,
    subscribeConfig: input.subscribeConfig,
    // Bound for the manager's life so stop() also stops work events reaching it.
    ...(input.runtimeBus ? { workSignalBus: input.runtimeBus as unknown as PowerWorkSignalBus } : {}),
    onStateChanged: input.runtimeBus
      ? (state) => {
        emitOpsPowerStateChanged(input.runtimeBus!, { sessionId: 'system', traceId: `power:${Date.now()}`, source: 'power-manager' }, {
          inhibited: state.work.held || state.keepAwake.held,
          keepAwake: state.keepAwake.enabled,
          workReasons: state.work.reasons,
          note: state.keepAwake.note ?? undefined,
          sleepEdgeNote: state.sleepEdge.note ?? undefined,
        });
      }
      : undefined,
  });
  const hooks: PowerSleepEdgeHooks = {
    onSleep: input.sleepCheckpoint,
    onWake: input.wakeCatchUp
      ? async () => {
        for (const hook of input.wakeCatchUp!) await hook();
      }
      : undefined,
  };
  if (hooks.onSleep || hooks.onWake) manager.onSleepEdge(hooks);
  manager.start().catch((error: unknown) => {
    logger.warn('[power] start failed; sleep ownership is not active', { error: summarizeError(error) });
  });
  return manager;
}
