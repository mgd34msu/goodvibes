import { expect, test } from 'bun:test';
import { setExecutionMode } from '../../permissions/execution-mode.ts';
import type { BootstrapContext } from '../../runtime/bootstrap.ts';
import type { NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import type { NativeConversationIntakeActions, NativeConversationIntakeRequestIdentity, NativeConversationIntakeState } from '../../runtime/native-conversation-intake.ts';
import { cancelConversationGeneration, installRemoteConversationRouting } from '../../shell/remote-conversation-wiring.ts';
import { buildThrobberState, ThinkingStallClock, type ThinkingOverlayDeps } from '../../core/thinking-overlay.ts';

const snapshot: NativeHostedTurnSnapshot = { projectId: 'owned-project', requestId: 'request-a', inputId: 'input-a', sourceRevision: 'source-revision', state: 'running', sessionId: 'native-session', brokerInputId: 'native-broker-input', correlationId: 'native-correlation' };
const source = { text: 'first question', unsupportedSources: [] };
const turnState = (): NativeConversationIntakeState => ({ status: 'recorded', message: 'Native turn admitted.', request: { requestId: snapshot.requestId, inputId: snapshot.inputId },
  result: { kind: 'turn', projectId: snapshot.projectId, requestId: snapshot.requestId, sourceRef: { version: 1, inputId: snapshot.inputId, sourceId: 'source', sourceRevision: snapshot.sourceRevision, sessionId: 'native-project' }, route: 'answer', text: source.text },
  hostedTurn: snapshot, hostedCurrent: () => true });

function fixture() {
  const notices: string[] = [], localModeWrites: unknown[] = [], drafts: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let event = 0, selectionIdentity = 'selected-record';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith('/permission-mode')) return Response.json({ sessionId: snapshot.sessionId, mode: 'safe-owner' });
      if (request.method !== 'GET') return new Response('unexpected mutation', { status: 500 });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(': ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const connection = () => ({ baseUrl: server.url.origin, token: 'synthetic-token', selectionIdentity, expectedPrincipalId: 'pairing:synthetic' });
  const verbs = { probe: () => ({ available: true as const }), async invoke<T>(): Promise<T> { return { sessions: [], session: { id: snapshot.sessionId }, history: [] } as T; } };
  const conversation = { addUserMessage() {}, addAssistantMessage() {}, addToolResults() {}, addSystemMessage(text: string) { notices.push(text); }, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} };
  const configManager = { get: ((key: string) => key === 'permissions.mode' ? 'safe-owner' : true) as never, set: ((key: string, value: unknown) => { localModeWrites.push({ key, value }); }) as never };
  const orchestrator = { isThinking: false, thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 };
  const ctx = { conversation, orchestrator, runtime: { sessionId: 'local', model: 'fixture', provider: 'fixture' }, runtimeBus: { emit() {} }, services: { daemonVerbs: verbs, configManager, workingDirectory: '/synthetic-owned', resolveConnectedHost: connection, sessionManager: { list: () => [] } } } as unknown as BootstrapContext;
  const wiring = installRemoteConversationRouting(ctx, { render() {}, notify: text => notices.push(text), restoreDraft: text => drafts.push(text) });
  const frame = (type: string, turnId = 'owned-turn') => {
    if (!stream) throw new Error('Missing stream');
    const payload = { type, turnId, ...(type === 'TURN_SUBMITTED' ? { origin: { metadata: { correlationId: snapshot.correlationId } } } : {}), ...(type === 'TURN_COMPLETED' ? { stopReason: 'completed' } : {}) };
    stream.enqueue(new TextEncoder().encode(`id: event-${++event}\nevent: turn\ndata: ${JSON.stringify({ type, sessionId: snapshot.sessionId, payload })}\n\n`));
  };
  return { wiring, orchestrator, notices, localModeWrites, drafts, configManager, frame, replaceSelection() { selectionIdentity = 'replacement-record'; }, async close() { wiring.dispose(); await server.stop(true); } };
}
async function until(predicate: () => boolean) { const end = Date.now() + 3_000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timed out'); await Bun.sleep(5); } }

function recordingIntake() {
  const calls: string[] = []; const cancelled: NativeConversationIntakeRequestIdentity[] = [];
  let hold: ((value: NativeConversationIntakeState | undefined) => void) | undefined;
  let submits = 0;
  let signalSecond = () => {};
  const secondAdmitting = new Promise<void>(done => { signalSecond = done; });
  const intake: NativeConversationIntakeActions = {
    submit: async () => { submits++; if (submits === 1) return turnState(); return new Promise(resolve => { hold = resolve; signalSecond(); }); },
    status: async () => turnState(), retry: async () => turnState(), resume: async () => turnState(),
    cancel: async expected => { if (expected) cancelled.push(expected); return { ...turnState(), hostedTurn: { ...snapshot, state: 'cancelling' } }; },
    stop: async () => { calls.push('stop'); hold?.(undefined); return undefined; },
    close: () => { calls.push('close'); },
  };
  return { intake, calls, cancelled, secondAdmitting, release: (value: NativeConversationIntakeState | undefined) => hold?.(value) };
}

test('the hosted indicator clears when the selection changes under an observed turn', async () => {
  const f = fixture(); const { intake } = recordingIntake();
  try {
    const handle = await f.wiring.routeNativeOrExplain(source, intake);
    expect(f.orchestrator.isThinking).toBe(true);
    f.replaceSelection();
    expect((await handle!.completion).status).toBe('abandoned');
    await until(() => !f.orchestrator.isThinking);
  } finally { await f.close(); }
});

test('Stop with nothing left to cancel clears a stranded hosted indicator', async () => {
  const f = fixture(); const { intake } = recordingIntake();
  try {
    const handle = await f.wiring.routeNativeOrExplain(source, intake);
    expect(f.orchestrator.isThinking).toBe(true);
    // The router no longer owns a cancellable turn once the selection changed.
    f.replaceSelection();
    let aborts = 0;
    cancelConversationGeneration({ get isThinking() { return f.orchestrator.isThinking; }, abort: () => { aborts++; } }, f.wiring);
    expect(f.orchestrator.isThinking).toBe(false);
    expect(aborts).toBe(0);
    await handle!.completion;
  } finally { await f.close(); }
});

test('Stop while a second input is admitting cancels the running turn instead of detaching it', async () => {
  const f = fixture(); const r = recordingIntake();
  try {
    await f.wiring.routeNativeOrExplain(source, r.intake);
    f.frame('TURN_SUBMITTED');
    const second = f.wiring.routeNativeOrExplain({ text: 'second question', unsupportedSources: [] }, r.intake);
    await r.secondAdmitting;
    expect(f.wiring.cancelHostedTurn()).toBe(true);
    await until(() => r.cancelled.length === 1);
    expect(r.cancelled).toEqual([{ requestId: snapshot.requestId, inputId: snapshot.inputId }]);
    expect(r.calls).toEqual(['stop']);
    await second;
    expect(f.notices.join('\n')).not.toContain('host, credentials or workspace changed');
    expect(f.orchestrator.isThinking).toBe(true);
    f.frame('TURN_COMPLETED');
    await until(() => !f.orchestrator.isThinking);
  } finally { await f.close(); }
});

test('an input refused because another is admitting goes back to the composer', async () => {
  const f = fixture(); const r = recordingIntake();
  try {
    await f.wiring.routeNativeOrExplain(source, r.intake);
    const second = f.wiring.routeNativeOrExplain({ text: 'second question', unsupportedSources: [] }, r.intake);
    await r.secondAdmitting;
    await f.wiring.routeNativeOrExplain({ text: 'third question', unsupportedSources: [] }, r.intake);
    expect(f.drafts).toEqual(['third question']);
    r.release(undefined); await second;
  } finally { await f.close(); }
});

test('a mode change during an unconfirmed native input names the next step, and a settled status releases it', async () => {
  const f = fixture();
  const unknown: NativeConversationIntakeState = { status: 'unknown', message: 'Native intake outcome is unknown.', request: { requestId: 'r', inputId: 'i' } };
  const cancelledState: NativeConversationIntakeState = { status: 'recorded', message: 'Native intake cancelled.', request: { requestId: 'r', inputId: 'i' },
    result: { kind: 'cancelled', projectId: 'p', requestId: 'r', sourceRef: { version: 1, inputId: 'i', sourceId: 's', sourceRevision: 'r1', sessionId: 'x' } } };
  const intake: NativeConversationIntakeActions = { submit: async () => unknown, status: async () => cancelledState, retry: async () => unknown, resume: async () => unknown, cancel: async () => unknown, close() {} };
  try {
    await f.wiring.routeNativeOrExplain(source, intake);
    await expect(setExecutionMode(f.configManager, 'yolo')).rejects.toThrow('/work intake-status');
    expect(f.localModeWrites).toEqual([]);
    await f.wiring.observeIntake(intake).status();
    await setExecutionMode(f.configManager, 'yolo');
    expect(f.localModeWrites).toEqual([{ key: 'permissions.mode', value: 'yolo' }]);
  } finally { await f.close(); }
});

test('a local turn admitted but not yet thinking is busy for Stop and the throbber', () => {
  let aborts = 0;
  cancelConversationGeneration({ isThinking: false, isTurnInFlight: true, abort: () => { aborts++; } }, { cancelHostedTurn: () => false });
  expect(aborts).toBe(1);
  const orchestrator: ThinkingOverlayDeps['orchestrator'] = { isTurnActive: true, getSpinner: () => '-', thinkingFrame: 0, streamingInputTokens: 0, streamingOutputTokens: 0 };
  const throbber = (turnActive: boolean) => buildThrobberState({ orchestrator: { ...orchestrator, isTurnActive: turnActive }, configManager: { get: () => false } as ThinkingOverlayDeps['configManager'], streamToolPreview: undefined, streamTokenSpeed: 0,
    approvalPending: false, width: 80, clock: new ThinkingStallClock(), pendingApproval: null, activeTool: null, compacting: false });
  expect(throbber(true)).toMatchObject({ spinner: '-', frame: 0 });
  expect(throbber(false)).toBeNull();
});
