/**
 * Stop for a hosted turn delivered by native intake: Stop asks the intake to
 * cancel the original input, once, and the turn ends only on the host's own
 * terminal frame. Real loopback SSE; the cancellation is the injected intake call.
 */
import { expect, test } from 'bun:test';
import type { NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import { createRemoteConversationRouter, type RemoteTurnOutcome } from '../../runtime/client/remote-conversation.ts';
import { cancelConversationGeneration } from '../../shell/remote-conversation-wiring.ts';

const snapshot: NativeHostedTurnSnapshot = { projectId: 'stop-project', requestId: 'stop-request', inputId: 'stop-input', sourceRevision: 'stop-revision', state: 'running', sessionId: 'stop-session', brokerInputId: 'stop-broker-input', correlationId: 'stop-correlation' };

function fixture() {
  const posts: string[] = [], notices: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let event = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch(request) {
      if (new URL(request.url).pathname.endsWith('/permission-mode')) return Response.json({ sessionId: snapshot.sessionId, mode: 'safe-owner' });
      if (request.method !== 'GET') { posts.push(new URL(request.url).pathname); return new Response('unexpected mutation', { status: 500 }); }
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(': ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const connection = () => ({ baseUrl: server.url.origin, token: 'synthetic-stop-token', selectionIdentity: 'stop-selection' });
  const verbs = { probe: () => ({ available: true as const }), async invoke<T>(method: string): Promise<T> { posts.push(method); return {} as T; } };
  const conversation = { addAssistantMessage() {}, addToolResults() {}, addSystemMessage() {}, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} };
  const router = createRemoteConversationRouter({ verbs, resolveConnection: connection, conversation, requestRender() {}, clientId: 'agent-stop-test', reconnect: { enabled: false }, onCancellationNotice: text => notices.push(text) });
  function frame(type: string, turnId = 'stop-turn') {
    if (!stream) throw new Error('Missing stream');
    const payload = { type, turnId, ...(type === 'TURN_SUBMITTED' ? { origin: { metadata: { correlationId: snapshot.correlationId } } } : {}), ...(type === 'TURN_COMPLETED' ? { stopReason: 'completed' } : {}) };
    stream.enqueue(new TextEncoder().encode(`id: event-${++event}\nevent: turn\ndata: ${JSON.stringify({ type, sessionId: snapshot.sessionId, payload })}\n\n`));
  }
  return { router, posts, notices, frame, async close() { router.dispose(); await server.stop(true); } };
}

async function until(predicate: () => boolean) { const end = Date.now() + 3_000; while (!predicate()) { if (Date.now() > end) throw new Error('Fixture timed out'); await Bun.sleep(5); } }

function routed(outcome: RemoteTurnOutcome): Extract<RemoteTurnOutcome, { routed: true }> {
  if (!outcome.routed) throw new Error(outcome.reason);
  return outcome;
}

test('repeated Stop sends one cancellation for the original input and waits for the host terminal', async () => {
  const f = fixture(); let cancels = 0;
  try {
    const turn = routed(await f.router.observeNative(snapshot, async () => { cancels++; }));
    f.frame('TURN_SUBMITTED');
    expect(f.router.cancelTurn()).toBe(true); expect(f.router.cancelTurn()).toBe(true);
    await until(() => cancels === 1);
    expect(f.router.cancelTurn()).toBe(true);
    // STREAM_END is not a terminal: the turn ends on the host's own cancel frame after it.
    f.frame('STREAM_END');
    f.frame('TURN_CANCEL');
    expect((await turn.completion).status).toBe('cancelled');
    expect(cancels).toBe(1); expect(f.router.cancelTurn()).toBe(false);
    expect(f.posts.filter(method => method !== 'sessions.hosted.attach')).toEqual([]);
  } finally { await f.close(); }
});

test('natural completion wins a race with a cancellation still awaiting the intake', async () => {
  const f = fixture(); const held = Promise.withResolvers<void>(); let cancels = 0;
  try {
    const turn = routed(await f.router.observeNative(snapshot, async () => { cancels++; await held.promise; }));
    f.frame('TURN_SUBMITTED');
    f.router.cancelTurn(); await until(() => cancels === 1);
    f.frame('TURN_COMPLETED');
    expect((await turn.completion).status).toBe('completed');
    held.resolve(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.notices.some(line => line.includes('Native cancellation recorded'))).toBe(false);
  } finally { held.resolve(); await f.close(); }
});

test('dispose settles the observer as abandoned without sending Stop or touching the session', async () => {
  const f = fixture(); let cancels = 0;
  try {
    const turn = routed(await f.router.observeNative(snapshot, async () => { cancels++; }));
    f.router.dispose();
    expect((await turn.completion).status).toBe('abandoned');
    expect(f.router.cancelTurn()).toBe(false);
    expect(cancels).toBe(0);
    expect(f.posts.filter(method => method !== 'sessions.hosted.attach')).toEqual([]);
  } finally { await f.close(); }
});

test('the interactive cancellation handler gives hosted ownership priority and still aborts local generation', () => {
  let localAborts = 0, hostedStops = 0, hostedOwnsTurn = true;
  const local = { isThinking: true, abort: () => { localAborts += 1; } };
  const remote = { cancelHostedTurn: () => { hostedStops += 1; return hostedOwnsTurn; } };
  cancelConversationGeneration(local, remote);
  expect(hostedStops).toBe(1); expect(localAborts).toBe(0);
  hostedOwnsTurn = false;
  cancelConversationGeneration(local, remote);
  expect(localAborts).toBe(1);
  local.isThinking = false;
  cancelConversationGeneration(local, remote);
  expect(hostedStops).toBe(3); expect(localAborts).toBe(1);
});
