import {
  createTerminalWakeRuntime,
  liveWakeIndicator,
  type TerminalWakeRuntime,
  type TerminalWakeRuntimeDeps,
} from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
import { agentWakeCapabilities, describeWakeBlockers, describeWakeLimitations } from '../core/wake-provision-status.ts';
import { describeTranscriptionFailure } from '../core/voice-stt-gateway.ts';
import type { VoiceCaptureIndicatorKind } from '../core/voice-capture-status.ts';
import { AGENT_WAKE_SURFACE } from './wake-surface.ts';
export { AGENT_WAKE_SURFACE } from './wake-surface.ts';
export type { WakeRuntimeTestSeams } from '@goodvibes-jev/engine/terminal-shell/audio/wake-runtime';
export type WakeRuntimeDeps = TerminalWakeRuntimeDeps;
export type WakeRuntime = TerminalWakeRuntime<VoiceCaptureIndicatorKind>;
/** Agent keeps automatic provisioning, live capture-truth indicators and device diagnostics. */
export const { wireWakeRuntime, startWakeRuntime } = createTerminalWakeRuntime({
  surface: AGENT_WAKE_SURFACE,
  capabilities: agentWakeCapabilities,
  indicator: liveWakeIndicator,
  refusalKind: (refusal) => (refusal === 'no-microphone' ? 'wake-no-microphone' : 'wake-latched'),
  liveStatus: true,
  diagnostics: true,
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
