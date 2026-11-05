import { expect, test } from 'bun:test';
import type { GatePresetName } from '@goodvibes-jev/engine/sdk/platform/gate';
import { createRemoteConversationRouter, type ConnectedHostResolution } from '../../runtime/client/remote-conversation.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

function fixture(options: { initial?: GatePresetName; wrongSession?: boolean; failSet?: boolean; keepStream?: boolean } = {}) {
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
      return (method === 'sessions.hosted.create' ? { session: { id: 'hosted-one', permissionMode: actualMode } } : {}) as T;
    } },
    configManager: { get: ((key: string) => key === 'hostedSessions.routeConversationTurns' ? true : key === 'permissions.mode' ? options.initial : undefined) as never },
    resolveConnection: () => connection,
    conversation: { addAssistantMessage() {}, addToolResults() {}, addSystemMessage() {}, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} },
    requestRender() {}, workspaceRoot: '/workspace', clientId: 'agent-test', reconnect: { enabled: false },
    fetchImpl: mockFetch(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith('/permission-mode')) {
        const sessionId = url.pathname.split('/')[3]!;
        const previousMode = actualMode;
        if (init?.method === 'POST') {
          const packet = JSON.parse(String(init.body));
          const body = packet.body ?? packet;
          mutations.push({ sessionId, mode: body.mode });
          if (options.failSet) return Response.json({ error: 'unconfirmed' }, { status: 503 });
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

test('the first legacy-hosted turn applies its chosen mode before any steer', async () => {
  const f = fixture({ initial: 'yolo' });
  try {
    const result = await f.router.submit('hello');
    expect(result.routed).toBe(true);
    expect(f.mutations).toEqual([{ sessionId: 'hosted-one', mode: 'yolo' }]);
    expect(f.calls).toEqual(['sessions.hosted.create', 'sessions.steer']);
    expect(f.router.executionMode()).toBe('yolo');
  } finally { f.router.dispose(); }
});

test('first-turn mode setup failure never steers or falls back to local execution', async () => {
  const f = fixture({ initial: 'yolo', failSet: true });
  try {
    const result = await f.router.submit('hello');
    expect(result).toMatchObject({ routed: false, chosen: true, cancelled: true });
    expect(f.calls).toEqual(['sessions.hosted.create']);
    expect(f.router.executionMode()).toBeUndefined();
  } finally { f.router.dispose(); }
});

test('wrong-session mode acknowledgements fail and clear the unconfirmed cached choice', async () => {
  const f = fixture();
  try {
    await f.router.submit('hello');
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
    await f.router.submit('hello');
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
    await f.router.submit('hello');
    f.changeConnection();
    expect(f.router.executionMode()).toBeUndefined();
    await expect(f.router.setExecutionMode('yolo')).rejects.toThrow('owner');
    expect(f.mutations).toEqual([]);
  } finally { f.router.dispose(); }
});

test('routing on a replacement host creates its own session instead of steering an old-host identity', async () => {
  const f = fixture();
  try {
    await f.router.submit('first host');
    f.changeConnection();
    const result = await f.router.submit('replacement host');
    expect(result.routed).toBe(true);
    expect(f.calls).toEqual(['sessions.hosted.create', 'sessions.steer', 'sessions.hosted.create', 'sessions.steer']);
  } finally { f.router.dispose(); }
});

test('an old-host mutation response cannot overwrite a replacement host using the same session id', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  try {
    await f.router.submit('first host');
    f.holdWrite(release.promise, () => started.resolve());
    const oldWrite = f.router.setExecutionMode('yolo').then(() => null, error => error);
    await started.promise;
    f.changeConnection(); f.resetMode('safe-jev');
    await f.router.submit('replacement host');
    release.resolve();
    expect(await oldWrite).toBeInstanceOf(Error);
    expect(f.router.executionMode()).toBe('safe-jev');
  } finally { release.resolve(); f.router.dispose(); }
});


test('a replayed preset event refreshes the actual owner instead of overwriting its newer confirmed mode', async () => {
  const f = fixture({ keepStream: true });
  try {
    await f.router.submit('hello');
    await f.router.setExecutionMode('yolo');
    const reads = f.modeReads();
    f.staleModeEvent('safe-owner');
    const deadline = Date.now() + 3_000;
    while (f.modeReads() === reads || f.router.executionMode() === undefined) {
      if (Date.now() > deadline) throw new Error('The preset event did not refresh its session owner');
      await Bun.sleep(5);
    }
    expect(f.modeReads()).toBeGreaterThan(reads);
    expect(f.router.executionMode()).toBe('yolo');
    expect(f.mode()).toBe('yolo');
  } finally { f.router.dispose(); }
});
