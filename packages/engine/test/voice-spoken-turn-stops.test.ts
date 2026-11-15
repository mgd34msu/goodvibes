/**
 * voice-spoken-turn-stops.test.ts
 *
 * Every way spoken output stops mid-reply says so, and a skipped chunk earlier
 * in a turn never suppresses the teardown and notice of a later playback
 * failure.
 */
import { isProxy } from 'node:util/types';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { TurnEvent } from '../platform/src/events/turn.js';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '../platform/src/platform/voice/types.js';
import { SpokenTurnController } from '../platform/src/platform/voice/spoken-turn/controller.js';
import type { AudioSink } from '../platform/src/platform/voice/spoken-turn/audio-sink.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

function failurePort() {
  return fakePort((name, question) => {
    if (name.startsWith('seam_')) return noulAnswer(0.99);
    if (name === 'category') return choiceAnswer(question, 'rate_limit', 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    return noulAnswer(0.01);
  });
}
let previousPort: JudgmentPort | undefined;
beforeEach(() => { previousPort = installJudgmentPort(failurePort().port); });
afterEach(() => { installJudgmentPort(previousPort); });

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
    rejectFailureObject: isProxy,
    configManager: { get: (key: string) => config[key] ?? '' } as never,
    sink,
    notify: (message) => messages.push(message),
    setInterval: (() => 1) as never,
    clearInterval: (() => {}) as never,
    setTimeout: ((cb: () => void) => { queueMicrotask(cb); return 0; }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  });
  const start = async (turnId: string) => {
    expect(controller.submitNextTurn(`prompt ${turnId}`)).toBe(true);
    await controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId, prompt: `prompt ${turnId}` } as TurnEvent);
  };
  const delta = (turnId: string, content: string) =>
    controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId, content, accumulated: '' } as TurnEvent);
  return { controller, messages, played, config, start, delta };
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
    h.config['tts.voice'] = 'other-voice';
    await h.delta('t2', 'A sentence spoken after the voice changed. ');
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
  test('reads idle, armed, then speaking', async () => {
    const h = harness();
    expect(h.controller.phase).toBe('idle');
    h.controller.submitNextTurn('hello');
    expect(h.controller.phase).toBe('armed');
    await h.controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't4', prompt: 'hello' } as TurnEvent);
    expect(h.controller.phase).toBe('speaking');
    h.controller.stop();
    expect(h.controller.phase).toBe('idle');
  });
});

describe('withdrawing an arm', () => {
  test('a turn that never reaches submission has its arm withdrawn, so the next stop is not consumed', () => {
    const h = harness();
    const arm = h.controller.armNextTurn('prompt that never runs');
    expect(h.controller.phase).toBe('armed');
    expect(arm?.disarm()).toBe(true);
    expect(h.controller.phase).toBe('idle');
    expect(h.controller.stop('Spoken output stopped.')).toBe(false);
    expect(h.messages).toEqual([]);
  });

  test('withdrawing an arm that a newer arm replaced leaves the newer one in place', () => {
    const h = harness();
    const older = h.controller.armNextTurn('same prompt');
    const newer = h.controller.armNextTurn('same prompt');
    expect(older?.disarm()).toBe(false);
    expect(h.controller.phase).toBe('armed');
    expect(newer?.disarm()).toBe(true);
    expect(h.controller.phase).toBe('idle');
  });

  test('withdrawing an arm whose turn was submitted does not stop that turn', async () => {
    const h = harness();
    const arm = h.controller.armNextTurn('hello');
    await h.controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 't5', prompt: 'hello' } as TurnEvent);
    expect(h.controller.phase).toBe('speaking');
    expect(arm?.disarm()).toBe(false);
    expect(h.controller.phase).toBe('speaking');
    h.controller.stop();
  });

  test('an empty prompt arms nothing', () => {
    expect(harness().controller.armNextTurn('   ')).toBeNull();
  });
});
