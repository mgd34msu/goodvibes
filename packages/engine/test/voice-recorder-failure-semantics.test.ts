import { describe, expect, test } from 'bun:test';
import { createRecorderCaptureOpener } from '../platform/src/platform/voice/capture/recorder-source.js';
import { PushToTalkSession } from '../platform/src/platform/voice/capture/push-to-talk.js';
import type { AudioCaptureError, AudioCaptureHandlers, AudioCaptureRequest, CaptureChildProcess } from '../platform/src/platform/voice/capture/index.js';

// Lets already-queued work finish; used only to show that nothing more happens.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type Stop = { reason: string; error?: AudioCaptureError | undefined };
/** Handlers that record every stop and a promise for the first one, so a test waits for the event itself. */
function stopRecorder() {
  const stops: Stop[] = []; let first!: (stop: Stop) => void;
  const firstStop = new Promise<Stop>(resolve => { first = resolve; });
  return { stops, firstStop, handlers: { onFrame() {}, onStopped: (reason: string, error?: AudioCaptureError) => { stops.push({ reason, error }); first({ reason, error }); } } };
}
function processFixture() {
  let onClose = (_code: number | null, _signal: string | null) => {};
  let onError = (_error: Error) => {};
  let onStderr = (_chunk: Uint8Array) => {};
  let onData = (_chunk: Uint8Array) => {};
  const signals: string[] = [];
  const child: CaptureChildProcess = {
    stdout: { on: (_event, listener) => { onData = listener; } },
    stderr: { on: (_event, listener) => { onStderr = listener; } },
    on(event: 'close' | 'error', listener: (...args: never[]) => void) {
      if (event === 'close') onClose = listener as typeof onClose;
      else onError = listener as typeof onError;
    },
    kill(signal) { signals.push(signal ?? 'SIGTERM'); onClose(0, signal ?? 'SIGTERM'); },
  };
  return { child, signals, stderr: (text: string) => onStderr(new TextEncoder().encode(text)),
    close: (code: number | null = 1, signal: string | null = null) => onClose(code, signal),
    error: (error: Error) => onError(error), data: () => onData(new Uint8Array(8)) };
}
const request: AudioCaptureRequest = { backend: 'parecord', device: 'microphone', noiseSuppression: 'none', frameSamples: 4 };

describe('a recorder that exits on its own', () => {
  test('is reported at close with its exit facts when the diagnostic names no device problem', () => {
    const child = processFixture(); const recorded = stopRecorder();
    void createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true, platform: 'linux' })(request, recorded.handlers);
    return Promise.resolve().then(() => {
      child.stderr('A complete diagnostic that names no device problem.'); child.close(7);
      // Reported synchronously from the close event: nothing is awaited first.
      expect(recorded.stops).toHaveLength(1);
      expect(recorded.stops[0]?.error?.reason).toBe('stream-ended');
      expect(recorded.stops[0]?.error?.message).toContain('code 7');
      child.close(7); child.error(new Error('late duplicate'));
      expect(recorded.stops).toHaveLength(1);
    });
  });
  test('keeps the end of a long diagnostic, where the reason is', async () => {
    const child = processFixture(); const recorded = stopRecorder();
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, recorded.handlers);
    child.stderr('progress '.repeat(10_000)); child.stderr('pw-record: no target node available'); child.close(1);
    expect((await recorded.firstStop).error?.reason).toBe('device-missing');
  });
  test('PTT cancel and replacement ignore callbacks from an old capture incarnation', async () => {
    const callbacks: AudioCaptureHandlers[] = [];
    const session = new PushToTalkSession({ captureMaxSeconds: 30, capture: { ...request }, openCapture: async (_request, handlers) => {
      callbacks.push(handlers); return { label: 'fixture', deviceSelectable: true, stop: async () => {} };
    } });
    await session.start(); await session.cancel(); await session.start();
    callbacks[0]!.onStopped('failed'); expect(session.phase).toBe('recording');
    await session.cancel();
  });
});

describe('push-to-talk auto-stop', () => {
  test('a key press while an auto-stopped capture is releasing the device does not lose that utterance', async () => {
    let release!: () => void;
    const releasing = new Promise<void>(resolve => { release = resolve; });
    let handlers: AudioCaptureHandlers | undefined;
    let opens = 0;
    const delivered: unknown[] = [];
    const session = new PushToTalkSession({
      captureMaxSeconds: 1,
      capture: { ...request, frameSamples: 16_000 },
      openCapture: async (_request, h) => { opens += 1; handlers = h; return { label: 'fixture', deviceSelectable: true, stop: () => releasing }; },
      onAutoStop: (utterance) => { delivered.push(utterance); },
    });
    await session.start();
    // One second of audio reaches the ceiling and auto-stops.
    handlers!.onFrame(new Float32Array(16_000));
    expect(session.phase).toBe('stopping');
    await session.start();
    release(); await flush(); await flush();
    expect(delivered).toHaveLength(1);
    expect(opens).toBe(1);
  });
});
