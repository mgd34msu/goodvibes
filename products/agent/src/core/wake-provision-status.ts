import { createWakeProvisionPresentation } from '@goodvibes-jev/engine/terminal-shell/audio/wake-provision-presentation';
// ---------------------------------------------------------------------------
// wake-provision-status.ts, the surface-facing projection of wake-word
// provisioning and of the `voice.wake.*` rows that are or are not in force.
//
// The wake artifacts are checksum-pinned and provisioned ONLY by an explicit act
// (/voice wake setup). This module is the read-only projection those surfaces
// render from: per-artifact present / verified / corrupt / bytes taken straight
// from the SDK's wakeProvisionStatus, which verifies by CONTENT rather than by
// existence, a truncated or wrong-asset file reports corrupt instead of present,
// because a detector loading it would fail in a way the user could not diagnose.
//
// Pure formatting only (no I/O): the command layer fetches the status and hands
// it here, so every builder is testable against fixture shapes.
// ---------------------------------------------------------------------------

import type { WakeSurfaceCapabilities } from '@goodvibes-jev/engine/sdk/platform/voice';
import { resolveWakeVadThreshold, WAKE_VAD_MODEL } from '@goodvibes-jev/engine/sdk/platform/voice';
import { SPEEXDSP_PREPROCESS } from '@goodvibes-jev/engine/sdk/platform/voice/capture';

/**
 * What the configured gate threshold does, in the head's own measured numbers.
 *
 * Read from the pinned manifest rather than described in prose here: a threshold
 * whose trade-off a surface states from memory is a number that goes stale the
 * first time the head is retrained.
 */
function vadThresholdNote(threshold: number): string {
  const row = resolveWakeVadThreshold(threshold);
  if (row === null) return '';
  return (
    ` (at ${row.threshold} it passes ${(row.speechPassRate * 100).toFixed(1)}% of speech frames` +
    ` and stops ${(row.noiseGateRate * 100).toFixed(1)}% of non-speech ones)`
  );
}

/**
 * Bytes as a short human string.
 *
 * Local because this repository has no shared byte formatter, `/voice status`
 * divides by 1024*1024 inline at its call site, and the file tree has its own.
 * One place for the wake surfaces beats a third inline division.
 */
export function formatWakeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What THIS surface can actually do, so a `voice.wake.*` row is refused or
 * reported rather than faked.
 *
 * Lives here, beside the status projection and away from the inference runtime,
 * so `/voice wake status` can resolve settings without pulling onnxruntime into a
 * status call.
 */
export function agentWakeCapabilities(options: { readonly vadReady: boolean }): WakeSurfaceCapabilities {
  return {
    // speexAvailable is DELIBERATELY OMITTED, not passed as a boolean. The
    // platform carries SpeexDSP's preprocessor as a WebAssembly module and
    // WakeListener wraps this surface's opener with it, so the honest answer is
    // "does this runtime have WebAssembly", which the SDK asks itself. Asserting
    // `true` here would claim a filter this file cannot see running, and `false`
    // would refuse a filter that does run.
    //
    // The speech gate is the opposite shape and stays host-declared: the artifact
    // is provisioned, but LOADING an inference session is this surface's job, so
    // `true` means this host has the gate on disk AND wires its session into the
    // engine. wireWakeRuntime derives this from the same provision read that
    // decides whether to load it, so the claim and the wiring cannot disagree,
    // and below 1.0 on either count, `voice.wake.vadThreshold` above 0 is refused
    // rather than letting frames reach the classifier unscreened.
    vadAvailable: options.vadReady,
    // This process has a filesystem (voice.wake.retainAudio) and an audio player
    // (a custom activation-sound file). A host with neither mpv nor ffplay still
    // reports that at the moment of a wake rather than here, the capability is
    // "this surface can read and play a local path", not "a player is installed".
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
  '  downloading the pinned "hey goodvibes" classifier and the shared speech-embedding front end…',
  '  both are checksum-verified and the download is resumable, so a failed component is retried rather than restarted.',
].join('\n');

export const { wakeArtifactLine, describeWakeBlockers, describeWakeLimitations, wakeStatusLines, wakeProvisionReceiptLines } =
  createWakeProvisionPresentation({
    surface: 'agent',
    noun: 'surface',
    formatBytes: formatWakeBytes,
    corruptSuffix: ': torn, truncated, or the wrong asset; the next provision replaces it',
    artifacts: (status, line) => [
      line('classifier', status.classifier),
      line('speech-embedding front end', status.embedding),
      line('attribution NOTICE', status.notice),
      line('speech gate (voice.wake.vadThreshold)', status.vad),
      line('speech-gate NOTICE', status.vadNotice),
    ],
    download: (status) => [
      `  a fresh provision would download ${formatWakeBytes(status.downloadBytes)}, fetched automatically when wake detection is turned on`,
    ],
    extraSettings: (status, settings) => [
      `  noise suppression: voice.wake.noiseSuppression=${settings.capture.noiseSuppression}` +
        `${settings.capture.noiseSuppression === 'speex' ? ` (${SPEEXDSP_PREPROCESS.component} ${SPEEXDSP_PREPROCESS.version}, ${SPEEXDSP_PREPROCESS.license}, carried in the package, nothing to install)` : ''}`,
      `  speech gate: voice.wake.vadThreshold=${settings.vadThreshold}` +
        `${
          settings.vadThreshold === 0
            ? ' (0 = every frame reaches the classifier, which is the shipped default)'
            : status.vadReady
              ? `, screening frames with goodvibes-vad ${WAKE_VAD_MODEL.version}${vadThresholdNote(settings.vadThreshold)}`
              : `, but the gate is not on disk, so the detector refuses to start rather than leaving frames unscreened; it is fetched with the other wake artifacts (goodvibes-vad ${WAKE_VAD_MODEL.version}${vadThresholdNote(settings.vadThreshold)})`
        }` +
        `, gate on disk: ${status.vadReady ? 'yes' : 'no'}`,
    ],
    receiptHeader: () => [],
    failureSeparator: ', ',
    embeddingNotice: false,
  });
