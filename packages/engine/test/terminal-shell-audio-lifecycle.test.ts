/**
 * Lifecycle behaviour of the terminal audio pieces: the streaming player's sink and the
 * wake runtime's reaction to settings that change while it is listening.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { VoiceAudioChunk } from '@goodvibes-jev/engine/platform/platform/voice';
import { LocalStreamingAudioPlayer } from '../terminal-shell/src/audio/player.ts';
import { createTerminalWakeRuntime } from '../terminal-shell/src/audio/wake-runtime.ts';

class FakeSink extends EventEmitter {
  killed = false;
  stdinDestroyed = false;
  stdinEnded = false;
  readonly stdin = {
    write: (_data: unknown, cb?: (error?: Error | null) => void): boolean => {
      cb?.(this.stdinDestroyed ? new Error('stream destroyed') : null);
      return true;
    },
    end: (): void => { this.stdinEnded = true; },
    destroy: (): void => { this.stdinDestroyed = true; },
  };
  kill(): boolean { this.killed = true; return true; }
}

function playerFor(sink: FakeSink): LocalStreamingAudioPlayer {
  return new LocalStreamingAudioPlayer({
    command: { command: '/fake/mpv', args: ['-'], label: 'fake-mpv' },
    spawnProcess: (() => sink) as never,
  });
}

const chunk = (n: number): VoiceAudioChunk => ({ data: new Uint8Array([n]), sequence: n, format: 'mp3' });
const settle = async (): Promise<void> => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

describe('streaming player', () => {
  test('a stream that fails part-way tears the sink down instead of leaving it reading', async () => {
    const sink = new FakeSink();
    const player = playerFor(sink);
    async function* failing(): AsyncIterable<VoiceAudioChunk> {
      yield chunk(1);
      throw new Error('synthesis stream failed');
    }
    const playing = player.play(failing(), {});
    sink.emit('spawn');
    await expect(playing).rejects.toThrow('synthesis stream failed');
    expect(sink.killed).toBe(true);
    expect(sink.stdinDestroyed).toBe(true);
  });

  test('a sink that exited while the stream was idle does not leave play() waiting forever', async () => {
    const sink = new FakeSink();
    const player = playerFor(sink);
    let finishStream: () => void = () => {};
    const idle = new Promise<void>((resolve) => { finishStream = resolve; });
    async function* paused(): AsyncIterable<VoiceAudioChunk> {
      yield chunk(1);
      await idle;
    }
    const playing = player.play(paused(), {});
    sink.emit('spawn');
    await settle();
    sink.emit('close');
    finishStream();
    await playing;
    expect(sink.stdinEnded).toBe(true);
  });

  test('an interrupt during a pending write is not reported as a playback failure', async () => {
    const sink = new FakeSink();
    const player = playerFor(sink);
    const controller = new AbortController();
    // The write callback runs after the interrupt destroyed stdin, the way a real pipe reports it.
    let pendingWrite: ((error?: Error | null) => void) | undefined;
    sink.stdin.write = (_data, cb) => { pendingWrite = cb; return true; };
    async function* one(): AsyncIterable<VoiceAudioChunk> { yield chunk(1); }
    const playing = player.play(one(), { signal: controller.signal });
    sink.emit('spawn');
    await settle();
    controller.abort();
    pendingWrite?.(new Error('ERR_STREAM_DESTROYED'));
    await playing;
  });

  test('a natural end still waits for the sink to drain and does not kill it', async () => {
    const sink = new FakeSink();
    const player = playerFor(sink);
    async function* one(): AsyncIterable<VoiceAudioChunk> { yield chunk(1); }
    let done = false;
    const playing = player.play(one(), {}).then(() => { done = true; });
    sink.emit('spawn');
    await settle();
    expect(done).toBe(false);
    expect(sink.stdinEnded).toBe(true);
    sink.emit('close');
    await playing;
    expect(sink.killed).toBe(false);
  });

  test('a player that exits with an error is reported with its exit code, not as played', async () => {
    const sink = new FakeSink();
    const player = playerFor(sink);
    async function* one(): AsyncIterable<VoiceAudioChunk> { yield chunk(1); }
    const playing = player.play(one(), {});
    sink.emit('spawn');
    await settle();
    sink.emit('close', 2, null);
    await expect(playing).rejects.toThrow('exited with code 2');
  });

  test('stop() cuts every sound the player started, not only the last', async () => {
    const sinks = [new FakeSink(), new FakeSink()];
    let next = 0;
    const player = new LocalStreamingAudioPlayer({
      command: { command: '/fake/mpv', args: ['-'], label: 'fake-mpv' },
      spawnProcess: (() => sinks[next++]) as never,
    });
    async function* one(): AsyncIterable<VoiceAudioChunk> { yield chunk(1); }
    const first = player.play(one(), {});
    const second = player.play(one(), {});
    for (const sink of sinks) sink.emit('spawn');
    await settle();
    player.stop();
    for (const sink of sinks) sink.emit('close', null, 'SIGTERM');
    await Promise.all([first, second]);
    expect(sinks.map((sink) => sink.killed)).toEqual([true, true]);
  });
});

describe('wake runtime settings applied while listening', () => {
  const { startWakeRuntime } = createTerminalWakeRuntime({
    surface: 'tui',
    capabilities: () => ({}),
    provisionOnEnable: false,
    missingModels: (reason) => reason,
    draftNotice: '',
    captureFailure: (error) => error,
    describeBlockers: () => [],
    describeLimitations: () => [],
    describeTranscriptionFailure: String,
  });

  function wire() {
    const calls: string[] = [];
    const listeners = new Map<string, () => void>();
    const runtime = {
      refresh: async () => { calls.push('refresh'); },
      stop: async () => { calls.push('stop'); },
    };
    startWakeRuntime(runtime as never, { subscribeConfig: (key, listener) => { listeners.set(key, listener); return () => {}; } });
    calls.length = 0;
    return { calls, listeners };
  }

  test('a change to the input device or recorder restarts the listener', async () => {
    for (const key of ['voice.wake.inputDevice', 'voice.wake.captureCommand', 'voice.wake.models']) {
      const { calls, listeners } = wire();
      listeners.get(key)?.();
      await settle();
      expect(calls).toEqual(['stop', 'refresh']);
    }
  });

  test('a write that changes several restart rows restarts the listener once', async () => {
    const { calls, listeners } = wire();
    for (const key of ['voice.wake.inputDevice', 'voice.wake.captureCommand', 'voice.wake.models']) listeners.get(key)?.();
    await settle();
    expect(calls).toEqual(['stop', 'refresh']);
  });

  test('rows read per utterance or per status read do not restart it', async () => {
    for (const key of ['voice.wake.autoSubmit', 'voice.wake.retainAudio', 'voice.wake.indicator']) {
      const { calls, listeners } = wire();
      listeners.get(key)?.();
      await settle();
      expect(calls).toEqual([]);
    }
  });

  test('the enable rows still only refresh', async () => {
    const { calls, listeners } = wire();
    listeners.get('voice.wake.enabled')?.();
    await settle();
    expect(calls).toEqual(['refresh']);
  });
});
