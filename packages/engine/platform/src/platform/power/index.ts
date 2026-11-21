/**
 * power/, sleep ownership: automatic work inhibition, sleep-edge honesty,
 * and the owner's keep-awake toggle (see manager.ts for the ruling's shape).
 */
export { PowerManager, LID_SWITCH_HONEST_SPLIT, KEEP_AWAKE_NOT_HELD, keepAwakeCondition } from './manager.js';
export type { KeepAwakeCondition, PowerState, PowerInhibitorView, PowerManagerOptions, PowerSleepEdgeHooks } from './manager.js';
export { createLinuxLogindSeam, reapOrphanedInhibitors } from './linux-logind.js';
export type { OrphanReaperDeps, SleepWatchSpawner } from './child-hygiene.js';
export { createDarwinCaffeinateSeam, reapOrphanedDarwinSleepWatchers } from './darwin-caffeinate.js';
export type { DarwinCaffeinateSeamOptions, DarwinPowerSource } from './darwin-caffeinate.js';
export { bindPowerWorkSignals } from './work-signals.js';
export { wireRuntimePower, createHostPowerSeam } from './runtime-wiring.js';
export type { RuntimePowerWiringInput } from './runtime-wiring.js';
export type { PowerWorkSignalBus } from './work-signals.js';
export { createUnavailablePowerSeam } from './types.js';
export type { PowerPlatformSeam, PowerInhibitHandle, PowerInhibitClass } from './types.js';
// The adopted daemon's power state for a surface's keep-awake chip, event-driven
// with a poll only while no event stream is open: the one source both terminal products use.
export {
  createDaemonPowerStateSource,
  watchDaemonPowerEvents,
  POWER_EVENT_DOMAIN,
  POWER_STATE_CHANGED_EVENT,
} from './daemon-power-source.js';
export type {
  DaemonPowerStateSource,
  DaemonPowerStateSourceDeps,
  DaemonPowerEventWatch,
  DaemonPowerEventHandlers,
  WatchDaemonPowerEventsOptions,
} from './daemon-power-source.js';
// The keep-awake toggle a daemon serves, for a surface's chip. The toggle itself
// is the daemon-owned setting power.keepAwake, written like any daemon setting.
export {
  readServedKeepAwakeState,
  readServedKeepAwakeEnabled,
  POWER_STATUS_PATH,
} from './keep-awake-remote.js';
