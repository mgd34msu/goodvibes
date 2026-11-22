import { classifyFailure } from '@goodvibes/engine/errors';
import type { ConfigKey, ConfigManager } from '../../config/index.js';
import type { TurnEvent } from '../../../events/turn.js';
import type { VoiceService } from '../service.js';
import type { VoiceAudioChunk, VoiceSynthesisStreamResult } from '../types.js';
import { summarizeError } from '../../utils/error-display.js';
import { TtsTextChunker } from './text-chunker.js';
import type { AudioSink } from './audio-sink.js';

/**
 * How many synthesis requests may sit in the pipeline at once (synthesizing,
 * waiting to play, or playing). 2 = the chunk being played plus ONE prefetch,
 * so the next audio is ready the moment the current sink drains. Bounding
 * this is what keeps a streaming answer from bursting N concurrent requests
 * at the voice provider, ElevenLabs plans allow as few as 3 concurrent, and
 * an unbounded burst 429s the whole turn. The platform config schema has no tts.*
 * key for pipeline tuning, so this is a constant by design.
 */
const SYNTHESIS_PIPELINE_WINDOW = 2;

/**
 * Upper bound for one merged synthesis request's text. The ElevenLabs
 * provider passes request text through verbatim (no cap of its own); the API
 * caps text per request by plan, 2,500 chars on the lowest tiers, 5,000 on
 * most others. 1,500 stays safely under every plan while still folding a
 * multi-paragraph answer into one or two requests.
 */
const SYNTHESIS_MERGE_MAX_CHARS = 1500;

/**
 * Backoff for a synthesis failure the failure table calls retryable (429,
 * transient 5xx, a dropped connection, a timeout): the provider's Retry-After
 * when it sent one, else 1 s then 2.5 s; then the chunk is skipped honestly and
 * the turn continues. A Retry-After longer than the cap skips the chunk at
 * once, because speech that far behind the text is no longer worth waiting for.
 */
const SYNTHESIS_RETRY_DELAYS_MS = [1000, 2500] as const;
const SYNTHESIS_RETRY_AFTER_CAP_MS = 10_000;

/** The settings one spoken turn was started with; a change to any of them stops it. */
const TURN_CONFIG_KEYS = ['tts.provider', 'tts.voice', 'tts.speed'] as const satisfies readonly ConfigKey[];

/**
 * Source label attached to every synthesis request's metadata. Consumers may
 * override it so provider-side telemetry attributes requests to the right
 * surface (TUI, agent, webui).
 */
const DEFAULT_SYNTHESIS_SOURCE = 'goodvibes-platform';

export interface SpokenTurnControllerOptions {
  readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  /** `subscribe`, when present, stops the current speech when a `tts.*` setting it was started with changes. */
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'subscribe'>>;
  /** The injectable I/O boundary. See {@link AudioSink}. */
  readonly sink: AudioSink;
  readonly notify?: ((message: string) => void) | undefined;
  /**
   * Attribution label recorded in each synthesis request's metadata.source
   * (e.g. 'goodvibes-tui', 'goodvibes-agent', 'goodvibes-webui'). Defaults to
   * 'goodvibes-platform'.
   */
  readonly source?: string | undefined;
  /** True when every turn is spoken (`ui.voiceEnabled`); otherwise only turns whose origin asks for speech are. */
  readonly speakAllTurns?: (() => boolean) | undefined;
  readonly now?: (() => number) | undefined;
  readonly setInterval?: typeof setInterval | undefined;
  readonly clearInterval?: typeof clearInterval | undefined;
  /** Injectable clock for retry backoff timers (tests use fakes). */
  readonly setTimeout?: typeof setTimeout | undefined;
  readonly clearTimeout?: typeof clearTimeout | undefined;
}

/** The origin source a spoken prompt is submitted with. */
export const SPOKEN_TURN_SOURCE = 'tts';

/** A turn is spoken when its own origin says so; speech and spoken-turn model routing both read this. */
export function isSpokenTurnOrigin(origin: { readonly source?: string | undefined; readonly metadata?: Readonly<Record<string, unknown>> | undefined } | undefined): boolean {
  return origin?.source === SPOKEN_TURN_SOURCE || origin?.metadata?.['spokenOutput'] === true;
}

type TurnConfig = { readonly provider: string | undefined; readonly voice: string | undefined; readonly speed: number | undefined };

/**
 * SpokenTurnController, the shared spoken-output policy engine. It watches a
 * turn's lifecycle events, chunks the streamed answer into speech-sized pieces,
 * merges and dispatches synthesis requests through a bounded 2-slot window with
 * retry/backoff, and drives an injected {@link AudioSink} with honest
 * drain-vs-interrupt semantics. All I/O is the sink's; this class is pure
 * policy and runs unchanged in the terminal, the agent, and the browser.
 *
 * What retires a spoken turn is one thing: the abort signal of each of its
 * chunks, aborted by {@link SpokenTurnController.stop}, by the next spoken
 * turn, and by a change to the `tts.*` settings the turn started with.
 */
export class SpokenTurnController {
  private activeTurnId: string | null = null;
  private chunker: TtsTextChunker | null = null;
  private chunkSequence = 0;
  private turnConfig: TurnConfig | undefined;
  private unsubscribeConfig: (() => void) | undefined;
  private exitDrainGeneration: number | null = null;
  private playbackChain: Promise<void> = Promise.resolve();
  /** Chunks synthesizing or waiting to play; any stop aborts them. */
  private readonly abortControllers = new Set<AbortController>();
  /** The chunk being heard; only an exit drain lets it finish. */
  private readonly playingControllers = new Set<AbortController>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A skipped chunk is reported once per turn; separate from the playback stop so one never suppresses the other. */
  private skipReportedForTurn = false;
  private playbackStoppedForTurn = false;
  private noSinkNoticed = false;
  /** Chunker output waiting to be merged into a synthesis request. */
  private pendingTexts: string[] = [];
  /** Requests currently in the pipeline (synthesizing / waiting / playing). */
  private pipelineDepth = 0;
  /** Bumped on every teardown so stale pipeline releases are ignored. */
  private pipelineGeneration = 0;
  private pumpScheduled = false;
  /** Set when TURN_COMPLETED arrives; the turn releases once the pipeline drains. */
  private completedTurnId: string | null = null;
  private readonly voiceService: Pick<VoiceService, 'synthesizeStream'>;
  private readonly configManager: SpokenTurnControllerOptions['configManager'];
  private readonly sink: AudioSink;
  private readonly notify?: ((message: string) => void) | undefined;
  private readonly source: string;
  private readonly speakAllTurns: () => boolean;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly setTimeoutImpl: typeof setTimeout;
  private readonly clearTimeoutImpl: typeof clearTimeout;

  constructor(options: SpokenTurnControllerOptions) {
    this.voiceService = options.voiceService;
    this.configManager = options.configManager;
    this.sink = options.sink;
    this.notify = options.notify;
    this.source = options.source ?? DEFAULT_SYNTHESIS_SOURCE;
    this.speakAllTurns = options.speakAllTurns ?? (() => false);
    this.now = options.now ?? (() => Date.now());
    this.setIntervalImpl = options.setInterval ?? setInterval;
    this.clearIntervalImpl = options.clearInterval ?? clearInterval;
    this.setTimeoutImpl = options.setTimeout ?? setTimeout;
    this.clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
  }

  /** `speaking` owns a turn; `draining` lets the last audible chunk of an exiting session finish. */
  get phase(): 'idle' | 'speaking' | 'draining' {
    if (this.activeTurnId !== null) return 'speaking';
    return this.exitDrainGeneration !== null ? 'draining' : 'idle';
  }

  /**
   * Returns whether speech was actually ACTIVE when stopped. The notice only
   * prints in that case, so a Ctrl+C on an idle controller is not reported as
   * a stop; callers use the return to decide whether the press "did a job"
   * (see handleCtrlC's consume-on-speech-stop).
   */
  stop(message?: string): boolean {
    this.exitDrainGeneration = null;
    const wasActive = this.activeTurnId !== null || this.chunker !== null
      || this.abortControllers.size > 0 || this.playingControllers.size > 0;
    this.teardown({});
    this.skipReportedForTurn = false;
    this.playbackStoppedForTurn = false;
    if (message && wasActive) this.notice(`[TTS] ${message}`);
    return wasActive;
  }

  /**
   * The one teardown every stop goes through. `keepAudible` leaves the sink,
   * the chunk being heard and the playback chain alone so that chunk can
   * finish (the exit drain).
   */
  private teardown(options: { readonly keepAudible?: boolean }): void {
    this.releaseTurn();
    this.chunker?.reset();
    this.chunker = null;
    this.resetPipeline();
    for (const controller of this.abortControllers) controller.abort();
    this.abortControllers.clear();
    if (options.keepAudible) return;
    for (const controller of this.playingControllers) controller.abort();
    this.playingControllers.clear();
    this.sink.stop();
    this.playbackChain = Promise.resolve();
  }

  /**
   * Exit-path teardown: drops everything not yet audible (buffered text,
   * queued chunks) but lets the audio the user is already hearing finish
   * naturally, capped at `drainTimeoutMs`, before the hard stop. Deliberate
   * interrupts (Ctrl+C, /voice stop, turn cancel) keep their instant path
   * through stop(); this is only for exiting the app while the final audio of
   * a completed response is still draining.
   */
  async stopForExit(drainTimeoutMs = 2000): Promise<void> {
    const generation = this.pipelineGeneration;
    this.exitDrainGeneration = generation;
    this.teardown({ keepAudible: true });
    await this.sink.waitForDrain(drainTimeoutMs);
    // A replacement turn must not be stopped by an older drain completion.
    if (this.exitDrainGeneration === generation) this.stop();
  }

  async handleTurnEvent(event: TurnEvent): Promise<void> {
    try {
      if (event.type === 'TURN_SUBMITTED') {
        if (isSpokenTurnOrigin(event.origin) || this.speakAllTurns()) this.startTurn(event.turnId);
        return;
      }
      if (!this.activeTurnId || event.turnId !== this.activeTurnId) return;

      if (event.type === 'STREAM_DELTA') {
        let chunks: string[];
        try { chunks = this.chunker?.push(event.content) ?? []; }
        catch (error) {
          this.stop(`Spoken output stopped: ${summarizeError(error)}. The text reply continues.`);
          return;
        }
        this.queueTexts(chunks);
        return;
      }
      if (event.type === 'DRAFT_WITHDRAWN') {
        // The draft was sent back: what is not yet audible is dropped and the
        // replacement is chunked from its start. The turn keeps its playback.
        this.chunker?.reset();
        this.resetPipeline();
        for (const controller of this.abortControllers) controller.abort();
        this.abortControllers.clear();
        return;
      }
      if (event.type === 'TURN_COMPLETED') {
        this.finishTurn(event.turnId);
        return;
      }
      if (event.type === 'TURN_CANCEL' || event.type === 'TURN_ERROR' || event.type === 'PREFLIGHT_FAIL') {
        this.stop(event.type === 'TURN_CANCEL' ? 'Spoken output stopped.' : 'Spoken output stopped because the turn did not complete.');
      }
    } catch {
      // Event buses deliberately do not await us. Host callbacks must never
      // turn a speech-only failure into an unhandled rejected promise.
      try { this.stop(); } catch { /* Host teardown can fail too; text continues. */ }
    }
  }

  private startTurn(turnId: string): void {
    // A new spoken turn replaces whatever was being said.
    this.stop();
    if (!this.sink.available) {
      if (!this.noSinkNoticed) {
        this.noSinkNoticed = true;
        this.notice('[TTS] Text response will continue, but live audio is unavailable. Install mpv or ffplay.');
      }
      return;
    }
    this.noSinkNoticed = false;
    this.activeTurnId = turnId;
    this.chunkSequence = 0;
    this.turnConfig = this.readTurnConfig();
    const subscribe = this.configManager.subscribe?.bind(this.configManager);
    if (subscribe) {
      const unsubscribes = TURN_CONFIG_KEYS.map(key => subscribe(key, () => this.onTurnConfigChanged(turnId)));
      this.unsubscribeConfig = () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
    }
    this.chunker = new TtsTextChunker({ now: this.now });
    this.startTimer();
    // Playback starting is heard, not announced: a routine start is not a notice.
  }

  private onTurnConfigChanged(turnId: string): void {
    if (this.activeTurnId !== turnId || !this.turnConfig) return;
    const current = this.readTurnConfig();
    const started = this.turnConfig;
    if (current.provider === started.provider && current.voice === started.voice && current.speed === started.speed) return;
    this.stop('Spoken output stopped: tts.provider, tts.voice or tts.speed changed during this reply. The next reply uses the new settings.');
  }

  private finishTurn(turnId: string): void {
    this.queueTexts(this.chunker?.flushAll() ?? []);
    if (turnId !== this.activeTurnId) return;
    this.stopTimer();
    this.completedTurnId = turnId;
    // Nothing pending and nothing in flight releases immediately; otherwise
    // the last pipeline slot to free performs the release.
    this.maybeReleaseTurn();
  }

  private readTurnConfig(): TurnConfig {
    return { provider: readOptionalConfigString(this.configManager, 'tts.provider'),
      voice: readOptionalConfigString(this.configManager, 'tts.voice'),
      speed: readOptionalConfigNumber(this.configManager, 'tts.speed') };
  }

  /** Ends the turn's ownership: the active id, the timer and the settings subscription. */
  private releaseTurn(): void {
    this.activeTurnId = null;
    this.completedTurnId = null;
    this.stopTimer();
    this.unsubscribeConfig?.(); this.unsubscribeConfig = undefined;
    this.turnConfig = undefined;
  }

  private resetPipeline(): void {
    this.pendingTexts = [];
    this.pipelineDepth = 0;
    this.pipelineGeneration++;
    this.completedTurnId = null;
  }

  private startTimer(): void {
    this.stopTimer();
    this.timer = this.setIntervalImpl(() => {
      if (!this.activeTurnId || !this.chunker) return;
      try { this.queueTexts(this.chunker.flushDue()); } catch { /* The next tick or turn end flushes it. */ }
    }, 250);
    // The flush loop must not keep the process alive after the host has shut down.
    this.timer?.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }

  /**
   * Chunker output does NOT map 1:1 to synthesis requests. Text queues here
   * and the pump merges everything pending into one request whenever a
   * pipeline slot is free, so the request count tracks how often the model
   * out-paces the audio, not how many sentences it wrote. A short answer that
   * arrives before the first pump tick is exactly one request.
   */
  private queueTexts(chunks: readonly string[]): void {
    if (chunks.length === 0) return;
    // Bounded backlog. A slow sink must not retain an unlimited response.
    if (this.pendingTexts.reduce((total, text) => total + text.length, 0)
      + chunks.reduce((total, text) => total + text.length, 0) > 65_536) {
      this.stop('Spoken output stopped: the reply is arriving much faster than it can be spoken (over 64 KiB waiting). The text reply continues.');
      return;
    }
    for (const chunk of chunks) {
      if (chunk.trim()) this.pendingTexts.push(chunk);
    }
    if (this.pendingTexts.length > 0) this.schedulePump();
  }

  /**
   * Deferred one tick so text delivered in the same synchronous burst (fast
   * deltas, or a turn that completes instantly) coalesces into a single
   * request instead of firing per sentence boundary.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeTurnId && this.pendingTexts.length > 0 && this.pipelineDepth < SYNTHESIS_PIPELINE_WINDOW) {
      this.dispatchChunk(this.takeMergedText());
    }
    this.maybeReleaseTurn();
  }

  /**
   * Merge everything pending into one request, capped at the per-request text
   * limit. Chunker pieces end on whole words, so a space joins them.
   */
  private takeMergedText(): string {
    let merged = '';
    while (this.pendingTexts.length > 0) {
      const next = this.pendingTexts[0]!;
      if (!merged && next.length > SYNTHESIS_MERGE_MAX_CHARS) {
        // A single oversized entry (e.g. a large end-of-turn flush): split at
        // a word boundary under the per-request cap; the rest stays queued.
        const cut = findSplitIndex(next, SYNTHESIS_MERGE_MAX_CHARS);
        this.pendingTexts[0] = next.slice(cut).trim();
        return next.slice(0, cut).trim();
      }
      if (merged && merged.length + 1 + next.length > SYNTHESIS_MERGE_MAX_CHARS) break;
      merged = merged ? `${merged} ${next}` : next;
      this.pendingTexts.shift();
    }
    return merged;
  }

  private dispatchChunk(text: string): void {
    const turnId = this.activeTurnId;
    const config = this.turnConfig;
    if (!turnId || !config || !text.trim()) return;
    const sequence = ++this.chunkSequence;
    const generation = this.pipelineGeneration;
    this.pipelineDepth++;
    const abortController = new AbortController();
    const signal = abortController.signal;
    this.abortControllers.add(abortController);
    const resultPromise = this.synthesizeWithRetry(text, config, turnId, sequence, signal)
      .then((result) => ({ ok: true as const, result }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    this.playbackChain = this.playbackChain.then(async () => {
      try {
        if (signal.aborted) return;
        const result = await resultPromise;
        // An abort that landed while synthesis was in flight (a stop or an
        // exit) makes the rejection expected: it is not reported, and it must
        // not hard-stop a sink that may still be draining the previous chunk.
        if (signal.aborted) return;
        if (!result.ok) {
          // Retries are exhausted (or the failure was not transient). Skip
          // just this chunk and keep speaking the rest of the turn, a gap in
          // speech beats losing the whole response.
          this.reportSkippedChunk(result.error);
          return;
        }
        this.abortControllers.delete(abortController);
        this.playingControllers.add(abortController);
        await this.sink.play(guardAudio(result.result.chunks, signal), {
          format: String(result.result.format ?? 'mp3'),
          signal,
        });
      } catch (error) {
        if (!signal.aborted) this.reportError(error);
      } finally {
        this.abortControllers.delete(abortController);
        this.playingControllers.delete(abortController);
        this.releasePipelineSlot(generation);
      }
    });
  }

  private releasePipelineSlot(generation: number): void {
    if (generation !== this.pipelineGeneration) return;
    this.pipelineDepth = Math.max(0, this.pipelineDepth - 1);
    if (this.pendingTexts.length > 0) {
      this.schedulePump();
      return;
    }
    this.maybeReleaseTurn();
  }

  private maybeReleaseTurn(): void {
    if (!this.completedTurnId || this.completedTurnId !== this.activeTurnId) return;
    if (this.pendingTexts.length > 0 || this.pipelineDepth > 0 || this.pumpScheduled) return;
    this.releaseTurn();
    this.chunker = null;
    this.abortControllers.clear();
  }

  private async synthesizeWithRetry(
    text: string, config: TurnConfig, turnId: string, sequence: number, signal: AbortSignal,
  ): Promise<VoiceSynthesisStreamResult> {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        return await this.voiceService.synthesizeStream(config.provider, {
          text,
          voiceId: config.voice,
          format: 'mp3',
          speed: config.speed,
          signal,
          metadata: { source: this.source, feature: 'live-tts', turnId, sequence },
        });
      } catch (error) {
        signal.throwIfAborted();
        // The failure table decides from status, Retry-After, errno and error
        // class; a failure with none of them is not retried.
        const failure = classifyFailure(error);
        if (attempt >= SYNTHESIS_RETRY_DELAYS_MS.length || !failure?.retryable) throw error;
        if (failure.retryAfterMs !== undefined && failure.retryAfterMs > SYNTHESIS_RETRY_AFTER_CAP_MS) throw error;
        await this.delay(failure.retryAfterMs ?? SYNTHESIS_RETRY_DELAYS_MS[attempt]!, signal);
      }
    }
  }

  /** Abortable backoff sleep, an abort clears the timer and rejects, so a stop mid-backoff leaves nothing running. */
  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Synthesis retry cancelled'));
        return;
      }
      const timer = this.setTimeoutImpl(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        this.clearTimeoutImpl(timer);
        reject(new Error('Synthesis retry cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private notice(message: string): void {
    try { this.notify?.(message); } catch { /* A broken notifier cannot reject background speech work. */ }
  }

  /**
   * One synthesis request failed after its retries. Report once per turn and
   * keep going, the rest of the response still plays.
   */
  private reportSkippedChunk(error: unknown): void {
    if (this.skipReportedForTurn) return;
    this.skipReportedForTurn = true;
    this.notice(`[TTS] Skipping part of the spoken response, synthesis kept failing (${summarizeError(error)}). Playback continues with the rest.`);
  }

  private reportError(error: unknown): void {
    if (this.playbackStoppedForTurn) return;
    this.playbackStoppedForTurn = true;
    this.teardown({});
    this.notice(`[TTS] Live playback stopped: ${summarizeError(error)}`);
  }
}

/** Split point at or under `limit`, preferring the last word boundary. */
function findSplitIndex(text: string, limit: number): number {
  const space = text.lastIndexOf(' ', limit);
  return space > 0 ? space : limit;
}

function readOptionalConfigString(configManager: Pick<ConfigManager, 'get'>, key: ConfigKey): string | undefined {
  const value = String(configManager.get(key) ?? '').trim();
  return value || undefined;
}

/**
 * readOptionalConfigNumber, reads a numeric config value by key.
 *
 * Accepts a string key and casts it, returning undefined when the value is
 * absent, zero, or not a finite positive number.
 */
function readOptionalConfigNumber(configManager: Pick<ConfigManager, 'get'>, key: string): number | undefined {
  const raw = configManager.get(key as ConfigKey);
  const value = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
  return isFinite(value) && value > 0 ? value : undefined;
}

/** One boolean read per audio chunk: the chunk's own abort signal. */
async function* guardAudio(chunks: AsyncIterable<VoiceAudioChunk>, signal: AbortSignal): AsyncIterable<VoiceAudioChunk> {
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    yield chunk;
  }
}
