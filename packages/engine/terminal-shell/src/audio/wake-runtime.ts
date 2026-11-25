import {
  WAKE_SETTING_KEYS,
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
} from '@goodvibes/engine/platform/platform/voice';
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
export type WakeKind = Extract<VoiceCaptureIndicatorKind, `wake-${string}`>;
export interface TerminalWakeRuntime {
  refresh(): Promise<void>;
  status(): VoiceCaptureIndicatorState<WakeKind> | null;
  settings(): WakeRuntimeSettings;
  stop(): Promise<void>;
  /** Wake is on but nothing listens: its listener stopped itself, or its start was refused. */
  stopped(): boolean;
  /** The running listener stopped itself after its own restarts failed (not a refused start). */
  gaveUp(): boolean;
  /**
   * Start listening again after it stopped itself: the one "listen again" action, also run by
   * itself when the terminal regains focus or the wake input device setting changes. Says what
   * happened, in one sentence.
   */
  listenAgain(): Promise<string>;
}
/**
 * A listener that stopped itself (a start stall, a restart that could not load
 * its models, an unreadable recorder failure) sits idle with the reason in
 * `lastError`. Wake is still enabled, so that must not look like "wake off":
 * it shows as the stopped chip until it starts again (focus regained, the input
 * device setting changed, or /voice wake-again).
 */
function stoppedWithReason(state: WakeListenerState, phase: WakeListenerState['phase']): boolean {
  return phase === 'idle' && state.lastError !== null;
}
/** The wake chip, derived only from capture truth (a stream open, frames arriving), never from intent. */
export function liveWakeIndicator(state: WakeListenerState): WakeKind | null {
  const claim = describeWakeListening(state);
  if (claim.kind === 'listening') return state.phase === 'capturing-utterance' ? 'wake-capturing' : 'wake-listening';
  if (claim.kind === 'starting') return 'wake-starting';
  if (claim.kind === 'no-audio') return 'wake-no-audio';
  if (state.phase === 'restarting') return 'wake-restarting';
  if (state.phase === 'latched') return 'wake-latched';
  if (state.deviceBinding?.state === 'no-microphone') return 'wake-no-microphone';
  if (stoppedWithReason(state, state.phase)) return 'wake-latched';
  return null;
}
/** The chip a refused start leaves: a missing microphone says so; any other refusal is the stopped chip. */
function refusalKind(refusal: string): WakeKind {
  return refusal === 'no-microphone' ? 'wake-no-microphone' : 'wake-latched';
}
/**
 * One owned listener/transcription lifetime. Both terminal apps show the same
 * chip and record the same diagnostics; whether enabling wake fetches missing
 * models is the one product difference.
 */
export function createTerminalWakeRuntime(policy: {
  readonly surface: Parameters<typeof resolveWakeRuntimeSettings>[1];
  readonly capabilities: (provision: Pick<WakeProvisionSnapshot, 'vadReady'>) => WakeSurfaceCapabilities;
  readonly provisionOnEnable: boolean;
  readonly missingModels: (reason: string) => string;
  readonly draftNotice: string;
  readonly captureFailure: (error: string, detail: string) => string;
  readonly describeBlockers: (settings: WakeRuntimeSettings) => readonly string[];
  readonly describeLimitations: (settings: WakeRuntimeSettings) => readonly string[];
  readonly describeTranscriptionFailure: (error: unknown) => string;
}) {
  function wireWakeRuntime(deps: TerminalWakeRuntimeDeps): TerminalWakeRuntime {
    let listener: WakeListener | null = null;
    let lifetime: AbortController | null = null;
    let starting: Promise<void> | null = null;
    let epoch = 0;
    let startingEpoch = 0;
    let vadReady = false;
    // Frees the running listener's inference sessions once that listener has stopped.
    let releaseEngine: (() => Promise<void>) | null = null;
    let refusal: { readonly kind: WakeKind; readonly message: string } | null = null;
    const readProvision = () => (deps.provisionStatus ?? ((root) => wakeProvisionStatus({ managedRoot: root })))(deps.managedRoot);
    const resolve = (): WakeRuntimeSettings =>
      resolveWakeRuntimeSettings(deps.readConfig, policy.surface, policy.capabilities({ vadReady }));
    const diagnostic = (ok: boolean, operation: string, error: string | undefined, message: string): void => {
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
    const transcribe = async (utterance: CapturedUtterance, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return;
      // Per-utterance rows follow the live config, like the status line that displays them; the listener's own rows apply on restart.
      const live = resolve();
      if (live.retainAudio === 'session-temp') retainWakeClip(deps, utterance);
      if (utterance.silent) {
        deps.notify('[Wake] Heard the wake phrase but nothing above the silence floor followed it.');
        deps.render();
        return;
      }
      let resolution: ReturnType<TerminalWakeRuntimeDeps['resolveTranscriber']>;
      try {
        resolution = deps.resolveTranscriber();
      } catch (error) {
        deps.notify(`[Wake] Could not look up a speech-to-text route: ${error instanceof Error ? error.message : String(error)}`);
        deps.render();
        return;
      }
      if (!resolution.available) {
        deps.notify(`[Wake] Captured the utterance after the wake phrase but could not transcribe it: ${resolution.reason}`);
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
      let text: string;
      try {
        text = (await resolution.gateway.transcribe(utteranceToAudioArtifact(utterance), { signal })).trim();
        if (signal.aborted) return;
        if (!text.length) {
          deps.notify('[Wake] Speech-to-text returned no words for what followed the wake phrase.');
          deps.render();
          return;
        }
      } catch (error) {
        if (signal.aborted) return;
        const message = policy.describeTranscriptionFailure(error);
        deps.notify(`[Wake] Transcription failed: ${message}`);
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
        return;
      }
      // Read when the transcript is delivered, not when transcription began: a change made while it ran applies to it.
      const autoSubmit = resolve().autoSubmit;
      try {
        if (autoSubmit) deps.submitTurn(text);
        else {
          deps.writeDraft(text);
          deps.notify(policy.draftNotice);
          deps.render();
        }
      } catch (error) {
        deps.notify(`[Wake] The transcript was ready but could not be ${autoSubmit ? 'submitted' : 'placed in the draft'}: ${error instanceof Error ? error.message : String(error)}`);
        deps.render();
      }
    };
    const start = async (initialSettings: WakeRuntimeSettings, provision: WakeProvisionSnapshot): Promise<void> => {
      const controller = new AbortController();
      lifetime = controller;
      const owned = () => lifetime === controller && !controller.signal.aborted;
      let settings = initialSettings;
      // Wake is enabled but its models are not usable, so nothing listens: the
      // notice is kept as the stopped chip's reason, never shown as "wake off".
      const stopWithoutModels = (message: string): void => {
        controller.abort();
        lifetime = null;
        refusal = { kind: 'wake-latched', message: message.replace(/^\[Wake\]\s*/, '') };
        deps.notify(message);
        deps.render();
      };
      if (!provision.ready) {
        if (!policy.provisionOnEnable || !deps.ensureProvisioned) {
          stopWithoutModels(policy.missingModels(provision.reason ?? 'not-provisioned'));
          return;
        }
        deps.notify('[Wake] The wake models are not on this host yet, fetching and verifying them now.');
        deps.render();
        const outcome = await deps.ensureProvisioned();
        if (!owned()) return;
        if (!outcome.ready) {
          stopWithoutModels(`[Wake] ${outcome.message}`);
          return;
        }
        deps.notify(`[Wake] ${outcome.message}`);
        const after = readProvision();
        vadReady = after.vadReady;
        if (!after.ready) {
          stopWithoutModels(
            `[Wake] The wake models still do not verify on disk (${after.reason ?? 'not-provisioned'}), so nothing is listening.`,
          );
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
      const engines = createWakeEngineFactory({
        assetDirectory: deps.assetDirectory,
        embeddingPath: paths.embeddingPath,
        models: models.map((model) => ({ id: model.id, path: model.path })),
        vad: { path: paths.vadPath, ready: vadReady },
        settings,
        warn: deps.warn,
        ...(deps.loadSession !== undefined ? { loadSession: deps.loadSession } : {}),
      });
      const active = new WakeListener({
        settings,
        openCapture: deps.openCapture,
        createEngine: engines,
        ...(deps.createNoiseSuppression !== undefined ? { createNoiseSuppression: deps.createNoiseSuppression } : {}),
        recordDiagnostic: (entry) => recordVoiceDiagnostic(deps.managedRoot, entry),
        handlers: {
          onStateChange() {
            if (current()) deps.render();
          },
          onWake(event) {
            if (!current()) return;
            deps.playActivationSound(event.activationSound);
            deps.render();
          },
          onUtterance(utterance) {
            if (current()) void transcribe(utterance, controller.signal);
          },
          onDeviceBinding(binding: NonNullable<WakeListenerState['deviceBinding']>) {
            if (!current()) return;
            if (binding.state !== 'pinned' && binding.state !== 'default') {
              deps.notify(`[Wake] ${binding.message}`);
              diagnostic(binding.usable, 'wake-input-device', undefined, binding.message);
            } else if (binding.state === 'pinned') deps.notify(`[Wake] ${binding.message}`);
            deps.render();
          },
          onFailure(error, restarting, failureDetail) {
            if (!current()) return;
            diagnostic(false, 'wake-capture', error.message, failureDetail);
            deps.notify(
              restarting
                ? policy.captureFailure(error.message, failureDetail)
                : `[Wake] Listening for the wake word stopped: ${failureDetail}. It starts again by itself when this terminal regains focus or the wake microphone setting changes; "listen for the wake word again" in the System place, This session, starts it now.`,
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
      releaseEngine = engines.release;
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
          releaseEngine = null;
          refusal = null;
        }
        await active.stop().catch(() => undefined);
        await engines.release();
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
        await engines.release();
        return;
      }
      if (!outcome.started) {
        controller.abort();
        lifetime = null;
        listener = null;
        // A start() that was refused arms no timer, so nothing will reopen it.
        releaseEngine = null;
        void engines.release();
        refusal = { kind: refusalKind(outcome.refusal), message: outcome.detail };
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
      const release = releaseEngine;
      releaseEngine = null;
      epoch++;
      // Retired model loads may ignore cancellation. They keep their own cleanup,
      // but must not block a replacement listener from starting.
      starting = null;
      lifetime?.abort();
      lifetime = null;
      listener = null;
      // A refusal belongs to the start that was refused; once wake is stopped
      // there is nothing left for the status chip to explain.
      refusal = null;
      try {
        if (active) await active.stop();
      } finally {
        await release?.();
      }
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
    /**
     * The running listener stopped itself: its supervisor gave up after its restarts (latched), or it sits idle
     * with the reason. Both are what the chip shows as stopped, so both are what "listen again" starts.
     */
    const gaveUp = (): boolean => {
      if (!listener) return false;
      const state = listener.state();
      return state.phase === 'latched' || stoppedWithReason(state, state.phase);
    };
    const runtime: TerminalWakeRuntime = {
      gaveUp,
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
        const kind = liveWakeIndicator(state);
        if (!kind) return null;
        return {
          kind,
          deviceLabel: state.deviceLabel,
          indicator: resolveWakeRuntimeSettings(deps.readConfig, policy.surface).indicator,
          detail: describeWakeListening(state).message,
        };
      },
      settings: resolve,
      stop,
      stopped() {
        if (starting) return false;
        if (!listener) return refusal !== null;
        return gaveUp();
      },
      async listenAgain() {
        if (!resolve().active) {
          deps.render();
          return 'Listening for the wake word is off here, so there is nothing to start again ("Listen for the wake word" in /settings open).';
        }
        if (starting) return 'The wake-word detector is starting.';
        if (listener && !runtime.stopped()) return 'Already listening for the wake word.';
        await stop().catch(() => undefined);
        await runtime.refresh();
        return runtime.stopped()
          ? `Listening for the wake word did not start again: ${runtime.status()?.detail ?? 'see the notice above'}.`
          : 'Listening for the wake word again.';
      },
    };
    return runtime;
  }
  function startWakeRuntime(
    runtime: TerminalWakeRuntime,
    deps: Pick<TerminalWakeRuntimeDeps, 'subscribeConfig'> & {
      /** The terminal's focus-in reports (focus reporting): a listener that stopped itself starts again on one. */
      readonly subscribeFocusGained?: ((listener: () => void) => () => void) | undefined;
    },
  ): readonly (() => void)[] {
    const apply = (): void => {
      void runtime.refresh();
    };
    // The listener captures its rows at start, so a change to one of them restarts it. autoSubmit and retainAudio are read per utterance and indicator per status read, so they need no restart.
    // A write that changes several rows notifies once per row in the same tick; they share one restart, so the models load once.
    let restartPending = false;
    const restart = (): void => {
      if (restartPending) return;
      restartPending = true;
      queueMicrotask(() => {
        restartPending = false;
        void runtime
          .stop()
          .catch(() => undefined)
          .then(() => runtime.refresh());
      });
    };
    const appliedLive = new Set(['voice.wake.enabled', 'voice.wake.autoSubmit', 'voice.wake.retainAudio', 'voice.wake.indicator']);
    const restartKeys = WAKE_SETTING_KEYS.filter((key) => !appliedLive.has(key) && !key.startsWith('voice.wake.surfaces.'));
    const unsubs = [
      deps.subscribeConfig('voice.wake.enabled', apply),
      deps.subscribeConfig(`voice.wake.surfaces.${policy.surface}`, apply),
      ...restartKeys.map((key) => deps.subscribeConfig(key, restart)),
      // A listener whose own restarts gave up (a device that went away, a recorder that kept failing)
      // starts again when the person comes back to this terminal. A changed input device setting is a
      // restart key above, so it starts again on that too.
      ...(deps.subscribeFocusGained ? [deps.subscribeFocusGained(() => {
        // Said by the chip, not a notice: a start that fails again posts its own notice.
        if (runtime.gaveUp()) void runtime.listenAgain();
      })] : []),
      () => {
        void runtime.stop();
      },
    ];
    apply();
    return unsubs;
  }
  return { wireWakeRuntime, startWakeRuntime };
}
