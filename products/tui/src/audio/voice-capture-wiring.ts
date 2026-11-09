import { createVoiceCapturePorts, wireTerminalWakeCapture } from '@goodvibes-jev/engine/terminal-shell/audio/voice-capture-composition';
/**
 * voice-capture-wiring.ts, composes the terminal's two voice consumers over ONE
 * capture path.
 *
 * Push-to-talk and wake detection are not two audio stacks. They share the
 * opener built here (capture.ts), the transcription gateway (core/voice-stt-gateway.ts)
 * and the same `voice.wake.*` capture rows, device, recorder, noise
 * suppression, ceiling, so a device that works for one works for the other and
 * a change in /settings applies to both.
 *
 * This is the composition root the shell calls once. It owns nothing the shell
 * does not hand it: the composer draft, the turn submission, the message router
 * and the render request all arrive as callbacks, which is what keeps this file
 * out of the shell-UI layers the architecture check bars src/audio from importing.
 */

import '@goodvibes-jev/engine/platform/platform/utils';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { VoiceCaptureIndicatorState } from '../core/voice-capture-status.ts';
import { createTuiCaptureOpener } from './capture.ts';
import { playActivationSound } from './activation-sound.ts';
import './player.ts';
import type { StreamingAudioPlayer } from './player.ts';
import { createVoiceSttGateway } from '../core/voice-stt-gateway.ts';
import { wireVoiceInputRuntime } from './voice-input-session.ts';
import { startWakeRuntime, wireWakeRuntime } from './wake-runtime.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';

export interface VoiceCaptureWiringDeps {
  readonly configManager: ConfigManager;
  /** `<root>/voice`, the managed root the wake tree hangs off (same root /voice setup uses). */
  readonly managedVoiceRoot: string;
  /** A directory this surface owns for the extracted onnxruntime assets. */
  readonly assetDirectory: string;
  readonly homeDirectory: string | (() => string);
  /** Names retained clips so the platform's sweeper can reap them when the session ends. */
  readonly sessionId: string;
  /** Writes recognised text into the composer draft. */
  readonly writeDraft: (text: string) => void;
  readonly readDraftRevision?: () => unknown;
  /** Submits recognised text as a turn (`voice.wake.autoSubmit` on). */
  readonly submitTurn: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  /** Injected in tests; defaults to a real streaming player for the activation sound. */
  readonly player?: StreamingAudioPlayer;
}

export interface VoiceCaptureWiring {
  /** The Alt+V action: start recording, or stop and transcribe. */
  readonly toggleVoiceInput: () => void;
  /**
   * The live footer row. A push-to-talk recording OUTRANKS the wake row: the user
   * pressed a key and is waiting on that one, while the detector's row describes a
   * standing condition they already know about.
   */
  readonly status: () => VoiceCaptureIndicatorState | null;
  /** Teardown, for the shell's `unsubs` registry, releases any open device. */
  readonly unsubs: readonly (() => void | Promise<void>)[];
}

/** Compose voice input and wake detection. Opens no device by itself. */
export function wireVoiceCapture(deps: VoiceCaptureWiringDeps): VoiceCaptureWiring {
  const ports = createVoiceCapturePorts(deps, {
    createOpener: createTuiCaptureOpener,
    resolveTranscriber: () => createVoiceSttGateway({ configManager: deps.configManager, homeDirectory: deps.homeDirectory }),
  });
  const voiceInput = wireVoiceInputRuntime({
    openCapture: ports.openCapture,
    readSettings: () => {
      const { capture, captureMaxSeconds, indicator } = resolveWakeRuntimeSettings(ports.readConfig, 'tui');
      return { capture, captureMaxSeconds, indicator };
    },
    resolveTranscriber: ports.resolveTranscriber,
    writeDraft: deps.writeDraft,
    readDraftRevision: deps.readDraftRevision,
    notify: deps.notify,
    render: deps.render,
  });
  const { wake, unsubs } = wireTerminalWakeCapture(deps, ports, { wireWakeRuntime, startWakeRuntime, playActivationSound }, {});
  return {
    toggleVoiceInput: voiceInput.toggle,
    status: () => voiceInput.status() ?? wake.status(),
    unsubs: [...unsubs, () => voiceInput.release()],
  };
}
