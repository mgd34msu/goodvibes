import { writeSync } from 'node:fs';
import { envFlag } from '@goodvibes/engine/platform/platform/utils';
import type { DeviceHousekeepingOptions } from '@goodvibes/engine/platform/platform/devices';

const OBSERVATION_ENABLED = envFlag(process.env['GOODVIBES_NATIVE_STARTUP_OBSERVATION']);
const observed = new Set<NativeStartupPhase>();
let stopped = false;

/**
 * The daemon's start phases, in start order: the one list. The type below is
 * derived from it, and the native execution consumer reads whichever of these
 * tokens the daemon prints, so a new phase is added here and nowhere else.
 */
export const NATIVE_STARTUP_PHASES = Object.freeze([
  'runtime-base', 'base-project-context', 'base-credentials', 'base-knowledge',
  'base-native-intake-storage', 'base-native-intake-ready', 'runtime-base-failed',
  'handler-surfaces', 'contract-recovery', 'provider-preload', 'listener-construction',
  'secondary-listener-construction', 'cluster-startup', 'device-recovery', 'device-grant-sweep',
  'device-capture-sweep', 'device-disclosure-read', 'device-disclosure-persist', 'listener-startup',
  'secondary-listener-startup', 'boot-tasks', 'foreground-ready',
] as const);

export type NativeStartupPhase = typeof NATIVE_STARTUP_PHASES[number];

/** Fixed, best-effort observations for the native execution consumer only. */
export function observeNativeStartupPhase(phase: NativeStartupPhase): void {
  if (!OBSERVATION_ENABLED || stopped || observed.has(phase)) return;
  observed.add(phase);
  try { writeSync(2, `[goodvibes-daemon:native-startup-phase] ${phase}\n`); }
  catch { stopped = true; }
}

/** The daemon passes no device observer in ordinary launches. */
export const nativeDeviceRecoveryObserver: DeviceHousekeepingOptions['observeRecovery'] = OBSERVATION_ENABLED
  ? stage => {
    switch (stage) {
      case 'grant-sweep': observeNativeStartupPhase('device-grant-sweep'); return;
      case 'capture-sweep': observeNativeStartupPhase('device-capture-sweep'); return;
      case 'disclosure-read': observeNativeStartupPhase('device-disclosure-read'); return;
      case 'disclosure-persist': observeNativeStartupPhase('device-disclosure-persist'); return;
      default: { const unreachable: never = stage; return unreachable; }
    }
  }
  : undefined;
