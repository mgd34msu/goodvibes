import {
  createTerminalWakeRuntime,
  type TerminalWakeRuntime,
  type TerminalWakeRuntimeDeps,
} from '@goodvibes/engine/terminal-shell/audio/wake-runtime';
import { describeWakeBlockers, describeWakeLimitations, terminalWakeCapabilities } from '../core/wake-provision-status.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';
export type { WakeProvisionSnapshot, WakeRuntimeTestSeams } from '@goodvibes/engine/terminal-shell/audio/wake-runtime';
/** TUI enablement remains read-only: provisioning is an explicit install/setup act. */
export type WakeRuntimeDeps = Omit<TerminalWakeRuntimeDeps, 'ensureProvisioned'>;
export type WakeRuntime = TerminalWakeRuntime;
export const { wireWakeRuntime, startWakeRuntime } = createTerminalWakeRuntime({
  surface: 'tui',
  capabilities: terminalWakeCapabilities,
  provisionOnEnable: false,
  missingModels: (reason) =>
    `[Wake] Wake detection is on, but the wake models are not on this computer yet (${reason}), ` +
    'so nothing is listening. The download has not succeeded yet; the daemon tries again at its next start, and /voice wake-setup fetches and checks them now.',
  draftNotice: '[Wake] What you said was added to the composer; press Enter to send it ("Send a spoken request without review" is off).',
  captureFailure: (error, detail) => `[Wake] The capture stream ended (${error}): ${detail}.`,
  describeBlockers: describeWakeBlockers,
  describeLimitations: describeWakeLimitations,
  describeTranscriptionFailure,
});
