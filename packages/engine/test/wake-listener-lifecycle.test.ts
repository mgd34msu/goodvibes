/**
 * Wake listener lifecycle edges: hung scoring, a stop during a device wait, and
 * a refused start leaving no timer behind. Timers are captured, never run by
 * the clock; audio frames are pushed by hand.
 */
import { describe, expect, test } from 'bun:test';
import { WakeListener } from '../platform/src/platform/voice/wake/listener.ts';
import { resolveWakeRuntimeSettings } from '../platform/src/platform/voice/wake/settings.ts';
import { AudioCaptureError, type AudioCaptureHandlers, type AudioCaptureRequest } from '../platform/src/platform/voice/capture/types.ts';
import type { AudioInputDevice } from '../platform/src/platform/voice/capture/device-binding.ts';

const settings = (() => {
  const values: Record<string, unknown> = { 'voice.wake.enabled': true, 'voice.wake.surfaces.tui': true, 'voice.wake.inputDevice': '' };
  return resolveWakeRuntimeSettings((key) => values[key], 'tui', { speexAvailable: true, canRetainAudio: true, canPlayLocalFile: true });
})();

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function harness(options: { devices?: () => readonly AudioInputDevice[]; engines?: Array<(frame: Float32Array) => Promise<{ detections: never[] }>> } = {}) {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let nextTimer = 1;
  const handlersSeen: AudioCaptureHandlers[] = [];
  let openError: AudioCaptureError | null = null;
  const failures: Array<{ restarting: boolean; detail: string }> = [];
  let engineCount = 0;
  const pushes: number[] = [];
  const listener = new WakeListener({
    settings,
    openCapture: async (_request: AudioCaptureRequest, handlers: AudioCaptureHandlers) => {
      if (openError) throw openError;
      handlersSeen.push(handlers);
      return { label: 'pw-record', deviceSelectable: true, stop: async () => {} };
    },
    createNoiseSuppression: undefined,
    createEngine: async () => {
      const index = engineCount++;
      const score = options.engines?.[index] ?? (async () => ({ detections: [] as never[] }));
      return {
        chunkSamples: 1280,
        modelIds: ['hey-goodvibes'],
        pushFrame: async (frame: Float32Array) => { pushes.push(index); return score(frame); },
        reset: () => {},
        close: async () => {},
      } as never;
    },
    ...(options.devices ? { enumerateInputDevices: async () => options.devices!() } : {}),
    startTimeoutMs: 9_001,
    firstFrameTimeoutMs: 9_002,
    frameGapTimeoutMs: 9_003,
    handlers: { onFailure: (_error, restarting, detail) => { failures.push({ restarting, detail }); } },
    setTimeout: (run: () => void, ms: number) => { const id = nextTimer++; pending.set(id, { run, ms }); return id; },
    clearTimeout: (handle: unknown) => { pending.delete(handle as number); },
  });
  const frame = (): void => handlersSeen[handlersSeen.length - 1]!.onFrame(new Float32Array(1280));
  const fire = (ms: number): void => {
    const entry = [...pending.entries()].find(([, timer]) => timer.ms === ms);
    expect(entry).toBeDefined();
    pending.delete(entry![0]);
    entry![1].run();
  };
  return {
    listener, pending, failures, frame, fire, pushes, handlersSeen,
    failOpenWith: (error: AudioCaptureError | null) => { openError = error; },
  };
}

describe('hung scoring', () => {
  test('a frame whose scoring never returns restarts capture, and the new engine is not queued behind it', async () => {
    const h = harness({ engines: [() => new Promise<never>(() => {})] });
    expect((await h.listener.start()).started).toBe(true);
    h.frame();
    await flush();
    expect(h.pushes).toEqual([0]);
    // Later frames queue behind the hung call; the deadline is the only way out.
    h.frame();
    h.fire(5_000);
    await flush();
    expect(h.failures.some((f) => f.restarting)).toBe(true);
    expect(h.listener.state().phase).toBe('restarting');

    // The supervisor's restart timer opens a fresh generation with a fresh engine.
    const restart = [...h.pending.values()].find((t) => ![9_001, 9_002, 9_003].includes(t.ms));
    expect(restart).toBeDefined();
    restart!.run();
    await flush();
    h.frame();
    await flush();
    expect(h.pushes).toContain(1);
    await h.listener.stop();
  });
});

describe('device wait and stop', () => {
  test('stop clears the device wait, so a later start that finds no device reports it instead of waiting from an orphan', async () => {
    const h = harness();
    await h.listener.start();
    h.handlersSeen[0]!.onStopped('failed', new AudioCaptureError('device-missing', 'no target node available'));
    expect(h.listener.state().phase).toBe('restarting');
    await h.listener.stop();
    h.failures.length = 0;

    h.failOpenWith(new AudioCaptureError('device-missing', 'no target node available'));
    const outcome = await h.listener.start();
    expect(outcome.started).toBe(false);
    expect(h.pending.size).toBe(0);
    expect(h.failures.some((f) => f.detail.includes('could not start'))).toBe(true);
  });
});

describe('a refused start', () => {
  test('leaves no start timer pending', async () => {
    const h = harness({ devices: () => [{ id: 'out.monitor', label: 'out.monitor', isMonitor: true }] });
    const outcome = await h.listener.start();
    expect(outcome.started).toBe(false);
    if (!outcome.started) expect(outcome.refusal).toBe('no-microphone');
    expect(h.pending.size).toBe(0);
  });
});
