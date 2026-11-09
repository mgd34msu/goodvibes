import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { AudioCaptureOpener } from '@goodvibes-jev/engine/platform/platform/voice';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import { LocalStreamingAudioPlayer, type StreamingAudioPlayer } from './player.js';
import type { playActivationSound } from './activation-sound.js';
import type { TerminalWakeRuntime, TerminalWakeRuntimeDeps } from './wake-runtime.js';
import type { VoiceCaptureIndicatorKind } from '../voice-capture-status.js';
export interface VoiceCaptureBindings {
  readonly configManager: ConfigManager;
  readonly managedVoiceRoot: string;
  readonly assetDirectory: string;
  readonly sessionId: string;
  readonly writeDraft: (text: string) => void;
  readonly submitTurn: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  readonly player?: StreamingAudioPlayer | undefined;
}
export function createVoiceCapturePorts(
  deps: VoiceCaptureBindings,
  routes: {
    readonly createOpener: (options: { readonly warn: TerminalWakeRuntimeDeps['warn'] }) => AudioCaptureOpener;
    readonly resolveTranscriber: TerminalWakeRuntimeDeps['resolveTranscriber'];
  },
) {
  const readConfig = (key: string): unknown => deps.configManager.get(key as ConfigKey);
  const subscribeConfig = (key: string, listener: () => void): (() => void) => deps.configManager.subscribe(key as ConfigKey, listener);
  const warn: TerminalWakeRuntimeDeps['warn'] = (message, meta) => logger.debug(`voice capture: ${message}`, meta ?? {});
  return {
    readConfig,
    subscribeConfig,
    warn,
    openCapture: routes.createOpener({ warn }),
    resolveTranscriber: routes.resolveTranscriber,
    player: deps.player ?? new LocalStreamingAudioPlayer(),
  };
}
export function wireTerminalWakeCapture<Kind extends Extract<VoiceCaptureIndicatorKind, `wake-${string}`>>(
  deps: VoiceCaptureBindings,
  ports: ReturnType<typeof createVoiceCapturePorts>,
  runtime: {
    readonly wireWakeRuntime: (deps: TerminalWakeRuntimeDeps) => TerminalWakeRuntime<Kind>;
    readonly startWakeRuntime: (
      runtime: TerminalWakeRuntime<Kind>,
      deps: Pick<TerminalWakeRuntimeDeps, 'subscribeConfig'>,
    ) => readonly (() => void)[];
    readonly playActivationSound: typeof playActivationSound;
  },
  extra: Pick<TerminalWakeRuntimeDeps, 'ensureProvisioned' | 'enumerateInputDevices'> = {},
) {
  const wake = runtime.wireWakeRuntime({
    readConfig: ports.readConfig,
    subscribeConfig: ports.subscribeConfig,
    openCapture: ports.openCapture,
    managedRoot: deps.managedVoiceRoot,
    assetDirectory: deps.assetDirectory,
    resolveTranscriber: ports.resolveTranscriber,
    playActivationSound: (sound) => runtime.playActivationSound(sound, { player: ports.player, notify: deps.notify }),
    submitTurn: deps.submitTurn,
    writeDraft: deps.writeDraft,
    notify: deps.notify,
    render: deps.render,
    sessionId: deps.sessionId,
    warn: ports.warn,
    ...extra,
  });
  return { wake, unsubs: runtime.startWakeRuntime(wake, { subscribeConfig: ports.subscribeConfig }) };
}
/** Voice drafts share composer writes; a pending pairing prompt must first relinquish ownership. */
export function writeVoiceDraft(
  buffer: {
    prompt: string;
    cursorPos: number;
    readonly hostPairing?: { cancelForTakeover(): boolean } | null | undefined;
  },
  text: string,
  render: () => void,
): void {
  buffer.hostPairing?.cancelForTakeover();
  buffer.prompt = text;
  buffer.cursorPos = text.length;
  render();
}
