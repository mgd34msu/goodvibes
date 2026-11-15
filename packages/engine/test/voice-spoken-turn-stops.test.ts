/**
 * voice-spoken-turn-stops.test.ts
 *
 * Every way spoken output stops mid-reply says so, and a skipped chunk earlier
 * in a turn never suppresses the teardown and notice of a later playback
 * failure.
 */
import { describe, expect, test } from 'bun:test';
import type { TurnEvent } from '../platform/src/events/turn.js';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '../platform/src/platform/voice/types.js';
import { SpokenTurnController } from '../platform/src/platform/voice/spoken-turn/controller.js';
import type { AudioSink } from '../platform/src/platform/voice/spoken-turn/audio-sink.js';
async function* audio(text: string): AsyncIterable<VoiceAudioChunk> {
  yield { data: new TextEncoder().encode(text), sequence: 1, format: 'mp3' };
}
const drain = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function harness(options: {
  failSynthesis?: (text: string) => boolean;
  failPlayback?: (text: string) => boolean;
  config?: Record<string, unknown>;
} = {}) {
  const messages: string[] = [];
  const played: string[] = [];
  const config: Record<string, unknown> = { 'tts.provider': 'p', 'tts.voice': 'v', ...options.config };
  const listeners = new Map<string, Set<() => void>>();
  const setConfig = (key: string, value: unknown) => { config[key] = value; for (const listener of listeners.get(key) ?? []) listener(); };
  const voiceService = {
    async synthesizeStream(_provider: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      if (options.failSynthesis?.(request.text)) throw new Error('HTTP 429: too many requests');
      return { providerId: 'fake', mimeType: 'audio/mpeg', format: 'mp3', chunks: audio(request.text), metadata: {} };
    },
  };
  const sink: AudioSink = {
    label: 'fake-sink',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        const text = new TextDecoder().decode(chunk.data);
        if (options.failPlayback?.(text)) throw new Error('player exited');
        played.push(text);
      }
    },
    stop() {},
    async waitForDrain() {},
  };
  const controller = new SpokenTurnController({
    voiceService,
    configManager: {
      get: ((key: string) => config[key] ?? '') as never,
      subscribe: ((key: string, listener: () => void) => {
        const set = listeners.get(key) ?? new Set(); set.add(listener); listeners.set(key, set);
        return () => { set.delete(listener); };
      }) as never,
    },
    sink,
    notify: (message) => messages.push(message),
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
    setTimeout: ((cb: () => void) => { queueMicrotask(cb); return 0; }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  });
  const start = async (turnId: string) => {
    await controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId, prompt: `prompt ${turnId}`, origin: { source: 'tts' } } as TurnEvent);
  };
  const delta = (turnId: string, content: string) =>
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId, content, accumulated: '' } as TurnEvent);
  return { controller, messages, played, setConfig, start, delta };
}

describe('a skipped chunk followed by a playback failure', () => {
  test('still tears down and says playback stopped', async () => {
    const h = harness({ failSynthesis: (text) => text.startsWith('First'), failPlayback: (text) => text.startsWith('Second') });
    await h.start('t1');
    await h.delta('t1', 'First part that cannot be synthesized. ');
    await drain();
    expect(h.messages.some((m) => m.includes('Skipping part of the spoken response'))).toBe(true);
    await h.delta('t1', 'Second part whose player dies. ');
    await drain();
    expect(h.messages.some((m) => m.includes('Live playback stopped'))).toBe(true);
    expect(h.controller.phase).toBe('idle');
  });
});

describe('stops that used to be silent', () => {
  test('a voice setting changed mid-reply names the change', async () => {
    const h = harness();
    await h.start('t2');
    expect(h.controller.phase).toBe('speaking');
    h.setConfig('tts.voice', 'other-voice');
    await drain();
    expect(h.messages.join('\n')).toContain('tts.provider, tts.voice or tts.speed changed during this reply');
    expect(h.controller.phase).toBe('idle');
  });

  test('a backlog too large to speak says so', async () => {
    const h = harness();
    await h.start('t3');
    await h.delta('t3', `${'word '.repeat(14_000)}. `);
    await drain();
    expect(h.messages.join('\n')).toContain('faster than it can be spoken');
  });
});

describe('phase', () => {
  test('reads idle, then speaking', async () => {
    const h = harness();
    expect(h.controller.phase).toBe('idle');
    await h.controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't4', prompt: 'hello', origin: { source: 'tts' } } as TurnEvent);
    expect(h.controller.phase).toBe('speaking');
    h.controller.stop();
    expect(h.controller.phase).toBe('idle');
  });
});
