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
// Forward the owner keep-awake toggle from a surface to an adopted daemon:
// the one forwarder both terminal products use.
export {
  postPowerKeepAwakeSet,
  forwardKeepAwakeToAdoptedDaemon,
  readServedKeepAwakeState,
  describeKeepAwakeOutcome,
  forwardKeepAwakeWithNotice,
  createKeepAwakeForwardQueue,
  createKeepAwakeForwarder,
  POWER_KEEP_AWAKE_SET_PATH,
  POWER_KEEP_AWAKE_SET_TIMEOUT_MS,
} from './keep-awake-remote.js';
export type {
  PowerKeepAwakeRemoteConnection,
  PowerKeepAwakeRemoteFailureKind,
  PowerKeepAwakeRemoteSuccess,
  PowerKeepAwakeRemoteFailure,
  PowerKeepAwakeRemoteResult,
  ForwardKeepAwakeDeps,
  ForwardKeepAwakeOutcome,
  KeepAwakeNoticeDeps,
  KeepAwakeForwarderDeps,
  KeepAwakeForwarder,
} from './keep-awake-remote.js';
