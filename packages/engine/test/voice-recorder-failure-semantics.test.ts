import { afterEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { createRecorderCaptureOpener } from '../platform/src/platform/voice/capture/recorder-source.js';
import { PushToTalkSession } from '../platform/src/platform/voice/capture/push-to-talk.js';
import type { AudioCaptureError, AudioCaptureHandlers, AudioCaptureRequest, CaptureChildProcess } from '../platform/src/platform/voice/capture/index.js';

const previous: Array<JudgmentPort | undefined> = [];
afterEach(() => { while (previous.length) installJudgmentPort(previous.pop()); });
function install(port: JudgmentPort | undefined) { previous.push(installJudgmentPort(port)); }
function answer(label: string, confidence = 0.99) {
  const fixture = fakePort((_name, question) => choiceAnswer(question, label, confidence));
  install(fixture.port); return fixture;
}
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

describe('recorder semantic reading at actual capture consumers', () => {
  for (const label of ['permission-denied', 'device-missing', 'device-unavailable', 'none'] as const) {
    test(`canonical ${label} reaches onStopped`, async () => {
      const fixture = answer(label);
      const child = processFixture();
      const recorded = stopRecorder();
      const stream = await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true, platform: 'linux' })(request, recorded.handlers);
      child.stderr('A complete diagnostic whose interpretation belongs to the supplied judgment.'); child.close(7);
      const stop = await recorded.firstStop;
      expect(fixture.requests).toHaveLength(1);
      expect(stop.error?.reason).toBe(label === 'none' ? 'stream-ended' : label);
      if (label === 'none') expect(stop.error?.message).toContain('code 7');
      child.close(7); child.error(new Error('late duplicate')); await stream.stop();
      expect(recorded.stops).toHaveLength(1);
    });
  }
  for (const diagnostic of [
    'Documentation says "permission denied", "no such device" and "audio open error". Actual stop was a closed output pipe.',
    'There was no permission denied condition and the device is present. This was a normal shutdown.',
  ]) test('quoted or negated keywords do not override canonical none', async () => {
    answer('none'); const child = processFixture(); const recorded = stopRecorder();
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, recorded.handlers);
    child.stderr(diagnostic); child.close(null, 'SIGPIPE'); const { error } = await recorded.firstStop;
    expect(error?.reason).toBe('stream-ended'); expect(error?.message).toContain('SIGPIPE');
  });
  test('complete diagnostic beyond the old 400-character display cap is admitted', async () => {
    const fixture = answer('device-missing'); const child = processFixture();
    const recorded = stopRecorder();
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, recorded.handlers);
    const text = 'normal progress '.repeat(50) + 'The requested microphone does not exist.';
    child.stderr(text); child.close(); await recorded.firstStop;
    expect(JSON.stringify(fixture.requests[0]?.state)).toContain(text);
  });
  for (const diagnostic of ['progress '.repeat(100) + ' Authorization: Bearer private-secret',
    'normal progress\n- Jo: password=synthetic-secret', 'x'.repeat(65537)]) {
    test('protected tail or overflow holds without any judgment transmission', async () => {
      const fixture = answer('device-missing'); const child = processFixture(); const recorded = stopRecorder();
      await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, recorded.handlers);
      child.stderr(diagnostic); child.close(); const { error } = await recorded.firstStop;
      expect(fixture.requests).toHaveLength(0); expect(error?.reason).toBe('failure-reading-unavailable');
      expect(error?.message).not.toContain('private-secret');
    });
  }
  for (const mode of ['missing', 'uncertain', 'replaced', 'late-installed'] as const) {
    test(`${mode} authority holds rather than inventing device absence`, async () => {
      if (mode === 'missing' || mode === 'late-installed') install(undefined); else answer('device-missing', mode === 'uncertain' ? 0.5 : 0.99);
      const child = processFixture(); const recorded = stopRecorder();
      await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request, recorded.handlers);
      if (mode === 'replaced' || mode === 'late-installed') answer('device-missing');
      child.stderr('No capture device exists.'); child.close(); const { error } = await recorded.firstStop;
      expect(error?.reason).toBe('failure-reading-unavailable');
    });
  }
  test('stop interrupts a noncooperative close reading and drains late settlement exactly once', async () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'device-missing', 0.99));
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let calls = 0; let asked!: () => void; const askedOnce = new Promise<void>(resolve => { asked = resolve; });
    install({ ...fixture.port, async ask(input) { ++calls; asked(); await blocked; return fixture.port.ask(input); } });
    const child = processFixture(); const stops: string[] = []; let frames = 0;
    const stream = await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true })(request,
      { onFrame() { ++frames; }, onStopped: reason => { stops.push(reason); } });
    child.stderr('The microphone is absent.'); child.close(); await askedOnce; expect(calls).toBe(1);
    child.close(); child.error(new Error('duplicate')); child.data();
    await stream.stop(); expect(stops).toEqual(['requested']); expect(child.signals).toHaveLength(0);
    release(); await flush(); expect(stops).toEqual(['requested']); expect(frames).toBe(0);
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

describe('a recorder failure reading that never answers', () => {
  test('is bounded, so the consumer is still told the recorder exited', async () => {
    const fixture = fakePort((_name, question) => choiceAnswer(question, 'device-missing', 0.99));
    install({ ...fixture.port, ask: () => new Promise(() => {}) });
    const child = processFixture(); const recorded = stopRecorder();
    await createRecorderCaptureOpener({ spawn: () => child.child, isInstalled: () => true, platform: 'linux', failureReadingTimeoutMs: 1 })(request, recorded.handlers);
    child.stderr('The recorder said something that needs reading.'); child.close(3);
    const stop = await recorded.firstStop;
    await flush();
    expect(recorded.stops).toHaveLength(1);
    expect(stop.error?.reason).toBe('failure-reading-unavailable');
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
