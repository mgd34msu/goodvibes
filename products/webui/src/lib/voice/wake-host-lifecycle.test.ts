/**
 * wake-host.ts lifecycle edges: a configuration change that arrives while a press
 * holds the device, and a startup step that throws. Drives the real listener and
 * the real arbiter over a getUserMedia spy, like wake-host.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { CAPTURE_SAMPLE_RATE } from '@goodvibes-jev/engine/platform/platform/voice/capture';
import type {
  WakeInferenceSession,
  WakeRuntimeSettings,
} from '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';
import { createBrowserCaptureOpener, type CaptureEnv } from './capture';
import { MicArbiter } from './mic-arbiter';
import { resolveWebuiWakeSettings } from './wake-config';
import {
  createBrowserModelSetLoader,
  createWakeHost,
  PINNED_WAKE_MODEL_ID,
  type WakeModelSet,
} from './wake-host';
import { webCryptoDigest } from './wake-models';
import type { WakeRuntime } from './wake-runtime';

const FRAME_SAMPLES = 1280;

// ─── A getUserMedia spy behind the real opener ────────────────────────────────

interface CaptureSpy {
  env: CaptureEnv;
  getUserMediaCalls: number;
  tracksStopped: () => boolean;
  /** Deliver one buffer of Web Audio samples into the live graph. */
  pump: (samples: Float32Array) => void;
  contextsClosed: () => number;
  /** Fire the browser's track-ended event on every opened track. */
  endStreams: () => void;
}

function captureSpy(): CaptureSpy {
  const tracks: { stopped: boolean; stop(): void; label: string; onended?: (() => void) | null }[] = [];
  const processors: { onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null }[] = [];
  let closed = 0;
  const spy: CaptureSpy = {
    getUserMediaCalls: 0,
    tracksStopped: () => tracks.length > 0 && tracks.every((track) => track.stopped),
    contextsClosed: () => closed,
    endStreams: () => {
      for (const track of tracks) track.onended?.();
    },
    pump: (samples) => {
      for (const processor of processors) {
        processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
      }
    },
    env: {
      isSecureContext: true,
      mediaDevices: {
        getUserMedia: () => {
          spy.getUserMediaCalls += 1;
          const track = { stopped: false, label: 'Spy microphone', stop(): void { track.stopped = true; } };
          tracks.push(track);
          return Promise.resolve({ getTracks: () => [track] });
        },
      },
      createAudioContext: () => ({
        sampleRate: CAPTURE_SAMPLE_RATE,
        destination: {},
        audioWorklet: undefined,
        createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
        createScriptProcessor: () => {
          const processor = {
            onaudioprocess: null as ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null,
            connect: () => undefined,
            disconnect: () => undefined,
          };
          processors.push(processor);
          return processor;
        },
        createGain: () => ({ gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }),
        resume: () => Promise.resolve(),
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      }),
      createWorkletNode: undefined,
      createModuleUrl: undefined,
    },
  };
  return spy;
}

/** An embedding backbone that emits a fixed 96-dim vector, so scores are the test's. */
function stubEmbedding(): WakeInferenceSession {
  const output = new Float32Array(96).fill(0.25);
  return {
    inputNames: ['input_1'],
    outputNames: ['embedding'],
    run: () => Promise.resolve({ embedding: { data: output, dims: [1, 1, 1, 96] } }),
  };
}

function modelSet(released: { count: number }): WakeModelSet {
  const classifier: WakeInferenceSession = {
    inputNames: ['input'],
    outputNames: ['score'],
    run: () => Promise.resolve({ score: { data: new Float32Array([0]), dims: [1, 1] } }),
  };
  return {
    embedding: stubEmbedding(),
    models: [{ id: PINNED_WAKE_MODEL_ID, session: classifier }],
    backend: 'wasm',
    fallbackReason: null,
    limitations: [],
    release: () => {
      released.count += 1;
      return Promise.resolve();
    },
  };
}

function settingsFor(overrides: Record<string, unknown> = {}, vadReady = false): WakeRuntimeSettings {
  return resolveWebuiWakeSettings({
    voice: {
      wake: {
        enabled: true,
        models: PINNED_WAKE_MODEL_ID,
        threshold: 0.9,
        patienceFrames: 2,
        cooldownMs: 2_000,
        preRollMs: 500,
        captureMaxSeconds: 10,
        silenceStopMs: 300,
        autoSubmit: false,
        indicator: 'statusline',
        surfaces: { webui: true },
        ...overrides,
      },
    },
  }, vadReady);
}

function harness() {
  const spy = captureSpy();
  const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
  const released = { count: 0 };
  const state = { loads: 0 };
  const host = createWakeHost({
    openCapture: arbiter.openCapture,
    loadModelSet: () => {
      state.loads += 1;
      return Promise.resolve(modelSet(released));
    },
    transcribe: () => Promise.resolve(''),
    chime: () => true,
    arbiter,
    warn: () => undefined,
  });
  return { spy, arbiter, host, state, released };
}

async function settle(times = 20): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

const PRESS_REQUEST = { frameSamples: FRAME_SAMPLES, device: '', backend: 'auto', noiseSuppression: 'none' } as const;
const PRESS_HANDLERS = { onFrame: () => undefined, onStopped: () => undefined };

describe('a configuration change while a press holds the microphone', () => {
  test('is applied when the press ends, and the rebuilt listener can still be stood down', async () => {
    const { spy, arbiter, host, state } = harness();
    await host.applySettings(settingsFor({ threshold: 0.9 }));
    expect(state.loads).toBe(1);

    const lease = await arbiter.acquireExclusive();
    expect(host.getState().phase).toBe('suspended');
    await host.applySettings(settingsFor({ threshold: 0.8 }));
    // Nothing was rebuilt or reopened under the press.
    expect(state.loads).toBe(1);
    expect(host.getState().phase).toBe('suspended');

    const press = await arbiter.openCapture(PRESS_REQUEST, PRESS_HANDLERS);
    await press.stop();
    await lease();
    await settle();

    expect(state.loads).toBe(2);
    expect(host.getState().phase).toBe('listening');
    expect(arbiter.openStreams).toBe(1);

    // Still registered: a second press stands it down instead of failing to open.
    const second = await arbiter.acquireExclusive();
    expect(host.getState().phase).toBe('suspended');
    const press2 = await arbiter.openCapture(PRESS_REQUEST, PRESS_HANDLERS);
    await press2.stop();
    await second();
    await settle();
    expect(host.getState().phase).toBe('listening');
    expect(spy.getUserMediaCalls).toBe(5);
  });
});

describe('a startup step that throws', () => {
  test('leaves a refusal in state, not a stale loading phase', async () => {
    const spy = captureSpy();
    const arbiter = new MicArbiter(createBrowserCaptureOpener(spy.env));
    const released = { count: 0 };
    const host = createWakeHost({
      openCapture: arbiter.openCapture,
      loadModelSet: () => {
        const base = modelSet(released);
        let reads = 0;
        // The engine reads the handles once while starting; the host reads them again
        // for its own state, after the device is open.
        return Promise.resolve({
          ...base,
          get models(): WakeModelSet['models'] {
            reads += 1;
            if (reads > 1) throw new Error('classifier handle is broken');
            return base.models;
          },
        });
      },
      transcribe: () => Promise.resolve(''),
      chime: () => true,
      arbiter,
      warn: () => undefined,
    });
    await host.applySettings(settingsFor());
    const state = host.getState();
    expect(state.phase).toBe('refused');
    expect(state.refusal?.kind).toBe('host-error');
    expect(state.error).toContain('classifier handle is broken');
  });
});

describe('createBrowserModelSetLoader', () => {
  test('releases the sessions it already created when a later one fails to compile', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const sha256 = await webCryptoDigest(bytes);
    const releases: string[] = [];
    let created = 0;
    const runtime: WakeRuntime = {
      backend: 'wasm',
      fallbackReason: null,
      createSession: () => {
        created += 1;
        const name = `session-${created}`;
        if (created === 2) return Promise.reject(new Error('kernel failed to compile'));
        return Promise.resolve({
          inputNames: [],
          outputNames: [],
          run: () => Promise.resolve({}),
          release: () => {
            releases.push(name);
            return Promise.resolve();
          },
        });
      },
    };
    const load = createBrowserModelSetLoader({
      readChunk: ({ component, offset }) => Promise.resolve({
        component,
        offset,
        bytes: bytes.length,
        totalBytes: bytes.length,
        sha256,
        dataBase64: Buffer.from(bytes).toString('base64'),
        complete: true,
      }),
      modelVersion: () => Promise.resolve('v1'),
      warn: () => undefined,
      loadRuntime: () => Promise.resolve(runtime),
    });
    await expect(load(settingsFor())).rejects.toThrow('kernel failed to compile');
    expect(releases).toEqual(['session-1']);
  });
});
