import {
  createTerminalWakeRuntime,
  type TerminalWakeRuntime,
  type TerminalWakeRuntimeDeps,
} from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
import { agentWakeCapabilities, describeWakeBlockers, describeWakeLimitations } from '../core/wake-provision-status.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';
import { AGENT_WAKE_SURFACE } from './wake-surface.ts';
export { AGENT_WAKE_SURFACE } from './wake-surface.ts';
export type { WakeRuntimeTestSeams } from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
export type WakeRuntimeDeps = TerminalWakeRuntimeDeps;
export type WakeRuntime = TerminalWakeRuntime;
/** Agent keeps automatic provisioning: enabling wake fetches and verifies missing models. */
export const { wireWakeRuntime, startWakeRuntime } = createTerminalWakeRuntime({
  surface: AGENT_WAKE_SURFACE,
  capabilities: agentWakeCapabilities,
  provisionOnEnable: true,
  missingModels: (reason) =>
    `[Wake] Wake detection is on, but the wake models are not on this host (${reason}), ` +
    'and this surface has no provisioner wired, so nothing is listening.',
  draftNotice: '[Wake] Transcript placed in the composer (voice.wake.autoSubmit is off, press Enter to send it).',
  captureFailure: (error, detail) => `[Wake] The capture stream ended (${error}), ${detail}.`,
  describeBlockers: describeWakeBlockers,
  describeLimitations: describeWakeLimitations,
  describeTranscriptionFailure,
});
