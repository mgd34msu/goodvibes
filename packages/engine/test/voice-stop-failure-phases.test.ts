/**
 * A capture stream whose stop() rejects must not strand the voice phase: the wake
 * listener must reach `stopped` and accept start() again, and push-to-talk must
 * reach `idle`. The stop error is reported through the existing failure callback.
 */
import { describe, expect, test } from 'bun:test';
import { WakeWordEngine } from '../platform/src/platform/voice/wake/engine.js';
import { WakeListener } from '../platform/src/platform/voice/wake/listener.js';
import { resolveWakeRuntimeSettings } from '../platform/src/platform/voice/wake/settings.js';
import { WAKE_EMBED_DIM } from '../platform/src/platform/voice/wake/feature-pipeline.js';
import { voiceWakeConfigDefaults } from '../platform/src/platform/config/schema-domain-voice-wake.js';
import { PushToTalkSession } from '../platform/src/platform/voice/capture/push-to-talk.js';
import type { AudioCaptureOpener, AudioCaptureStream } from '../platform/src/platform/voice/capture/index.js';
import type { WakeInferenceSession } from '../platform/src/platform/voice/wake/types.js';

function failingStream(): AudioCaptureStream {
  return { label: 'parecord', deviceSelectable: true, stop: async () => { throw new Error('device would not release'); } };
}

function wakeReader(): (key: string) => unknown {
  const wake = voiceWakeConfigDefaults.voice.wake as unknown as Record<string, unknown>;
  return (key: string) => {
    if (key === 'voice.wake.enabled') return true;
    const leaf = key.replace('voice.wake.', '');
    if (leaf.startsWith('surfaces.')) return (wake['surfaces'] as Record<string, boolean>)[leaf.slice('surfaces.'.length)];
    return wake[leaf];
  };
}

describe('wake listener: stream.stop() rejects', () => {
  test('stop() still reaches stopped, clears the stopping flag, and reports the error', async () => {
    const settings = resolveWakeRuntimeSettings(wakeReader(), 'tui', { canRetainAudio: true, canPlayLocalFile: true });
    const failures: string[] = [];
    const embedding: WakeInferenceSession = {
      inputNames: ['i'], outputNames: ['embedding'],
      run: async () => ({ embedding: { data: new Float32Array(WAKE_EMBED_DIM), dims: [1, 1, 1, WAKE_EMBED_DIM] } }),
    };
    const classifier: WakeInferenceSession = {
      inputNames: ['i'], outputNames: ['output'],
      run: async () => ({ output: { data: Float32Array.from([0]), dims: [1, 1] } }),
    };
    const openCapture: AudioCaptureOpener = async () => failingStream();
    const listener = new WakeListener({
      settings,
      openCapture,
      createEngine: async () => new WakeWordEngine({
        embedding, models: [{ id: 'hey_goodvibes', session: classifier }], tuning: settings.tuning, preRollMs: settings.preRollMs,
      }),
      handlers: { onFailure: (error: { reason: string }, _restarting: unknown, detail: unknown) => failures.push(`${error.reason}: ${detail}`) },
      setTimeout: () => 1,
      clearTimeout: () => {},
    } as never);

    const started = await listener.start();
    expect(started).toMatchObject({ started: true });
    await listener.stop();
    expect(listener.state().phase).toBe('stopped');
    expect(failures.some((f) => f.includes('device would not release'))).toBe(true);
    // Not stuck on already-running: a fresh start is accepted.
    const again = await listener.start();
    expect(again.started === false && again.refusal === 'already-running').toBe(false);
    await listener.stop();
  });
});

describe('push-to-talk: stream.stop() rejects', () => {
  const capture = { device: '', backend: 'parecord' as const, noiseSuppression: 'none' as const, frameSamples: 1280 };
  function session(errors: string[], phases: string[]): PushToTalkSession {
    return new PushToTalkSession({
      openCapture: (async () => failingStream()) as AudioCaptureOpener,
      capture,
      captureMaxSeconds: 10,
      onPhaseChange: (p) => phases.push(p),
      onError: (e) => errors.push(e.message),
    });
  }

  test('stop() ends idle, returns the utterance, and reports the error', async () => {
    const errors: string[] = []; const phases: string[] = [];
    const s = session(errors, phases);
    await s.start();
    const utterance = await s.stop();
    expect(utterance).not.toBeNull();
    expect(s.phase).toBe('idle');
    expect(errors.join()).toContain('device would not release');
  });

  test('cancel() ends idle and reports the error', async () => {
    const errors: string[] = []; const phases: string[] = [];
    const s = session(errors, phases);
    await s.start();
    await s.cancel();
    expect(s.phase).toBe('idle');
    expect(errors.join()).toContain('device would not release');
  });
});
