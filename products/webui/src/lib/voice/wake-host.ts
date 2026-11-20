/**
 * wake-host.ts, the browser tab as a wake-word surface.
 *
 * The platform owns everything that is identical on every surface: the front end, the
 * scoring rules, the pre-roll, the silence and ceiling policy, the engine reset
 * after a command, the restart/latch policy. `WakeListener` is all of that. What a
 * host owns is four things, and this file is those four:
 *
 *   1. a device      , the shared browser capture opener, through the arbiter,
 *   2. an inference runtime, onnxruntime-web sessions over daemon-served models,
 *   3. what a wake MEANS here, chime, indicator, transcript into the composer,
 *   4. an honest state for a surface to render, including every refusal.
 *
 * DISABLED MEANS THE DEVICE IS NEVER TOUCHED. `voice.wake.surfaces.webui`
 * defaults to false, and while it is false (or `voice.wake.enabled` is off, or a
 * row blocks) this host loads no model, creates no session and calls no
 * `getUserMedia`, so no permission prompt appears. `.active` from the resolver is
 * the ONLY thing consulted for that decision; nothing here re-derives it.
 *
 * A module singleton, for the same reason the TTS engine is one: there is one
 * microphone per page. Between pages the singleton holds the `goodvibes.wake` Web
 * Lock while it listens, so of several open tabs (or a tab and an installed window)
 * exactly one hears a wake phrase, sends it to speech-to-text and hands it to a
 * composer; the others report that wake detection runs in another tab and start
 * when the lock is released. `createWakeHost` is exported beside it so a test drives
 * the real engine and the real listener with a stubbed inference session, rather
 * than testing a second implementation of this logic.
 */
import { FenceIssuer } from '@goodvibes-jev/engine/platform/platform/utils/owner-fence';
import {
  AudioCaptureError as CaptureFailure,
  utteranceToAudioArtifact,
  type AudioCaptureError,
  type AudioCaptureOpener,
  type CapturedUtterance,
  type UtteranceAudioArtifact,
  type NoiseSuppressionFactory,
} from '@goodvibes-jev/engine/platform/platform/voice/capture';
import {
  WakeListener,
  WakeWordEngine,
  type WakeDetection,
  type WakeInferenceSession,
  type WakeListenerState,
  type WakeModelHandle,
  type WakeRuntimeSettings,
  type WakeStartRefusal,
} from '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';
import { micArbiter, type MicArbiter } from './mic-arbiter';
import { playWakeChime } from './wake-chime';
import { loadWakeModel, openWakeModelCache, WakeModelError } from './wake-models';
import { loadWakeRuntime, type WakeBrowserBackend } from './wake-runtime';
import { CONFIG_SCHEMA_ENTRIES } from '../generated/config-schema';

/**
 * The model id the daemon actually serves to a tab. Read from this repo's
 * generated schema snapshot (the drift-checked copy of the platform's own row) rather
 * than spelled here, so it cannot fall out of step with the pinned model.
 */
export const PINNED_WAKE_MODEL_ID: string = (() => {
  const row = CONFIG_SCHEMA_ENTRIES.find((entry) => entry.key === 'voice.wake.models');
  const value = typeof row?.default === 'string' ? row.default.split(',')[0]?.trim() : '';
  return value && value.length > 0 ? value : 'hey_goodvibes';
})();

/** What this tab is doing about wake detection, for an indicator that must not lie. */
export type WakeHostPhase =
  /** Not enabled here. No device, no download, no permission prompt. */
  | 'off'
  /** Enabled but refused, a blocker, a latch, a permission the user denied. */
  | 'refused'
  /** Fetching and verifying models, or bringing the runtime up. */
  | 'loading'
  /** The microphone is open and every frame is being scored. */
  | 'listening'
  /** A wake confirmed; the utterance that follows is being recorded. */
  | 'capturing'
  /** The utterance is at speech-to-text. */
  | 'transcribing'
  /** The stream died and the supervisor is waiting out its backoff. */
  | 'restarting'
  /** The supervisor gave up. Needs a deliberate off/on to run again. */
  | 'latched'
  /** Stood down so a push-to-talk press can hold the device. */
  | 'suspended';

export interface WakeHostState {
  readonly phase: WakeHostPhase;
  /** `voice.wake.indicator`, or 'off' when nothing is enabled. */
  readonly indicator: 'off' | 'statusline' | 'banner';
  readonly settings: WakeRuntimeSettings | null;
  /** What opened the device, e.g. "getUserMedia (AudioWorklet)"; null when closed. */
  readonly deviceLabel: string | null;
  /** Why the detector is not running, written for a user to read. */
  readonly refusal: {
    readonly kind: WakeStartRefusal | 'model-unavailable' | 'other-tab' | 'host-error';
    readonly detail: string;
  } | null;
  /** The most recent failure's message, or null. */
  readonly error: string | null;
  /** The inference backend actually in force, once a runtime has loaded. */
  readonly backend: WakeBrowserBackend | null;
  /** Written reason the requested backend was not the one used, or null. */
  readonly backendNote: string | null;
  readonly restarts: number;
  readonly lastWakeAt: number | null;
  /** The last transcript this host handed onward, for a receipt in the UI. */
  readonly lastTranscript: string | null;
  readonly modelIds: readonly string[];
  /** Configured rows this tab cannot honour while it listens, written for a user to read. */
  readonly limitations: readonly string[];
}

const IDLE_STATE: WakeHostState = {
  phase: 'off',
  indicator: 'off',
  settings: null,
  deviceLabel: null,
  refusal: null,
  error: null,
  backend: null,
  backendNote: null,
  restarts: 0,
  lastWakeAt: null,
  lastTranscript: null,
  modelIds: [],
  limitations: [],
};

/** The cross-tab lock name: one listening wake host per browser profile. */
export const WAKE_TAB_LOCK = 'goodvibes.wake';

const OTHER_TAB_DETAIL = 'Wake detection is running in another tab. This tab starts listening when that one stops.';

/**
 * Exclusive hold on wake detection across the tabs of one browser.
 *
 * `request` answers with a release function once this tab holds it, or null when
 * `signal` aborted first. `onQueued` is called when another tab holds it, before
 * the wait begins.
 */
export interface WakeTabLock {
  request(signal: AbortSignal, onQueued: () => void): Promise<(() => void) | null>;
}

/** Where a finished transcript goes. Registered by the view that owns a composer. */
export type WakeTranscriptSink = (text: string, options: { readonly autoSubmit: boolean }) => void;

/** One loaded runtime plus its sessions, ready for an engine. */
export interface WakeModelSet {
  readonly embedding: WakeInferenceSession;
  readonly models: readonly WakeModelHandle[];
  /**
   * The speech gate, present only when `voice.wake.vadThreshold` asks for one AND
   * its artifact is provisioned. Absent means every frame is scored, which is what
   * the shipped default of 0 asks for, never a gate that failed to load, because
   * that is a startup blocker from resolveWakeRuntimeSettings.
   */
  readonly vad?: { readonly session: WakeInferenceSession; readonly threshold: number } | undefined;
  readonly backend: WakeBrowserBackend;
  readonly fallbackReason: string | null;
  /** Rows that are configured but cannot be honoured, e.g. an unservable model id. */
  readonly limitations: readonly string[];
  release(): Promise<void>;
}

export interface WakeHostDeps {
  /** The device path. Defaults to the arbiter's, which refuses a second stream. */
  readonly openCapture: AudioCaptureOpener;
  /** Loads models and the inference runtime for a resolved configuration. */
  readonly loadModelSet: (settings: WakeRuntimeSettings) => Promise<WakeModelSet>;
  /**
   * Builds the speex suppression stage. The platform's listener wraps the opener and
   * defaults to the embedded WebAssembly filter; injected here so a test can check
   * that captured frames REACH a stage without compiling one, while the filter's
   * own numbers stay the platform's to assert.
   */
  readonly createNoiseSuppression?: NoiseSuppressionFactory | undefined;
  /** Sends an utterance to speech-to-text and returns the text. */
  readonly transcribe: (artifact: UtteranceAudioArtifact) => Promise<string>;
  /**
   * The browser's sign-in generation (lib/client-lifetime.ts): an utterance
   * captured under one is delivered only while it is still current, so words
   * spoken before a sign-out or a change of account never land under the next.
   * Absent: one generation for the host's whole life.
   */
  readonly identityRevision?: (() => number) | undefined;
  /** Plays the activation sound; false when this tab could not make a sound. */
  readonly chime: () => boolean;
  /** Registers this host so a push-to-talk press can stand it down. */
  readonly arbiter: Pick<MicArbiter, 'registerWake'> | null;
  /** Cross-tab exclusivity. Absent: this host listens whenever it is configured to. */
  readonly tabLock?: WakeTabLock | null | undefined;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  readonly now?: (() => number) | undefined;
}

/** A signature of the rows that require the listener to be rebuilt when they change. */
function runtimeSignature(settings: WakeRuntimeSettings): string {
  return JSON.stringify([
    settings.active,
    settings.modelIds,
    settings.tuning,
    settings.capture,
    settings.preRollMs,
    settings.captureMaxSeconds,
    settings.silenceStopMs,
    settings.supervisor,
    settings.browserBackend,
  ]);
}

export class WakeHost {
  readonly #deps: WakeHostDeps;
  readonly #listeners = new Set<() => void>();
  #state: WakeHostState = IDLE_STATE;
  #listener: WakeListener | null = null;
  #modelSet: WakeModelSet | null = null;
  #signature: string | null = null;
  #sink: WakeTranscriptSink | null = null;
  #unregisterWake: (() => void) | null = null;
  /** Serialises apply/suspend/resume so two config updates cannot overlap. */
  #chain: Promise<void> = Promise.resolve();
  /** True while the arbiter holds the device for a push-to-talk press. */
  #suspended = false;
  #settings: WakeRuntimeSettings | null = null;
  /** Releases the cross-tab lock while this host holds it. */
  #lockRelease: (() => void) | null = null;
  /** Aborts the wait while another tab holds the lock. */
  #lockWait: AbortController | null = null;
  /**
   * The generation of device opens. stop(), suspend() and a cleared
   * configuration move it at once, outside the serialised chain, so an open
   * still waiting (a permission prompt nobody answers) is abandoned instead of
   * holding the stop behind it, and a stream that lands after is closed.
   */
  readonly #opens = new FenceIssuer('wake capture');

  constructor(deps: WakeHostDeps) {
    this.#deps = deps;
  }

  /**
   * The opener the listener is given: each open takes the current generation's
   * fence, gives up the moment that generation ends, and closes a stream that
   * arrives after it, never adopting it.
   */
  readonly #fencedOpenCapture: AudioCaptureOpener = (request, handlers) => {
    const fence = this.#opens.peek();
    const stopped = () => new CaptureFailure('device-unavailable', 'Wake detection was stopped while the microphone was opening.');
    if (!fence.current) return Promise.reject(stopped());
    return new Promise((resolve, reject) => {
      const onAbort = (): void => reject(stopped());
      fence.signal.addEventListener('abort', onAbort, { once: true });
      this.#deps.openCapture(request, handlers).then((stream) => {
        fence.signal.removeEventListener('abort', onAbort);
        if (fence.current) { resolve(stream); return; }
        void stream.stop().catch((error: unknown) => this.#deps.warn('a microphone stream opened after stop could not be closed', { error: String(error) }));
        reject(stopped());
      }, (error: unknown) => {
        fence.signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  getState(): WakeHostState {
    return this.#state;
  }

  subscribe(onChange: () => void): () => void {
    this.#listeners.add(onChange);
    return () => this.#listeners.delete(onChange);
  }

  /**
   * Register where transcripts go. Returns the unregister function. The host keeps
   * working with no sink registered, it still listens, chimes and transcribes,
   * and reports the transcript in its own state, so a wake is never silently lost
   * because no view happened to be mounted.
   */
  setTranscriptSink(sink: WakeTranscriptSink): () => void {
    this.#sink = sink;
    return () => {
      if (this.#sink === sink) this.#sink = null;
    };
  }

  /**
   * Apply a freshly resolved configuration. Idempotent: an identical
   * configuration is a no-op, so this can be called from a render path on every
   * `config.get` refetch.
   */
  applySettings(settings: WakeRuntimeSettings | null): Promise<void> {
    if (settings === null) this.#opens.issue();
    return this.#run(async () => {
      this.#settings = settings;
      if (settings === null) {
        await this.#teardown();
        this.#releaseTabLock();
        this.#patch({ ...IDLE_STATE });
        return;
      }
      const signature = runtimeSignature(settings);
      if (this.#suspended && signature !== this.#signature) {
        // A press holds the device. Rebuilding now would be refused by the arbiter
        // and leave the host unregistered; resume() applies the stored settings.
        this.#patch({ settings });
        return;
      }
      const unchanged = signature === this.#signature && this.#listener !== null;
      if (unchanged) {
        // Indicator and the written blocker/limitation lists can change without
        // the runtime needing a rebuild.
        this.#patch({ settings, indicator: settings.active ? settings.indicator : 'off' });
        return;
      }
      await this.#rebuild(settings, signature);
    });
  }

  /** Tear down and start fresh for a changed configuration. */
  async #rebuild(settings: WakeRuntimeSettings, signature: string): Promise<void> {
    this.#signature = signature;
    await this.#teardown();

    if (!settings.active) {
      // The one place the "never open a device while disabled" rule is enforced:
      // nothing below this line runs, so no model is fetched and getUserMedia is
      // never called.
      this.#releaseTabLock();
      const askedForHere = settings.enabled && settings.surfaceEnabled;
      this.#patch({
        ...IDLE_STATE,
        settings,
        phase: askedForHere ? 'refused' : 'off',
        // A user who switched this on for this origin and got a blocker still
        // gets the indicator, carrying the reason, the alternative is a feature
        // that reads as enabled and shows nothing anywhere.
        indicator: askedForHere ? settings.indicator : 'off',
        refusal: describeInactive(settings),
      });
      return;
    }
    await this.#startListening(settings);
  }

  /** Stand down and release the device, so a press can take it. */
  suspend(): Promise<void> {
    this.#opens.issue();
    return this.#run(async () => {
      if (this.#listener === null) return;
      this.#suspended = true;
      await this.#listener.stop();
      this.#patch({ phase: 'suspended', deviceLabel: null });
    });
  }

  /** Start listening again after a press released the device. */
  resume(): Promise<void> {
    return this.#run(async () => {
      if (!this.#suspended) return;
      this.#suspended = false;
      const settings = this.#settings;
      if (settings === null) return;
      const signature = runtimeSignature(settings);
      if (signature !== this.#signature) {
        // The configuration changed while the press held the device.
        await this.#rebuild(settings, signature);
        return;
      }
      if (!settings.active) return;
      const listener = this.#listener;
      if (listener === null) {
        await this.#startListening(settings);
        return;
      }
      await this.#restartListener(listener);
    });
  }

  async #restartListener(listener: WakeListener): Promise<void> {
    if (!(await this.#acquireTabLock())) {
      this.#patch({ phase: 'refused', deviceLabel: null, refusal: { kind: 'other-tab', detail: OTHER_TAB_DETAIL } });
      return;
    }
    const outcome = await listener.start();
    if (outcome.started) {
      this.#registerWithArbiter();
      this.#patch({ phase: 'listening', deviceLabel: outcome.deviceLabel, refusal: null, error: null });
    } else {
      this.#releaseTabLock();
      this.#patch({ phase: 'refused', refusal: { kind: outcome.refusal, detail: outcome.detail } });
    }
  }

  /** Stop for good and release everything. */
  stop(): Promise<void> {
    this.#opens.issue();
    return this.#run(async () => {
      await this.#teardown();
      this.#releaseTabLock();
      this.#signature = null;
      this.#patch({ ...IDLE_STATE, settings: this.#settings });
    });
  }

  /** Clear a latched supervisor. The deliberate act the latch waits for. */
  clearLatch(): void {
    void this.#run(async () => {
      const listener = this.#listener;
      listener?.clearLatch();
      this.#patch({ error: null });
      // A suspended host is restarted by resume(); anything else that is latched
      // must leave the latched phase and refusal here, or the indicator keeps
      // saying "latched" for a detector that is allowed to run again.
      if (this.#suspended || this.#state.phase !== 'latched') return;
      const settings = this.#settings;
      if (settings?.active !== true) return;
      if (listener === null) await this.#startListening(settings);
      else await this.#restartListener(listener);
    });
  }

  /**
   * The one place a callback running OUTSIDE the serialised chain (a transcript
   * finishing) may change phase. It may only replace the phases that belong to the
   * utterance itself; `suspended`, `latched`, `restarting` and anything else were
   * set by something newer and must survive.
   */
  #finishUtterance(next: Partial<WakeHostState>): void {
    const phase = this.#state.phase;
    const mine = phase === 'transcribing' || phase === 'capturing' || phase === 'listening';
    if (!mine) {
      this.#patch(next);
      return;
    }
    this.#patch({ ...next, phase: this.#listener === null ? 'off' : 'listening' });
  }

  #run(step: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(step, step);
    this.#chain = next.catch((error: unknown) => {
      this.#deps.warn('wake host step failed', { error: String(error) });
      // A step that threw (listener construction, start or stop) must not leave a
      // stale 'loading' or 'listening' indicator with nothing to explain it.
      const detail = `Wake detection stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
      this.#patch({ phase: 'refused', refusal: { kind: 'host-error', detail }, error: detail, deviceLabel: null });
    });
    return this.#chain;
  }

  async #teardown(): Promise<void> {
    // A torn-down host is unregistered, so no lease release will ever resume it.
    this.#suspended = false;
    this.#unregisterWake?.();
    this.#unregisterWake = null;
    const listener = this.#listener;
    this.#listener = null;
    if (listener !== null) await listener.stop();
    const modelSet = this.#modelSet;
    this.#modelSet = null;
    if (modelSet !== null) {
      try {
        await modelSet.release();
      } catch (error) {
        this.#deps.warn('releasing wake inference sessions failed', { error: String(error) });
      }
    }
  }

  async #startListening(settings: WakeRuntimeSettings): Promise<void> {
    if (!settings.modelIds.includes(PINNED_WAKE_MODEL_ID)) {
      // Nothing this tab could score: no download, no device, no lock. Holding the
      // microphone would show "listening" for a detector that cannot fire, and
      // dictation opens its own stream when pressed.
      this.#releaseTabLock();
      const detail = noPinnedModelDetail(settings.modelIds);
      this.#patch({
        ...IDLE_STATE,
        settings,
        phase: 'refused',
        indicator: settings.indicator,
        refusal: { kind: 'model-unavailable', detail },
      });
      return;
    }
    if (!(await this.#acquireTabLock())) {
      this.#patch({
        ...IDLE_STATE,
        settings,
        phase: 'refused',
        indicator: settings.indicator,
        refusal: { kind: 'other-tab', detail: OTHER_TAB_DETAIL },
      });
      return;
    }
    this.#patch({
      ...IDLE_STATE,
      settings,
      phase: 'loading',
      indicator: settings.indicator,
    });

    let modelSet: WakeModelSet;
    try {
      modelSet = await this.#deps.loadModelSet(settings);
    } catch (error) {
      const detail = error instanceof WakeModelError
        ? error.message
        : `The wake-word models could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
      this.#releaseTabLock();
      this.#patch({ phase: 'refused', refusal: { kind: 'model-unavailable', detail }, error: detail });
      return;
    }
    this.#modelSet = modelSet;

    const listener = new WakeListener({
      settings,
      openCapture: this.#fencedOpenCapture,
      ...(this.#deps.createNoiseSuppression !== undefined
        ? { createNoiseSuppression: this.#deps.createNoiseSuppression }
        : {}),
      createEngine: () => Promise.resolve(new WakeWordEngine({
        embedding: modelSet.embedding,
        models: modelSet.models,
        tuning: settings.tuning,
        preRollMs: settings.preRollMs,
        ...(modelSet.vad !== undefined ? { vad: modelSet.vad } : {}),
        // Required in practice: the engine no longer imports a logger (that pulled
        // node:fs and made it unbundleable here), so a model that misbehaves is
        // only ever visible through this sink.
        warn: this.#deps.warn,
      })),
      handlers: {
        onStateChange: (state) => this.#onListenerState(state),
        onWake: ({ activationSound }) => {
          const played = activationSound.kind === 'chime' ? this.#deps.chime() : true;
          if (!played) this.#deps.warn('wake confirmed but this tab could not play the activation chime');
          this.#patch({ phase: 'capturing' });
        },
        onUtterance: (utterance, detection) => {
          void this.#onUtterance(utterance, detection);
        },
        onFailure: (error, restarting, detail) => this.#onFailure(error, restarting, detail),
      },
      warn: this.#deps.warn,
      ...(this.#deps.now ? { now: this.#deps.now } : {}),
    });
    this.#listener = listener;

    const outcome = await listener.start();
    if (!outcome.started) {
      // A tab that cannot open its device must not keep every other tab waiting.
      this.#releaseTabLock();
      this.#patch({
        phase: outcome.refusal === 'blocked' ? 'latched' : 'refused',
        refusal: { kind: outcome.refusal, detail: outcome.detail },
        error: outcome.detail,
      });
      return;
    }

    this.#registerWithArbiter();

    this.#patch({
      phase: 'listening',
      deviceLabel: outcome.deviceLabel,
      backend: modelSet.backend,
      backendNote: modelSet.fallbackReason,
      modelIds: modelSet.models.map((model) => model.id),
      limitations: modelSet.limitations,
      refusal: null,
      error: null,
    });
  }

  /**
   * True once this tab holds the cross-tab lock (or has none to hold). When another
   * tab holds it, answers false and keeps one wait queued: the grant starts this
   * host with the settings current at that moment. Held, never polled.
   */
  #acquireTabLock(): Promise<boolean> {
    const lock = this.#deps.tabLock;
    if (!lock || this.#lockRelease !== null) return Promise.resolve(true);
    if (this.#lockWait !== null) return Promise.resolve(false);
    const wait = new AbortController();
    this.#lockWait = wait;
    return new Promise<boolean>((answer) => {
      let queued = false;
      void lock.request(wait.signal, () => {
        queued = true;
        answer(false);
      }).then((release) => {
        if (this.#lockWait !== wait || release === null) {
          release?.();
          if (this.#lockWait === wait) this.#lockWait = null;
          answer(false);
          return;
        }
        this.#lockWait = null;
        this.#lockRelease = release;
        if (!queued) {
          answer(true);
          return;
        }
        void this.#run(async () => {
          const settings = this.#settings;
          if (this.#lockRelease !== release || this.#suspended) return;
          if (settings?.active !== true) {
            this.#releaseTabLock();
            return;
          }
          const listener = this.#listener;
          if (listener === null) await this.#startListening(settings);
          else await this.#restartListener(listener);
        });
      });
    });
  }

  #releaseTabLock(): void {
    this.#lockWait?.abort();
    this.#lockWait = null;
    const release = this.#lockRelease;
    this.#lockRelease = null;
    release?.();
  }

  /** Idempotent: a listener holding the device must always be one a press can stand down. */
  #registerWithArbiter(): void {
    if (this.#unregisterWake !== null || !this.#deps.arbiter) return;
    this.#unregisterWake = this.#deps.arbiter.registerWake({
      suspend: () => this.suspend(),
      resume: () => this.resume(),
    });
  }

  #onListenerState(state: WakeListenerState): void {
    // The listener's own phases map onto this host's, EXCEPT while a transcript is
    // in flight (the listener is back to 'listening' by then, but the user is
    // waiting on words) and while suspended (the host stopped it deliberately).
    if (this.#suspended) return;
    if (this.#state.phase === 'transcribing' && state.phase === 'listening') return;
    const phase: WakeHostPhase = state.phase === 'listening'
      ? 'listening'
      : state.phase === 'capturing-utterance'
        ? 'capturing'
        : state.phase === 'restarting'
          ? 'restarting'
          : state.phase === 'latched'
            ? 'latched'
            : state.phase === 'starting'
              ? 'loading'
              : this.#state.phase;
    this.#patch({
      phase,
      deviceLabel: state.deviceLabel,
      restarts: state.restarts,
      lastWakeAt: state.lastWakeAt,
      ...(state.latchReason ? { refusal: { kind: 'blocked' as const, detail: state.latchReason } } : {}),
      ...(state.lastError ? { error: state.lastError } : {}),
    });
  }

  async #onUtterance(utterance: CapturedUtterance, detection: WakeDetection): Promise<void> {
    if (utterance.silent) {
      // Nothing above the silence floor followed the wake. Sending that to a
      // provider bills a request to transcribe a room, so it is reported instead.
      this.#deps.warn('a wake fired but nothing was said after it', { modelId: detection.modelId });
      this.#finishUtterance({ error: 'A wake fired but nothing was said after it, nothing was sent.' });
      return;
    }
    this.#patch({ phase: 'transcribing' });
    // The sign-in this utterance was spoken under; compared again right before the words are handed on.
    const spokenUnder = this.#deps.identityRevision?.();
    try {
      const artifact = utteranceToAudioArtifact(utterance);
      const text = (await this.#deps.transcribe(artifact)).trim();
      if (spokenUnder !== this.#deps.identityRevision?.()) {
        this.#finishUtterance({ error: 'The words after that wake were dropped: this browser signed out or changed account while they were transcribed.' });
        return;
      }
      const autoSubmit = this.#settings?.autoSubmit === true;
      this.#finishUtterance({ lastTranscript: text, error: null });
      if (text.length > 0) this.#sink?.(text, { autoSubmit });
      else this.#patch({ error: 'Speech-to-text returned no words for that utterance.' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#finishUtterance({
        error: `The utterance after the wake could not be transcribed: ${detail}`,
      });
    }
  }

  #onFailure(error: AudioCaptureError, restarting: boolean, detail: string): void {
    // A latched detector no longer listens; another tab may take over until a
    // deliberate retry here asks for the lock again.
    if (!restarting) this.#releaseTabLock();
    this.#patch({
      phase: restarting ? 'restarting' : 'latched',
      error: detail || error.message,
      deviceLabel: null,
      ...(restarting ? {} : { refusal: { kind: 'blocked' as const, detail: detail || error.message } }),
    });
  }

  #patch(next: Partial<WakeHostState>): void {
    this.#state = { ...this.#state, ...next };
    for (const listener of this.#listeners) listener();
  }
}

/** The written reason an inactive configuration is inactive. */
function describeInactive(settings: WakeRuntimeSettings): WakeHostState['refusal'] {
  if (!settings.enabled) {
    return {
      kind: 'disabled',
      detail: 'voice.wake.enabled is off, so no microphone is opened anywhere.',
    };
  }
  if (!settings.surfaceEnabled) {
    return {
      kind: 'surface-disabled',
      detail: 'voice.wake.surfaces.webui is off, so this browser tab does not listen and never asks for the '
        + 'microphone. Turn it on here to opt this origin in.',
    };
  }
  const blocker = settings.blockers[0];
  if (settings.blockers.length > 0 && blocker !== undefined) {
    return { kind: 'blocked', detail: `${blocker.key} ${blocker.detail}` };
  }
  return null;
}

// ─── The browser's default dependencies ──────────────────────────────────────

/**
 * Load the classifier and the embedding backbone from the daemon, verify both,
 * and bring an inference runtime up over them.
 *
 * Only the PINNED classifier is servable to a tab: `voice.wake.model` reads the
 * managed artifacts, and a custom model in `voice.wake.customModelDir` lives on
 * the host's disk with no route to fetch it. Extra ids are therefore reported as a
 * limitation (shown in the settings panel) rather than silently relabelled onto the
 * pinned model, a detector that says it is running your model and is running a
 * different one is worse than one that says it cannot. A list without the pinned
 * id never reaches this loader: the host refuses it without opening the device.
 */
export function createBrowserModelSetLoader(deps: {
  readonly readChunk: Parameters<typeof loadWakeModel>[1]['readChunk'];
  readonly modelVersion: () => Promise<string | null>;
  readonly warn: (message: string, meta?: Readonly<Record<string, unknown>>) => void;
  /** Injected so a test can supply sessions; defaults to onnxruntime-web. */
  readonly loadRuntime?: typeof loadWakeRuntime | undefined;
}): (settings: WakeRuntimeSettings) => Promise<WakeModelSet> {
  return async (settings) => {
    const [modelVersion, cache] = await Promise.all([deps.modelVersion(), openWakeModelCache()]);
    const loaderDeps = {
      readChunk: deps.readChunk,
      modelVersion,
      warn: deps.warn,
      ...(cache ? { cache } : {}),
    };
    const wantsGate = settings.vadThreshold > 0;
    const [embeddingBytes, classifierBytes, vadBytes] = await Promise.all([
      loadWakeModel('embedding', loaderDeps),
      loadWakeModel('classifier', loaderDeps),
      // Fetched, cached and CHECKSUM-VERIFIED exactly like the other two, a gate
      // assembled from a truncated transfer would screen frames by accident.
      wantsGate ? loadWakeModel('vad', loaderDeps) : Promise.resolve(null),
    ]);

    const runtime = await (deps.loadRuntime ?? loadWakeRuntime)(settings.browserBackend);
    // Sessions hold wasm/GPU memory: if a later one fails to compile, the earlier
    // ones must be released here, because nothing else will ever hold them.
    const created: WakeInferenceSession[] = [];
    const create = async (bytes: Uint8Array): Promise<WakeInferenceSession> => {
      const session = await runtime.createSession(bytes);
      created.push(session);
      return session;
    };
    let embedding: WakeInferenceSession;
    let classifier: WakeInferenceSession;
    let vadSession: WakeInferenceSession | null;
    try {
      embedding = await create(embeddingBytes.bytes);
      classifier = await create(classifierBytes.bytes);
      vadSession = vadBytes === null ? null : await create(vadBytes.bytes);
    } catch (error) {
      await Promise.allSettled(created.map(async (session) => session.release?.()));
      throw error;
    }

    const limitations: string[] = [];
    const unservable = settings.modelIds.filter((id) => id !== PINNED_WAKE_MODEL_ID);
    if (unservable.length > 0) {
      limitations.push(
        `voice.wake.models names ${unservable.join(', ')}, which a browser tab cannot load: the daemon serves the `
        + `pinned "${PINNED_WAKE_MODEL_ID}" classifier, and a custom model lives on the host's disk with no route to `
        + 'fetch it here. Only the pinned model is being scored in this tab.',
      );
    }
    // The host starts a loader only when the pinned id is configured.
    const models: WakeModelHandle[] = [{ id: PINNED_WAKE_MODEL_ID, session: classifier }];

    return {
      embedding,
      models,
      ...(vadSession !== null ? { vad: { session: vadSession, threshold: settings.vadThreshold } } : {}),
      backend: runtime.backend,
      fallbackReason: runtime.fallbackReason,
      limitations,
      release: async () => {
        await Promise.all([embedding.release?.(), classifier.release?.(), vadSession?.release?.()]);
      },
    };
  };
}

function noPinnedModelDetail(modelIds: readonly string[]): string {
  const named = modelIds.length === 0 ? 'is empty' : `names only ${modelIds.join(', ')}`;
  return `voice.wake.models ${named}, and a browser tab can score only the pinned "${PINNED_WAKE_MODEL_ID}" `
    + 'classifier (a custom model lives on the host\'s disk with no route to fetch it here). This tab does not open '
    + 'the microphone for wake detection; dictation still works.';
}

/**
 * The browser's cross-tab lock, over the Web Locks API. Null where the API is
 * missing (an insecure origin or an old browser): the tab then listens on its own,
 * as it would with one tab open.
 */
export function createBrowserWakeTabLock(): WakeTabLock | null {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return null;
  return {
    request: (signal, onQueued) => new Promise((resolve) => {
      // The lock is held for as long as the callback's promise is pending; the
      // release handed to the host settles it.
      const hold = (lock: Lock | null): Promise<void> | undefined => (lock === null
        ? undefined
        : new Promise<void>((release) => resolve(() => release())));
      locks.request(WAKE_TAB_LOCK, { ifAvailable: true }, (lock) => {
        if (lock !== null) return hold(lock);
        if (signal.aborted) {
          resolve(null);
          return undefined;
        }
        onQueued();
        // Aborted: this tab stopped waiting. Any other failure of the API: listen
        // alone rather than wait for a grant that will never come.
        locks.request(WAKE_TAB_LOCK, { signal }, hold).catch(() => resolve(signal.aborted ? null : () => undefined));
        return undefined;
      }).catch(() => resolve(() => undefined));
    }),
  };
}

/**
 * Create a host over explicit dependencies. Used by the singleton below and by
 * tests, which supply a fake capture stream and a stub inference session so the
 * REAL engine and the REAL listener are what gets exercised.
 */
export function createWakeHost(deps: WakeHostDeps): WakeHost {
  return new WakeHost(deps);
}

/** Warnings go to the console: a tab has no log file, and silence is worse. */
function consoleWarn(message: string, meta?: Readonly<Record<string, unknown>>): void {
  if (meta) console.warn(`[wake] ${message}`, meta);
  else console.warn(`[wake] ${message}`);
}

export const wakeHostWarn = consoleWarn;

/** Placeholder dependencies replaced by `installWakeHostDaemonDeps` at boot. */
const unwiredLoader: WakeHostDeps['loadModelSet'] = () => {
  throw new Error('The wake-word host has no daemon connection wired yet.');
};
const unwiredTranscribe: WakeHostDeps['transcribe'] = () => {
  throw new Error('The wake-word host has no speech-to-text connection wired yet.');
};

const mutableDeps: {
  loadModelSet: WakeHostDeps['loadModelSet'];
  transcribe: WakeHostDeps['transcribe'];
  identityRevision: () => number;
} = { loadModelSet: unwiredLoader, transcribe: unwiredTranscribe, identityRevision: () => 0 };

/**
 * The tab's wake host.
 *
 * Its daemon-facing dependencies are installed by `installWakeHostDaemonDeps`
 * rather than imported here, so this module does not pull `lib/goodvibes` (and
 * with it the whole platform client surface) into the import graph of anything that
 * only wants the capture primitive.
 */
export const wakeHost: WakeHost = createWakeHost({
  openCapture: micArbiter.openCapture,
  loadModelSet: (settings) => mutableDeps.loadModelSet(settings),
  transcribe: (artifact) => mutableDeps.transcribe(artifact),
  identityRevision: () => mutableDeps.identityRevision(),
  chime: () => playWakeChime(),
  arbiter: micArbiter,
  tabLock: createBrowserWakeTabLock(),
  warn: consoleWarn,
});

/** Wire the singleton's daemon-facing calls. Called once, from the voice hooks. */
export function installWakeHostDaemonDeps(deps: {
  readonly loadModelSet: WakeHostDeps['loadModelSet'];
  readonly transcribe: WakeHostDeps['transcribe'];
  readonly identityRevision: () => number;
}): void {
  mutableDeps.loadModelSet = deps.loadModelSet;
  mutableDeps.transcribe = deps.transcribe;
  mutableDeps.identityRevision = deps.identityRevision;
}
