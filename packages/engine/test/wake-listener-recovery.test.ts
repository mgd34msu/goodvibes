/**
 * wake-listener-recovery.test.ts
 *
 * Paths where wake listening used to end without anyone being told or without
 * ever coming back: a restart that finds no microphone, a device re-check whose
 * stop rejects, a stream that stops delivering after it had been working, a
 * model load failing on a timer-driven restart, and a cleared latch.
 */
import { describe, expect, test } from 'bun:test';
import { WakeWordEngine } from '../platform/src/platform/voice/wake/engine.js';
import { WakeListener } from '../platform/src/platform/voice/wake/listener.js';
import { resolveWakeRuntimeSettings } from '../platform/src/platform/voice/wake/settings.js';
import { WAKE_CHUNK_SAMPLES, WAKE_EMBED_DIM } from '../platform/src/platform/voice/wake/feature-pipeline.js';
import { voiceWakeConfigDefaults } from '../platform/src/platform/config/schema-domain-voice-wake.js';
import { AudioCaptureError } from '../platform/src/platform/voice/capture/index.js';
import type { AudioCaptureHandlers, AudioCaptureRequest } from '../platform/src/platform/voice/capture/index.js';
import type { AudioInputDevice } from '../platform/src/platform/voice/capture/device-binding.js';
import type { WakeInferenceSession } from '../platform/src/platform/voice/wake/types.js';

function reader(overrides: Readonly<Record<string, unknown>> = {}): (key: string) => unknown {
  const wake = voiceWakeConfigDefaults.voice.wake as unknown as Record<string, unknown>;
  return (key: string) => {
    if (key in overrides) return overrides[key];
    const leaf = key.replace('voice.wake.', '');
    if (leaf.startsWith('surfaces.')) return (wake['surfaces'] as Record<string, boolean>)[leaf.slice('surfaces.'.length)];
    return wake[leaf];
  };
}

const embedding: WakeInferenceSession = {
  inputNames: ['input_1'],
  outputNames: ['embedding'],
  run: async () => ({ embedding: { data: new Float32Array(WAKE_EMBED_DIM).fill(0.5), dims: [1, 1, 1, WAKE_EMBED_DIM] } }),
};
const silentClassifier: WakeInferenceSession = {
  inputNames: ['onnx::Flatten_0'],
  outputNames: ['output'],
  run: async () => ({ output: { data: Float32Array.from([0]), dims: [1, 1] } }),
};

const MIC: AudioInputDevice = { id: 'mic-1', label: 'Mic', isMonitor: false, isDefault: true };

interface Opened {
  readonly request: AudioCaptureRequest;
  readonly handlers: AudioCaptureHandlers;
  stopCalls: number;
}

function setup(options: {
  devices?: () => readonly AudioInputDevice[];
  stopRejects?: boolean;
  createEngine?: () => Promise<WakeWordEngine>;
  pin?: string;
  /** Capture opens from this attempt on (0-based) throw, as a recorder that will not start does. */
  failOpensFrom?: number;
} = {}) {
  let opens = 0;
  const settings = resolveWakeRuntimeSettings(reader({
    'voice.wake.enabled': true,
    'voice.wake.restartBackoffMs': 10,
    ...(options.pin !== undefined ? { 'voice.wake.inputDevice': options.pin } : {}),
  }), 'tui', { canRetainAudio: true, canPlayLocalFile: true });
  const opened: Opened[] = [];
  const timers: Array<{ handler: () => void; ms: number; cleared: boolean }> = [];
  const failures: Array<{ reason: string; restarting: boolean; detail: string }> = [];
  const listener = new WakeListener({
    settings,
    openCapture: async (request, handlers) => {
      if (options.failOpensFrom !== undefined && opens++ >= options.failOpensFrom) {
        throw new AudioCaptureError('device-unavailable', 'recorder would not start');
      }
      const entry: Opened = { request, handlers, stopCalls: 0 };
      opened.push(entry);
      return {
        label: 'fake',
        deviceSelectable: true,
        stop: async () => {
          entry.stopCalls += 1;
          if (options.stopRejects) throw new Error('device busy');
        },
      };
    },
    createEngine: options.createEngine ?? (async () => new WakeWordEngine({
      embedding,
      models: [{ id: 'hey_goodvibes', session: silentClassifier }],
      tuning: settings.tuning,
      preRollMs: settings.preRollMs,
    })),
    ...(options.devices ? { enumerateInputDevices: async () => options.devices!() } : {}),
    handlers: { onFailure: (error, restarting, detail) => failures.push({ reason: error.reason, restarting, detail }) },
    setTimeout: (handler, ms) => { const timer = { handler, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    deviceRecheckMs: 1_000,
    frameGapTimeoutMs: 3_000,
  });
  const live = (ms: number) => timers.filter((timer) => timer.ms === ms && !timer.cleared);
  const fire = async (ms: number) => {
    const timer = live(ms).at(-1);
    if (!timer) throw new Error(`no live ${ms} ms timer`);
    timer.cleared = true;
    timer.handler();
    for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const fireLatest = async () => {
    const timer = timers.filter((candidate) => !candidate.cleared).at(-1);
    if (!timer) throw new Error('no live timer');
    await fire(timer.ms);
  };
  const frame = () => opened.at(-1)!.handlers.onFrame(new Float32Array(WAKE_CHUNK_SAMPLES));
  return { listener, opened, timers, failures, live, fire, fireLatest, frame };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0)); };

describe('a restart that finds no microphone', () => {
  test('waits for one and reopens when it comes back, instead of stopping for good', async () => {
    let devices: readonly AudioInputDevice[] = [MIC];
    const h = setup({ devices: () => devices });
    expect((await h.listener.start()).started).toBe(true);
    h.opened[0]!.handlers.onStopped('failed', new AudioCaptureError('stream-ended', 'recorder exited'));
    await settle();
    devices = [];
    await h.fire(10);
    expect(h.listener.state().phase).toBe('restarting');
    expect(h.failures.at(-1)).toMatchObject({ reason: 'device-missing', restarting: true });
    expect(h.live(60_000)).toHaveLength(1);

    devices = [MIC];
    await h.fire(60_000);
    expect(h.opened).toHaveLength(2);
    expect(h.listener.state().phase).toBe('listening');
  });

  test('a start() that finds no microphone arms nothing', async () => {
    const h = setup({ devices: () => [] });
    const outcome = await h.listener.start();
    expect(outcome).toMatchObject({ started: false, refusal: 'no-microphone' });
    expect(h.live(60_000)).toHaveLength(0);
    expect(h.listener.state().phase).toBe('idle');
  });
});

describe('a device re-check whose stop rejects', () => {
  test('still reopens on the returned pin rather than stranding listening with no stream', async () => {
    let devices: readonly AudioInputDevice[] = [MIC];
    const h = setup({ devices: () => devices, pin: 'headset', stopRejects: true });
    expect((await h.listener.start()).started).toBe(true);
    expect(h.listener.state().deviceBinding?.state).toBe('fallback');
    devices = [MIC, { id: 'headset', label: 'Headset', isMonitor: false }];
    await h.fire(1_000);
    expect(h.opened).toHaveLength(2);
    expect(h.opened[1]!.request.device).toBe('headset');
    expect(h.listener.state().phase).toBe('listening');
    expect(h.listener.state().captureOpen).toBe(true);
  });
});

describe('a device re-check whose reopen fails', () => {
  test('is a failed stream for the supervisor to restart, not a working fallback silently dropped', async () => {
    let devices: readonly AudioInputDevice[] = [MIC];
    const h = setup({ devices: () => devices, pin: 'headset', failOpensFrom: 1 });
    expect((await h.listener.start()).started).toBe(true);
    devices = [MIC, { id: 'headset', label: 'Headset', isMonitor: false }];
    await h.fire(1_000);
    expect(h.failures.at(-1)).toMatchObject({ reason: 'device-unavailable', restarting: true });
    expect(h.listener.state().phase).toBe('restarting');
  });
});

describe('a stream that stops delivering after it had been working', () => {
  test('is treated as failed and restarted', async () => {
    const h = setup();
    await h.listener.start();
    h.frame();
    await settle();
    expect(h.live(3_000)).toHaveLength(1);
    // Audio keeps arriving: the watchdog only re-arms.
    h.frame();
    await h.fire(3_000);
    expect(h.listener.state().phase).toBe('listening');
    // Then nothing for a whole interval.
    await h.fire(3_000);
    expect(h.failures.at(-1)).toMatchObject({ reason: 'no-audio', restarting: true });
    expect(h.listener.state().phase).toBe('restarting');
    await h.fire(10);
    expect(h.opened).toHaveLength(2);
  });
});

describe('a timer-driven restart whose models fail to load', () => {
  test('reports that wake stopped instead of going quiet', async () => {
    let builds = 0;
    const settings = resolveWakeRuntimeSettings(reader({ 'voice.wake.enabled': true }), 'tui', { canRetainAudio: true, canPlayLocalFile: true });
    const h = setup({
      createEngine: async () => {
        builds += 1;
        if (builds > 1) throw new Error('model file vanished');
        return new WakeWordEngine({ embedding, models: [{ id: 'hey_goodvibes', session: silentClassifier }], tuning: settings.tuning, preRollMs: settings.preRollMs });
      },
    });
    await h.listener.start();
    h.opened[0]!.handlers.onStopped('failed', new AudioCaptureError('stream-ended', 'recorder exited'));
    await settle();
    await h.fire(10);
    expect(h.failures.at(-1)).toMatchObject({ restarting: false });
    expect(h.failures.at(-1)?.detail).toContain('model file vanished');
    expect(h.listener.state().phase).toBe('idle');
    expect(h.listener.state().lastError).toContain('model file vanished');
  });
});

describe('clearing a latch', () => {
  test('leaves the listener idle, not latched with no reason', async () => {
    const h = setup();
    await h.listener.start();
    // Exhaust the crash budget.
    for (let i = 0; i < 20 && h.listener.state().phase !== 'latched'; i += 1) {
      h.opened.at(-1)!.handlers.onStopped('failed', new AudioCaptureError('stream-ended', 'recorder exited'));
      await settle();
      if (h.listener.state().phase === 'restarting') await h.fireLatest();
    }
    expect(h.listener.state().phase).toBe('latched');
    h.listener.clearLatch();
    expect(h.listener.state().phase).toBe('idle');
    expect(h.listener.state().latchReason).toBeNull();
  });
});
