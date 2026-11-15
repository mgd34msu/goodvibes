import { expect, test } from 'bun:test';
import type { GatePresetName } from '@goodvibes-jev/engine/platform/platform/gate';
import type { NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import { createRemoteConversationRouter, type ConnectedHostResolution } from '../../runtime/client/remote-conversation.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const snapshot: NativeHostedTurnSnapshot = { projectId: 'project', requestId: 'request', inputId: 'input', sourceRevision: 'revision', state: 'running', sessionId: 'hosted-one', brokerInputId: 'broker', correlationId: 'correlation' };

/** Observing a native turn binds the router to its hosted session and reads that session's mode. */
async function observe(f: ReturnType<typeof fixture>): Promise<void> {
  await f.router.observeNative(snapshot, async () => {});
  for (let turn = 0; f.router.executionMode() === undefined && turn < 2_000; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function fixture(options: { wrongSession?: boolean; keepStream?: boolean } = {}) {
  let connection: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'fixture-token', selectionIdentity: 'fixture-host' };
  let actualMode: GatePresetName = 'safe-owner';
  let wrong = options.wrongSession ?? false;
  const calls: string[] = [];
  const mutations: { sessionId: string; mode: unknown }[] = [];
  let eventStream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let modeReads = 0;
  let holdRead: Promise<void> | undefined;
  let readStarted: (() => void) | undefined;
  let holdWrite: Promise<void> | undefined;
  let writeStarted: (() => void) | undefined;
  const router = createRemoteConversationRouter({
    verbs: { probe: () => ({ available: true }), invoke: async <T,>(method: string): Promise<T> => {
      calls.push(method);
      return {} as T;
    } },
    resolveConnection: () => connection,
    conversation: { addAssistantMessage() {}, addToolResults() {}, addSystemMessage() {}, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} },
    requestRender() {}, clientId: 'agent-test', reconnect: { enabled: false },
    fetchImpl: mockFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/permission-mode')) {
        const sessionId = url.pathname.split('/')[3]!;
        const previousMode = actualMode;
        if (init?.method === 'POST') {
          const packet = JSON.parse(String(init.body));
          const body = packet.body ?? packet;
          mutations.push({ sessionId, mode: body.mode });
          actualMode = body.mode;
          const selectedMode = actualMode;
          writeStarted?.();
          await holdWrite;
          return Response.json({ sessionId: wrong ? 'another-session' : sessionId, mode: selectedMode, previousMode });
        }
        modeReads++;
        const observed = actualMode;
        readStarted?.();
        await holdRead;
        return Response.json({ sessionId: wrong ? 'another-session' : sessionId, mode: observed });
      }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { if (options.keepStream) { eventStream = controller; controller.enqueue(new TextEncoder().encode(': ready\n\n')); } else controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }),
  });
  return { router, calls, mutations, modeReads: () => modeReads, staleModeEvent: (mode: GatePresetName) => {
    if (!eventStream) throw new Error('Missing active session stream');
    eventStream.enqueue(new TextEncoder().encode(`event: gate\ndata: ${JSON.stringify({ type: 'PRESET_CHANGED', sessionId: 'hosted-one', payload: { type: 'PRESET_CHANGED', preset: mode } })}\n\n`));
  }, resetMode: (mode: GatePresetName) => { actualMode = mode; }, holdWrite: (hold: Promise<void>, started: () => void) => { holdWrite = hold; writeStarted = started; }, mode: () => actualMode, wrong: (value: boolean) => { wrong = value; }, changeConnection: () => { connection = { baseUrl: 'http://127.0.0.1:3422', token: 'other', selectionIdentity: 'replacement' }; }, holdRead: (hold: Promise<void>, started: () => void) => { holdRead = hold; readStarted = started; } };
}

test('wrong-session mode acknowledgements fail and clear the unconfirmed cached choice', async () => {
  const f = fixture();
  try {
    await observe(f);
    expect(f.router.executionMode()).toBe('safe-owner');
    f.wrong(true);
    await expect(f.router.setExecutionMode('safe-jev')).rejects.toThrow('unconfirmed');
    expect(f.router.executionMode()).toBeUndefined();
    await expect(f.router.refreshExecutionMode()).rejects.toThrow();
    expect(f.router.executionMode()).toBeUndefined();
    f.wrong(false);
    await f.router.refreshExecutionMode();
    expect(f.router.executionMode()).toBe('safe-jev');
  } finally { f.router.dispose(); }
});

test('a mode refresh started before a successful mutation cannot overwrite its confirmation', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    await observe(f);
    f.holdRead(release.promise, () => started.resolve());
    const oldRead = f.router.refreshExecutionMode();
    await started.promise;
    await f.router.setExecutionMode('yolo');
    release.resolve(); await oldRead;
    expect(f.router.executionMode()).toBe('yolo');
  } finally { release.resolve(); f.router.dispose(); }
});

test('host selection changes invalidate the displayed owner and reject further mutations', async () => {
  const f = fixture();
  try {
    await observe(f);
    f.changeConnection();
    expect(f.router.executionMode()).toBeUndefined();
    await expect(f.router.setExecutionMode('yolo')).rejects.toThrow('owner');
    expect(f.mutations).toEqual([]);
  } finally { f.router.dispose(); }
});

test('an old-host mutation response cannot overwrite a replacement host using the same session id', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    await observe(f);
    f.holdWrite(release.promise, () => started.resolve());
    const oldWrite = f.router.setExecutionMode('yolo').then(() => null, error => error);
    await started.promise;
    f.changeConnection(); f.resetMode('safe-jev');
    await observe(f);
    release.resolve();
    expect(await oldWrite).toBeInstanceOf(Error);
    expect(f.router.executionMode()).toBe('safe-jev');
  } finally { release.resolve(); f.router.dispose(); }
});


test('a replayed preset event refreshes the actual owner instead of overwriting its newer confirmed mode', async () => {
  const f = fixture({ keepStream: true });
  try {
    await observe(f);
    await f.router.setExecutionMode('yolo');
    const reads = f.modeReads();
    f.staleModeEvent('safe-owner');
    // Yield to the event loop until the refresh lands; bounded by turns, not time.
    for (let turn = 0; (f.modeReads() === reads || f.router.executionMode() === undefined) && turn < 2_000; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(f.modeReads()).toBeGreaterThan(reads);
    expect(f.modeReads()).toBeGreaterThan(reads);
    expect(f.router.executionMode()).toBe('yolo');
    expect(f.mode()).toBe('yolo');
  } finally { f.router.dispose(); }
});
