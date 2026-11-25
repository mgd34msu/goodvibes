// ---------------------------------------------------------------------------
// voice-provision-status.ts, the shapes of the managed local-voice runtime's
// answers (voice.local.status / voice.local.install) and the byte size words
// the wake word's and the voice settings' views print.
//
// The runtime, its install's steps and its receipt are shown in words by the
// System place's Voice tab (platform capabilities/builtin/system.ts
// `voiceRuntimeWords`), the same for every program and the web UI.
// ---------------------------------------------------------------------------

import type { OperatorMethodOutput } from '@goodvibes/engine/platform';

/** voice.local.status output, the no-network installed/available snapshot. */
export type VoiceRuntimeStatusResult = OperatorMethodOutput<'voice.local.status'>;
/**
 * The one-act install receipt. voice.local.install answers at once with the run
 * it started; the receipt is read from voice.local.status as `lastInstall` once
 * the run ends.
 */
export type VoiceLocalInstallResult = NonNullable<NonNullable<VoiceRuntimeStatusResult['lastInstall']>['receipt']>;

/** Human byte size (mirrors the local formatBytes idiom used across the renderer). */
export function formatVoiceBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
