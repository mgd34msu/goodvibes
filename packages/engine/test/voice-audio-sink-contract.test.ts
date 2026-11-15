import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '../platform/src/events/turn.js';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '../platform/src/platform/voice/types.js';
import { SpokenTurnController } from '../platform/src/platform/voice/spoken-turn/controller.js';
import type { AudioSink } from '../platform/src/platform/voice/spoken-turn/audio-sink.js';
import { withTestTimeout } from './_helpers/test-timeout.js';

/**
 * These tests pin the AudioSink BEHAVIORAL CONTRACT (readiness / head survival,
 * natural drain, abort cut, bounded waitForDrain) from the policy engine's
 * point of view, the guarantees the controller relies on and that a real sink
 * (the subprocess player, the browser Web Audio sink) must honor. The
 * subprocess-level implementation of the head gate and drain lives with the
 * consumer's sink and is pinned by that consumer's player-playback tests; here
 * we prove the controller depends only on the contract, using a conformant
 * fake sink.
 */

function turn(event: TurnEvent): TurnEvent {
  return event;
}

async function* multiByteChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  // Emit one byte per character so a mid-stream abort is observable at a fine
  // grain, a real MP3 stream arrives as many small chunks.
  const bytes = new TextEncoder().encode(text);
  let sequence = 0;
  for (const b of bytes) {
    sequence += 1;
    yield { data: new Uint8Array([b]), sequence, format: 'mp3' };
  }
}

function voiceServiceFor(makeChunks: (text: string) => AsyncIterable<VoiceAudioChunk>) {
  return {
    async synthesizeStream(providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      return {
        providerId: providerId ?? 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: makeChunks(request.text),
        metadata: {},
      };
    },
  };
}

/** A promise and the function that settles it, so a test waits for an event instead of a delay. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('AudioSink contract: readiness / head survival', () => {
  test('a sink that delays its internal readiness still plays every byte in order (no head loss)', async () => {
    const received: number[] = [];
    let readinessOpened = false;
    const ready = deferred();
    const played = deferred();

    const sink: AudioSink = {
      label: 'delayed-readiness',
      available: true,
      async play(chunks, options) {
        // Contract 1: hold the head until the output is actually up. Model a
        // startup that resolves only after the whole turn was handed over; the
        // controller has already handed us the whole stream and only awaits this play().
        await ready.promise;
        readinessOpened = true;
        for await (const chunk of chunks) {
          if (options.signal?.aborted) break;
          received.push(...chunk.data);
        }
        played.resolve();
      },
      stop() {},
      async waitForDrain() {},
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'r1', prompt: 'greeting', origin: { source: 'tts' } }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'r1', content: 'Hello.', accumulated: 'Hello.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'r1', response: 'Hello.', stopReason: 'completed' }));
    expect(readinessOpened).toBe(false);
    ready.resolve();
    await withTestTimeout(played.promise, 5_000, 'the sink never received the stream');

    expect(readinessOpened).toBe(true);
    // Every byte survived, in order, including the leading 'H'.
    expect(new TextDecoder().decode(new Uint8Array(received))).toBe('Hello.');
  });
});

describe('AudioSink contract: abort cuts immediately', () => {
  test('a deliberate stop cuts the currently-playing sink mid-stream before the bytes finish', async () => {
    // The chunk that is actively playing has already been removed from the
    // controller's abort set (its signal is released before playback begins),
    // so a deliberate stop cuts it through sink.stop(), the imperative
    // instant-cut half of the contract, not through the signal. (The signal
    // path short-circuits only queued chunks that have not started playing.)
    const received: number[] = [];
    let stopped = false;
    let sawStopCut = false;
    // Created when playback starts, so the controller's own reset of the sink at the
    // start of a turn cannot release it early.
    let gateReleased: (() => void) | undefined;
    const firstByte = deferred();
    const cut = deferred();

    const sink: AudioSink = {
      label: 'stoppable',
      available: true,
      async play(chunks, options) {
        // The controller also resets the sink when a turn starts; only a stop that lands while this stream plays counts.
        stopped = false;
        const gate = new Promise<void>((resolve) => { gateReleased = resolve; });
        let count = 0;
        for await (const chunk of chunks) {
          if (stopped || options.signal?.aborted) { sawStopCut = true; cut.resolve(); return; }
          received.push(...chunk.data);
          count += 1;
          // After the first byte, pause until the test releases the gate; the
          // deliberate stop lands during this pause.
          if (count === 1) { firstByte.resolve(); await gate; }
          if (stopped || options.signal?.aborted) { sawStopCut = true; cut.resolve(); return; }
        }
      },
      stop() { stopped = true; gateReleased?.(); },
      async waitForDrain() {},
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'a1', prompt: 'long line', origin: { source: 'tts' } }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'a1', content: 'Abcdefgh.', accumulated: 'Abcdefgh.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'a1', response: 'Abcdefgh.', stopReason: 'completed' }));
    await withTestTimeout(firstByte.promise, 5_000, 'the sink never received the first byte');

    // One byte in, then a deliberate stop: sink.stop() cuts the active stream.
    controller.stop();
    await withTestTimeout(cut.promise, 5_000, 'the stop never cut the playing stream');

    expect(sawStopCut).toBe(true);
    // The cut happened before the full stream was consumed.
    expect(received.length).toBeLessThan('Abcdefgh.'.length);
  });
});

describe('AudioSink contract: bounded waitForDrain on exit', () => {
  test('stopForExit resolves within the drain window even when the sink never finishes naturally', async () => {
    let waitForDrainMs: number | null = null;
    const playing = deferred();

    const sink: AudioSink = {
      label: 'never-finishes',
      available: true,
      async play(chunks) {
        playing.resolve();
        for await (const _chunk of chunks) { /* consume */ }
        // Model a sink still holding the device open after all bytes are in.
        await new Promise<void>(() => { /* never resolves on its own */ });
      },
      stop() {},
      waitForDrain(timeoutMs) {
        waitForDrainMs = timeoutMs;
        // Contract 4: bounded, resolves within the window it was given, never hangs.
        return Promise.resolve();
      },
    };
    const controller = new SpokenTurnController({
      voiceService: voiceServiceFor(multiByteChunks),
      configManager: { get: () => '' } as never,
      sink,
      setInterval: (() => 1) as never,
      clearInterval: (() => {}) as never,
    });
    controller.handleTurnEvent(turn({ type: 'TURN_SUBMITTED', turnId: 'd1', prompt: 'draining answer', origin: { source: 'tts' } }));
    controller.handleTurnEvent(turn({ type: 'STREAM_DELTA', turnId: 'd1', content: 'Tail.', accumulated: 'Tail.' }));
    controller.handleTurnEvent(turn({ type: 'TURN_COMPLETED', turnId: 'd1', response: 'Tail.', stopReason: 'completed' }));
    await withTestTimeout(playing.promise, 5_000, 'the sink never started playing');

    // play() never settles, so a stopForExit that waited on playback instead of
    // the bounded drain would hang; the guard turns that into a named failure.
    await withTestTimeout(controller.stopForExit(30), 5_000, 'stopForExit did not return while the sink never finished');

    // The exit path forwarded its budget to waitForDrain.
    expect(waitForDrainMs as number | null).toBe(30);
  });
});
