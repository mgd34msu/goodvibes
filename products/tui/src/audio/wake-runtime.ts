import {
  createTerminalWakeRuntime,
  phaseWakeIndicator,
  type TerminalWakeRuntime,
  type TerminalWakeRuntimeDeps,
} from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
import { describeWakeBlockers, describeWakeLimitations, terminalWakeCapabilities } from '../core/wake-provision-status.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';
import type { VoiceCaptureIndicatorKind } from '../core/voice-capture-status.ts';
export type { WakeProvisionSnapshot, WakeRuntimeTestSeams } from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
/** TUI enablement remains read-only: provisioning is an explicit install/setup act. */
export type WakeRuntimeDeps = Omit<TerminalWakeRuntimeDeps, 'ensureProvisioned' | 'enumerateInputDevices'>;
export type WakeRuntime = TerminalWakeRuntime<Extract<VoiceCaptureIndicatorKind, `wake-${string}`>>;
export const { wireWakeRuntime, startWakeRuntime } = createTerminalWakeRuntime({
  surface: 'tui',
  capabilities: terminalWakeCapabilities,
  indicator: phaseWakeIndicator,
  refusalKind: () => null,
  liveStatus: false,
  diagnostics: false,
  provisionOnEnable: false,
  missingModels: (reason) =>
    `[Wake] voice.wake.enabled is on, but the wake models are not provisioned (${reason}), ` +
    'so nothing is listening. Installing goodvibes provisions them and a running daemon retries at boot, so this ' +
    'means the download has not succeeded yet; run /voice wake setup to fetch and verify them now.',
  draftNotice: '[Wake] Transcript placed in the composer (voice.wake.autoSubmit is off: press Enter to send it).',
  captureFailure: (error, detail) => `[Wake] The capture stream ended (${error}): ${detail}.`,
  describeBlockers: describeWakeBlockers,
  describeLimitations: describeWakeLimitations,
  describeTranscriptionFailure,
});
