import {
  WakeListener,
  describeWakeListening,
  recordVoiceDiagnostic,
  resolveManagedWakePaths,
  resolveWakeModelFiles,
  resolveWakeRuntimeSettings,
  utteranceToAudioArtifact,
  wakeProvisionStatus,
  type AudioCaptureOpener,
  type AudioInputDeviceEnumerator,
  type CapturedUtterance,
  type UtteranceAudioArtifact,
  type WakeListenerOptions,
  type WakeListenerState,
  type WakeRuntimeSettings,
  type WakeSurfaceCapabilities,
} from '@goodvibes-jev/engine/platform/platform/voice';
import type { VoiceCaptureIndicatorKind, VoiceCaptureIndicatorState } from '../voice-capture-status.js';
import { createWakeEngineFactory } from './wake-inference.js';
import { retainWakeClip } from './retained-wake-clip.js';
export interface WakeProvisionSnapshot {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly vadReady: boolean;
}
export interface WakeRuntimeTestSeams {
  readonly loadSession: Parameters<typeof createWakeEngineFactory>[0]['loadSession'];
  readonly createNoiseSuppression: NonNullable<WakeListenerOptions['createNoiseSuppression']>;
  readonly provisionStatus: (managedRoot: string) => WakeProvisionSnapshot;
}
export interface TerminalWakeRuntimeDeps {
  readonly readConfig: (key: string) => unknown;
  readonly subscribeConfig: (key: string, listener: () => void) => () => void;
  readonly openCapture: AudioCaptureOpener;
  readonly managedRoot: string;
  readonly assetDirectory: string;
  readonly sessionId: string;
  readonly resolveTranscriber: () =>
    | {
        readonly available: true;
        readonly gateway: {
          transcribe(audio: UtteranceAudioArtifact, options?: { readonly signal?: AbortSignal } | undefined): Promise<string>;
        };
      }
    | { readonly available: false; readonly reason: string };
  readonly playActivationSound: (sound: WakeRuntimeSettings['activationSound']) => void;
  readonly submitTurn: (text: string) => void;
  readonly writeDraft: (text: string) => void;
  readonly notify: (message: string) => void;
  readonly render: () => void;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>> | undefined) => void;
  readonly ensureProvisioned?: (() => Promise<{ readonly ready: boolean; readonly message: string }>) | undefined;
  readonly enumerateInputDevices?: AudioInputDeviceEnumerator | undefined;
  readonly loadSession?: WakeRuntimeTestSeams['loadSession'] | undefined;
  readonly createNoiseSuppression?: WakeListenerOptions['createNoiseSuppression'] | undefined;
  readonly provisionStatus?: WakeRuntimeTestSeams['provisionStatus'] | undefined;
  readonly now?: (() => number) | undefined;
  readonly setTimeout?: ((handler: () => void, ms: number) => unknown) | undefined;
  readonly clearTimeout?: ((handle: unknown) => void) | undefined;
}
type WakeKind = Extract<VoiceCaptureIndicatorKind, `wake-${string}`>;
export interface TerminalWakeRuntime<Kind extends WakeKind = WakeKind> {
  refresh(): Promise<void>;
  status(): VoiceCaptureIndicatorState<Kind> | null;
  settings(): WakeRuntimeSettings;
  stop(): Promise<void>;
}
export function phaseWakeIndicator(
  _state: WakeListenerState,
  phase: WakeListenerState['phase'],
): Exclude<WakeKind, 'wake-starting' | 'wake-no-audio' | 'wake-no-microphone'> | null {
  if (phase === 'starting' || phase === 'listening') return 'wake-listening';
  if (phase === 'capturing-utterance') return 'wake-capturing';
  if (phase === 'restarting') return 'wake-restarting';
  if (phase === 'latched') return 'wake-latched';
  return null;
}
export function liveWakeIndicator(state: WakeListenerState): WakeKind | null {
  const claim = describeWakeListening(state);
  if (claim.kind === 'listening') return state.phase === 'capturing-utterance' ? 'wake-capturing' : 'wake-listening';
  if (claim.kind === 'starting') return 'wake-starting';
  if (claim.kind === 'no-audio') return 'wake-no-audio';
  if (state.phase === 'restarting') return 'wake-restarting';
  if (state.phase === 'latched') return 'wake-latched';
  if (state.deviceBinding?.state === 'no-microphone') return 'wake-no-microphone';
  return null;
}
/** One owned listener/transcription lifetime, with product provisioning and display policies. */
export function createTerminalWakeRuntime<Kind extends WakeKind>(policy: {
  readonly surface: Parameters<typeof resolveWakeRuntimeSettings>[1];
  readonly capabilities: (provision: Pick<WakeProvisionSnapshot, 'vadReady'>) => WakeSurfaceCapabilities;
  readonly indicator: (state: WakeListenerState, phase: WakeListenerState['phase']) => Kind | null;
  readonly refusalKind: (refusal: string) => Kind | null;
  readonly liveStatus: boolean;
  readonly diagnostics: boolean;
  readonly provisionOnEnable: boolean;
  readonly missingModels: (reason: string) => string;
  readonly draftNotice: string;
  readonly captureFailure: (error: string, detail: string) => string;
  readonly describeBlockers: (settings: WakeRuntimeSettings) => readonly string[];
  readonly describeLimitations: (settings: WakeRuntimeSettings) => readonly string[];
  readonly describeTranscriptionFailure: (error: unknown) => string;
}) {
  function wireWakeRuntime(deps: TerminalWakeRuntimeDeps): TerminalWakeRuntime<Kind> {
    let listener: WakeListener | null = null;
    let lifetime: AbortController | null = null;
    let starting: Promise<void> | null = null;
    let epoch = 0;
    let startingEpoch = 0;
    let phase: WakeListenerState['phase'] = 'idle';
    let deviceLabel: string | null = null;
    let detail: string | undefined;
    let vadReady = false;
    let refusal: { readonly kind: Kind; readonly message: string } | null = null;
    const readProvision = () => (deps.provisionStatus ?? ((root) => wakeProvisionStatus({ managedRoot: root })))(deps.managedRoot);
    const resolve = (): WakeRuntimeSettings =>
      resolveWakeRuntimeSettings(deps.readConfig, policy.surface, policy.capabilities(policy.liveStatus ? { vadReady } : readProvision()));
    const diagnostic = (ok: boolean, operation: string, error: string | undefined, message: string): void => {
      if (!policy.diagnostics) return;
      recordVoiceDiagnostic(deps.managedRoot, {
        at: new Date().toISOString(),
        operation,
        route: 'in-process',
        ok,
        provider: 'wake capture',
        configSource: `voice.wake.inputDevice=${String(deps.readConfig('voice.wake.inputDevice') ?? '') || '(system default)'}, voice.wake.captureCommand=${String(deps.readConfig('voice.wake.captureCommand') ?? 'auto')}`,
        ...(error !== undefined ? { error } : {}),
        detail: message,
      });
    };
    const transcribe = async (utterance: CapturedUtterance, settings: WakeRuntimeSettings, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      if (settings.retainAudio === 'session-temp') retainWakeClip(deps, utterance);
      if (utterance.silent) {
        deps.notify('[Wake] Heard the wake phrase but nothing above the silence floor followed it.');
        deps.render();
        return;
      }
      const resolution = deps.resolveTranscriber();
      if (!resolution.available) {
        deps.notify(`[Wake] Captured the utterance after the wake phrase but could not transcribe it: ${resolution.reason}`);
        if (policy.diagnostics)
          recordVoiceDiagnostic(deps.managedRoot, {
            at: new Date().toISOString(),
            operation: 'wake-transcribe',
            route: 'none',
            ok: false,
            provider: 'none',
            configSource: 'no speech-to-text route resolved on this surface',
            error: resolution.reason,
          });
        deps.render();
        return;
      }
      try {
        const text = (await resolution.gateway.transcribe(utteranceToAudioArtifact(utterance), { signal })).trim();
        if (signal.aborted) return;
        if (!text.length) {
          deps.notify('[Wake] Speech-to-text returned no words for what followed the wake phrase.');
          deps.render();
          return;
        }
        if (settings.autoSubmit) deps.submitTurn(text);
        else {
          deps.writeDraft(text);
          deps.notify(policy.draftNotice);
          deps.render();
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = policy.describeTranscriptionFailure(error);
        deps.notify(`[Wake] Transcription failed: ${message}`);
        if (policy.diagnostics)
          recordVoiceDiagnostic(deps.managedRoot, {
            at: new Date().toISOString(),
            operation: 'wake-transcribe',
            route: 'none',
            ok: false,
            provider: 'every available route',
            configSource: "this surface's resolved speech-to-text routes",
            error: message,
          });
        deps.render();
      }
    };
    const start = async (initialSettings: WakeRuntimeSettings, provision: WakeProvisionSnapshot): Promise<void> => {
      const controller = new AbortController();
      lifetime = controller;
      const owned = () => lifetime === controller && !controller.signal.aborted;
      let settings = initialSettings;
      if (!provision.ready) {
        if (!policy.provisionOnEnable || !deps.ensureProvisioned) {
          deps.notify(policy.missingModels(provision.reason ?? 'not-provisioned'));
          deps.render();
          return;
        }
        deps.notify('[Wake] The wake models are not on this host yet, fetching and verifying them now.');
        deps.render();
        const outcome = await deps.ensureProvisioned();
        if (!owned()) return;
        deps.notify(`[Wake] ${outcome.message}`);
        if (!outcome.ready) {
          deps.render();
          return;
        }
        const after = readProvision();
        vadReady = after.vadReady;
        if (!after.ready) {
          deps.notify(
            `[Wake] The wake models still do not verify on disk (${after.reason ?? 'not-provisioned'}), so nothing is listening.`,
          );
          deps.render();
          return;
        }
        settings = resolve();
        if (!settings.active || !owned()) return;
      }
      const paths = resolveManagedWakePaths(deps.managedRoot);
      const models = resolveWakeModelFiles(settings.modelIds, { managedRoot: deps.managedRoot, customModelDir: settings.customModelDir });
      const unpinned = models.filter((model) => !model.pinned);
      if (unpinned.length)
        deps.notify(
          `[Wake] Loading ${unpinned.length} custom model${unpinned.length === 1 ? '' : 's'} that ${unpinned.length === 1 ? 'is' : 'are'} not checksum-pinned: ${unpinned.map((model) => `${model.id} (${model.path})`).join(', ')}`,
        );
      const current = () => owned() && listener === active;
      const active = new WakeListener({
        settings,
        openCapture: deps.openCapture,
        createEngine: createWakeEngineFactory({
          assetDirectory: deps.assetDirectory,
          embeddingPath: paths.embeddingPath,
          models: models.map((model) => ({ id: model.id, path: model.path })),
          vad: { path: paths.vadPath, ready: vadReady },
          settings,
          warn: deps.warn,
          ...(deps.loadSession !== undefined ? { loadSession: deps.loadSession } : {}),
        }),
        ...(deps.createNoiseSuppression !== undefined ? { createNoiseSuppression: deps.createNoiseSuppression } : {}),
        recordDiagnostic: (entry) => recordVoiceDiagnostic(deps.managedRoot, entry),
        handlers: {
          onStateChange(state) {
            if (!current()) return;
            phase = state.phase;
            deviceLabel = state.deviceLabel;
            if (state.phase === 'latched') detail = state.latchReason ?? undefined;
            deps.render();
          },
          onWake(event) {
            if (!current()) return;
            deps.playActivationSound(event.activationSound);
            deps.render();
          },
          onUtterance(utterance) {
            if (current()) void transcribe(utterance, settings, controller.signal);
          },
          ...(policy.diagnostics
            ? {
                onDeviceBinding(binding: NonNullable<WakeListenerState['deviceBinding']>) {
                  if (!current()) return;
                  if (binding.state !== 'pinned' && binding.state !== 'default') {
                    deps.notify(`[Wake] ${binding.message}`);
                    diagnostic(binding.usable, 'wake-input-device', undefined, binding.message);
                  } else if (binding.state === 'pinned') deps.notify(`[Wake] ${binding.message}`);
                  deps.render();
                },
              }
            : {}),
          onFailure(error, restarting, failureDetail) {
            if (!current()) return;
            detail = failureDetail;
            diagnostic(false, 'wake-capture', error.message, failureDetail);
            deps.notify(
              restarting
                ? policy.captureFailure(error.message, failureDetail)
                : `[Wake] The wake-word detector stopped: ${failureDetail}. It stays off until voice.wake.enabled is turned off and on again.`,
            );
            deps.render();
          },
        },
        warn: deps.warn,
        ...(deps.enumerateInputDevices !== undefined ? { enumerateInputDevices: deps.enumerateInputDevices } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.setTimeout !== undefined ? { setTimeout: deps.setTimeout } : {}),
        ...(deps.clearTimeout !== undefined ? { clearTimeout: deps.clearTimeout } : {}),
      });
      listener = active;
      let outcome: Awaited<ReturnType<WakeListener['start']>>;
      try {
        outcome = await active.start();
      } catch (error) {
        // A start that throws must not leave `listener` set: refresh() returns
        // early while one is, so nothing would ever start again.
        const message = error instanceof Error ? error.message : String(error);
        const stillOurs = lifetime === controller;
        if (stillOurs) {
          controller.abort();
          lifetime = null;
          listener = null;
          phase = 'idle';
          deviceLabel = null;
          detail = undefined;
          refusal = null;
        }
        await active.stop().catch(() => undefined);
        if (stillOurs) {
          diagnostic(false, 'wake-capture-start', message, 'the wake detector failed while starting');
          deps.notify(`[Wake] The wake-word detector failed while starting: ${message}`);
          deps.render();
        }
        return;
      }
      // A delayed opener cannot regain ownership after stop or a replacement start.
      if (!current()) {
        await active.stop();
        return;
      }
      if (!outcome.started) {
        controller.abort();
        lifetime = null;
        listener = null;
        phase = 'idle';
        const kind = policy.refusalKind(outcome.refusal);
        refusal = kind ? { kind, message: outcome.detail } : null;
        diagnostic(false, 'wake-capture-start', outcome.detail, `the wake detector did not start (${outcome.refusal})`);
        deps.notify(`[Wake] The wake-word detector did not start (${outcome.refusal}): ${outcome.detail}`);
      } else {
        refusal = null;
        const limitations = policy.describeLimitations(settings);
        if (limitations.length)
          deps.notify([`[Wake] Listening on ${outcome.deviceLabel}, with these rows not in force:`, ...limitations].join('\n'));
      }
      deps.render();
    };
    const stop = async (): Promise<void> => {
      const active = listener;
      epoch++;
      // Retired model loads may ignore cancellation. They keep their own cleanup,
      // but must not block a replacement listener from starting.
      starting = null;
      lifetime?.abort();
      lifetime = null;
      listener = null;
      phase = 'idle';
      deviceLabel = null;
      detail = undefined;
      // A refusal belongs to the start that was refused; once wake is stopped
      // there is nothing left for the status chip to explain.
      refusal = null;
      if (active) await active.stop();
    };
    const refreshNow = async (): Promise<void> => {
      const provision = readProvision();
      vadReady = provision.vadReady;
      const settings = resolve();
      if (!settings.active) {
        await stop();
        if (settings.enabled && settings.surfaceEnabled && settings.blockers.length)
          deps.notify(['[Wake] The wake-word detector cannot start:', ...policy.describeBlockers(settings)].join('\n'));
        deps.render();
        return;
      }
      if (listener) return;
      if (starting) {
        const ownerEpoch = startingEpoch;
        await starting;
        if (ownerEpoch !== epoch && !listener && resolve().active) await runtime.refresh();
        return;
      }
      startingEpoch = epoch;
      const pending = start(settings, provision);
      starting = pending;
      try {
        await pending;
      } finally {
        if (starting === pending) starting = null;
      }
    };
    // refresh() runs from config subscriptions with nobody awaiting it, so a
    // failure has to surface as a notice and a diagnostic rather than escape.
    const reportRefreshFailure = (error: unknown): void => {
      const message = error instanceof Error ? error.message : String(error);
      diagnostic(false, 'wake-refresh', message, 'refreshing the wake runtime failed');
      deps.notify(`[Wake] Could not apply the wake settings: ${message}`);
      deps.render();
    };
    const runtime: TerminalWakeRuntime<Kind> = {
      async refresh() {
        try {
          await refreshNow();
        } catch (error) {
          reportRefreshFailure(error);
        }
      },
      status() {
        if (!listener)
          return refusal ? { kind: refusal.kind, deviceLabel: null, indicator: resolve().indicator, detail: refusal.message } : null;
        const state = listener.state();
        const kind = policy.indicator(state, phase);
        if (!kind) return null;
        return {
          kind,
          deviceLabel,
          indicator: resolveWakeRuntimeSettings(deps.readConfig, policy.surface).indicator,
          ...(policy.liveStatus ? { detail: describeWakeListening(state).message } : detail !== undefined ? { detail } : {}),
        };
      },
      settings: resolve,
      stop,
    };
    return runtime;
  }
  function startWakeRuntime(
    runtime: TerminalWakeRuntime<Kind>,
    deps: Pick<TerminalWakeRuntimeDeps, 'subscribeConfig'>,
  ): readonly (() => void)[] {
    const apply = (): void => {
      void runtime.refresh();
    };
    const unsubs = [
      deps.subscribeConfig('voice.wake.enabled', apply),
      deps.subscribeConfig(`voice.wake.surfaces.${policy.surface}`, apply),
      () => {
        void runtime.stop();
      },
    ];
    apply();
    return unsubs;
  }
  return { wireWakeRuntime, startWakeRuntime };
}
