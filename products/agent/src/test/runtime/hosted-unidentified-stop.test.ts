import { expect, test } from 'bun:test';
import { createRemoteConversationRouter } from '../../runtime/client/remote-conversation.ts';

test('a second Stop stops waiting on a submission the host never identifies', async () => {
  const notices: string[] = [];
  let barrierSeen: (() => void) | undefined;
  const barrierReached = new Promise<void>((resolve) => { barrierSeen = resolve; });
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0,
    fetch(request) {
      // Only the session's event stream is a stream; any other read (the permission mode) is plain JSON.
      if (request.method !== 'GET' || !new URL(request.url).pathname.endsWith('/events')) return Response.json({});
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; controller.enqueue(new TextEncoder().encode(': ready\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const verbs = { probe: () => ({ available: true as const }), async invoke<T>(method: string): Promise<T> { return (method === 'sessions.hosted.create' ? { session: { id: 'hosted' } } : {}) as T; } };
  const conversation = { addUserMessage() {}, addAssistantMessage() {}, addToolResults() {}, addSystemMessage() {}, startStreamingBlock() {}, updateStreamingBlock() {}, finalizeStreamingBlock() {} };
  const router = createRemoteConversationRouter({ verbs, configManager: { get: () => undefined as never }, resolveConnection: () => ({ baseUrl: server.url.origin, token: 'synthetic-token' }),
    conversation, requestRender() {}, workspaceRoot: '/synthetic', clientId: 'agent-test', reconnect: { enabled: false }, onCancellationNotice: text => notices.push(text),
    onFrame: frame => { if (frame.type === 'FIXTURE_BARRIER') barrierSeen?.(); } });
  try {
    const outcome = await router.submit('question');
    if (!outcome.routed) throw new Error(outcome.reason);
    // An older host: the turn starts without echoing this submission's correlation.
    stream?.enqueue(new TextEncoder().encode(`id: e1\nevent: turn\ndata: ${JSON.stringify({ type: 'TURN_SUBMITTED', sessionId: 'hosted', payload: { type: 'TURN_SUBMITTED', turnId: 't1', origin: {} } })}\n\n`));
    // Frames are handled in order: once the barrier frame that follows it is
    // observed, the unidentified start has been processed, so the first Stop
    // below really is a Stop on a submission the host never identified.
    stream?.enqueue(new TextEncoder().encode(`id: e2\nevent: turn\ndata: ${JSON.stringify({ type: 'FIXTURE_BARRIER', sessionId: 'hosted', payload: { type: 'FIXTURE_BARRIER' } })}\n\n`));
    await barrierReached;
    expect(notices.some((text) => text.includes('has not identified this submission'))).toBe(true);
    expect(router.cancelTurn()).toBe(true);
    expect(notices.at(-1)).toContain('Press Stop again');
    expect(router.cancelTurn()).toBe(true);
    expect((await outcome.completion).status).toBe('abandoned');
  } finally { router.dispose(); await server.stop(true); }
});
