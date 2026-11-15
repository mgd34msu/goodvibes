import { afterEach, describe, expect, test } from 'bun:test';
import { createBrowserAgentPlatform } from '../platform/src/browser-agent.js';
import {
  createBrowserKnowledgePlatform,
  KNOWLEDGE_BROWSER_ROUTES,
} from '../platform/src/browser-knowledge.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withPreconnect(impl: (input: RequestInfo | URL) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: () => {} });
}

const PATH_PARAMS = { id: 'p', jobId: 'p', sessionId: 'p', taskId: 'p', artifactId: 'p' };

describe('agent browser platform routes', () => {
  test('every method the knowledge platform routes is routed by the agent platform, with the knowledge prefix rewritten', async () => {
    const requested: string[] = [];
    const agent = createBrowserAgentPlatform({
      baseUrl: 'https://daemon.example.com',
      fetch: withPreconnect(async (input) => {
        requested.push(new URL(String(input)).pathname);
        return jsonResponse({});
      }),
    });
    const invoke = agent.operator.invoke as (id: string, input?: unknown) => Promise<unknown>;
    for (const methodId of Object.keys(KNOWLEDGE_BROWSER_ROUTES)) {
      // A method with no route rejects with a ContractError before any request is made.
      await invoke(methodId, PATH_PARAMS);
    }
    expect(requested.length).toBe(Object.keys(KNOWLEDGE_BROWSER_ROUTES).length);
    expect(requested.filter((path) => path.startsWith('/api/knowledge'))).toEqual([]);
    expect(requested).toContain('/api/goodvibes-agent/knowledge/status');
  });

  test('the chat stop and interrupt-and-send calls reach the companion chat routes', async () => {
    const requested: string[] = [];
    const agent = createBrowserAgentPlatform({
      baseUrl: 'https://daemon.example.com',
      fetch: withPreconnect(async (input) => {
        requested.push(new URL(String(input)).pathname);
        return jsonResponse({});
      }),
    });
    await agent.chat.turns.cancel('s1');
    await agent.chat.messages.steer('s1', { body: 'stop and do this instead' } as never);
    expect(requested).toEqual([
      '/api/companion/chat/sessions/s1/turns/cancel',
      '/api/companion/chat/sessions/s1/messages/steer',
    ]);
  });
});

describe('scoped platform HTTP retry', () => {
  test('a read call is retried after a transient 503 when the platform is given a retry policy', async () => {
    let attempts = 0;
    const knowledge = createBrowserKnowledgePlatform({
      baseUrl: 'https://daemon.example.com',
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 },
      fetch: withPreconnect(async () => {
        attempts += 1;
        return attempts === 1 ? jsonResponse({ error: 'busy' }, 503) : jsonResponse({ ready: true });
      }),
    });
    await knowledge.knowledge.status();
    expect(attempts).toBe(2);
  });
});

describe('scoped realtime listeners', () => {
  test('a listener that throws neither tears the stream down nor starves the other listeners', async () => {
    let connections = 0;
    const errors: unknown[] = [];
    let feed: ReadableStreamDefaultController<Uint8Array> | null = null;
    const encoder = new TextEncoder();
    // Each frame is its own session: the realtime turn gate admits one live turn per session.
    const frame = (turnId: string) => 'event: turn\ndata: ' + JSON.stringify({
      type: 'TURN_SUBMITTED',
      ts: 1,
      sessionId: 'session-' + turnId,
      payload: { type: 'TURN_SUBMITTED', turnId, prompt: 'hello' },
    }) + '\n\n';

    const knowledge = createBrowserKnowledgePlatform({
      baseUrl: 'https://daemon.example.com',
      realtime: { onError: (error) => errors.push(error) },
      fetch: withPreconnect(async () => {
        connections += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            feed = controller;
            controller.enqueue(encoder.encode(': ready\n\n'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }),
    });

    const seen: string[] = [];
    let release: () => void = () => {};
    const bothSeen = new Promise<void>((resolve) => { release = resolve; });
    const turn = knowledge.realtime.viaSse().turn;
    cleanups.push(turn.on('TURN_SUBMITTED', () => { throw new Error('listener bug'); }));
    cleanups.push(turn.on('TURN_SUBMITTED', (event) => {
      seen.push(String((event as { turnId?: unknown }).turnId));
      if (seen.length === 2) release();
    }));

    // The stream opens asynchronously; the frames are fed once it has.
    while (feed === null) await new Promise<void>((resolve) => setImmediate(resolve));
    const open = feed as ReadableStreamDefaultController<Uint8Array>;
    open.enqueue(encoder.encode(frame('t1')));
    open.enqueue(encoder.encode(frame('t2')));
    await bothSeen;

    expect(seen).toEqual(['t1', 't2']);
    expect(connections).toBe(1);
    expect(errors.length).toBe(2);
    expect((errors[0] as Error).message).toBe('listener bug');
  });
});

describe('scoped platform event streams', () => {
  test('a path-relative event stream keeps the daemon base path prefix', async () => {
    const requested: string[] = [];
    const knowledge = createBrowserKnowledgePlatform({
      baseUrl: 'https://daemon.example.com/goodvibes',
      fetch: withPreconnect(async (input) => {
        requested.push(String(input));
        return new Response('', { status: 503 });
      }),
    });
    await knowledge.streams.open('/api/control-plane/events', {}).catch(() => undefined);
    expect(requested).toEqual(['https://daemon.example.com/goodvibes/api/control-plane/events']);
  });
});
