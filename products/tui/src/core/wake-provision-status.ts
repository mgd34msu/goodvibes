import { createWakeProvisionPresentation } from '@goodvibes-jev/engine/terminal-shell/audio/wake-provision-presentation';
// ---------------------------------------------------------------------------
// wake-provision-status.ts, the surface-facing projection of wake-word
// provisioning and of the rows that are or are not in force.
//
// The wake models are checksum-pinned and arrive WITH THE INSTALLATION: the
// installer and the npm postinstall provision them, and a daemon retries at boot
// whatever the install could not fetch. `/voice wake setup` is the recovery act
// for the case where that did not land, not the normal way in, so the lines
// below name it where it helps and do not imply it is a required step.
//
// This module is the read-only projection the /voice wake surfaces render from:
// per-artifact present / verified / corrupt / bytes taken straight from the SDK's
// wakeProvisionStatus, which verifies by CONTENT rather than by existence, a
// truncated or wrong-asset file reports corrupt instead of present, because a
// detector loading it would fail in a way the user could not diagnose.
//
// Pure formatting only (no I/O), mirroring voice-provision-status.ts: the command
// layer fetches the status and hands it here, so these builders are testable
// against fixture shapes.
// ---------------------------------------------------------------------------

import type { WakeProvisionStatus, WakeSurfaceCapabilities } from '@goodvibes-jev/engine/sdk/platform/voice';
import { noiseSuppressionSupport } from '@goodvibes-jev/engine/sdk/platform/voice/capture';
import { formatVoiceBytes } from './voice-provision-status.ts';

/**
 * What a terminal can actually do, so a `voice.wake.*` row is refused or reported
 * rather than faked. Lives here, beside the status projection and away from the
 * inference runtime, so the command layer can resolve settings without pulling
 * onnxruntime into a `/voice wake status` call.
 */
export function terminalWakeCapabilities(status?: Pick<WakeProvisionStatus, 'vadReady'>): WakeSurfaceCapabilities {
  return {
    // Asked of the SDK rather than declared here. The filter is a WebAssembly
    // module carried in the package, so the only question is whether this runtime
    // has WebAssembly at all, which the SDK answers, with a reason a settings
    // surface can show. A host constant would go stale the moment the stage
    // shipped, which is exactly what happened to the previous one.
    speexAvailable: noiseSuppressionSupport().supported,
    // The speech gate needs its own provisioned model, so this follows what is
    // VERIFIED ON DISK rather than what the build is capable of: with the artifact
    // missing, `voice.wake.vadThreshold` above 0 still blocks startup and says so.
    vadAvailable: status?.vadReady === true,
    // A terminal has a filesystem (retainAudio) and an audio player (a custom
    // activation sound file).
    canRetainAudio: true,
    canPlayLocalFile: true,
  };
}

/** One artifact's line: what is on disk, verified by content. */

/**
 * Blockers, in the SDK's own words. A blocker means the detector must NOT start,
 * so the row's key and the written reason are both shown, a swallowed blocker is
 * a user staring at a feature that is on and doing nothing.
 */

/** Limitations: the detector runs, with one row not in force, and says which. */

/** The `/voice wake status` block. */

/** The `/voice wake setup` receipt. */

/** The one-line announcement printed before a (multi-megabyte) provision runs. */
export const WAKE_SETUP_ANNOUNCEMENT = [
  'Wake-Word Setup',
  '  downloading the pinned "hey goodvibes" classifier (both runtime formats), the shared speech-embedding front end, and the speech gate voice.wake.vadThreshold runs…',
  '  every artifact is checksum-verified and the download is resumable; one that already matches is skipped, so re-running this only fetches what is missing.',
  '  installing goodvibes normally does this for you; running it by hand is how you recover an install that could not reach the network.',
].join('\n');

export const { wakeArtifactLine, describeWakeBlockers, describeWakeLimitations, wakeStatusLines, wakeProvisionReceiptLines } =
  createWakeProvisionPresentation({
    surface: 'tui',
    noun: 'terminal',
    formatBytes: formatVoiceBytes,
    corruptSuffix: '; torn, truncated, or the wrong asset; /voice wake setup replaces it',
    artifacts: (status, line) => [
      line('classifier', status.classifier),
      line('speech-embedding front end', status.embedding),
      line('attribution NOTICE (classifier)', status.notice),
      line('attribution NOTICE (front end)', status.embeddingNotice),
      `${line('classifier, tflite form (served to other runtimes; unused here)', status.mobileClassifier)}`,
      `  speech gate provisioned: ${status.vadReady ? 'yes' : 'no; voice.wake.vadThreshold above 0 will refuse to start'}`,
      line('speech gate', status.vad),
      line('attribution NOTICE (speech gate)', status.vadNotice),
    ],
    download: (status) => [
      `  a fresh provision would download ${formatVoiceBytes(status.downloadBytes)}. Installing goodvibes normally does this,`,
      '  and a running daemon retries at boot; run /voice wake setup to fetch it now (nothing downloads on its own).',
    ],
    extraSettings: () => [],
    receiptHeader: (result) => [
      `  tflite form (for runtimes that cannot load onnx): ${result.mobileFormatReady ? 'installed' : 'not installed; nothing on this terminal needs it'}`,
      `  speech gate (voice.wake.vadThreshold): ${result.vadReady ? 'installed' : 'not installed; voice.wake.vadThreshold above 0 will refuse to start'}`,
    ],
    failureSeparator: ': ',
    embeddingNotice: true,
  });
