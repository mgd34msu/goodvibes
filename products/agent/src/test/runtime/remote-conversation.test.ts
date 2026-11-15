/**
 * remote-conversation.test.ts
 *
 * The hosted session a native turn is observed in: its event-stream address,
 * and the attachment this surface holds on it (renewed while in use, left on
 * detach or reset, never thrown on failure).
 */

import { describe, expect, test } from 'bun:test';
import type { NativeHostedTurnSnapshot } from '@goodvibes-jev/engine/platform/platform/hosted-sessions/native-turn-client';
import {
  createRemoteConversationRouter,
  hostedSessionEventStreamUrl,
  type ConnectedHostResolution,
} from '../../runtime/client/remote-conversation.ts';

const LIVE_HOST: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'operator-token' };
const snapshot = (sessionId: string): NativeHostedTurnSnapshot => ({
  projectId: 'project', requestId: `request-${sessionId}`, inputId: `input-${sessionId}`, sourceRevision: 'revision',
  state: 'running', sessionId, brokerInputId: `broker-${sessionId}`, correlationId: `correlation-${sessionId}`,
});

interface Call { readonly methodId: string; readonly input: Record<string, unknown> }

function harness(input: {
  readonly invoke?: (methodId: string) => unknown;
  readonly scheduleRenewal?: (run: () => void, ms: number) => () => void;
} = {}) {
  const calls: Call[] = [];
  const router = createRemoteConversationRouter({
    verbs: {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string, payload?: unknown): Promise<T> => {
        calls.push({ methodId, input: (payload ?? {}) as Record<string, unknown> });
        const result = input.invoke?.(methodId) ?? {};
        if (result instanceof Error) throw result;
        return result as T;
      },
    },
    resolveConnection: () => LIVE_HOST,
    conversation: {
      addAssistantMessage: () => {}, addToolResults: () => {}, addSystemMessage: () => {},
      startStreamingBlock: () => {}, updateStreamingBlock: () => {}, finalizeStreamingBlock: () => {},
    },
    requestRender: () => {},
    clientId: 'goodvibes-agent:test',
    reconnect: { enabled: false },
    ...(input.scheduleRenewal ? { scheduleRenewal: input.scheduleRenewal } : {}),
    fetchImpl: (async (request: string | URL | Request) => {
      if (String(request instanceof Request ? request.url : request).endsWith('/permission-mode')) return Response.json({ sessionId: 'hosted-1', mode: 'safe-owner' });
      return new Response(new ReadableStream<Uint8Array>({ start: (controller) => { controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch,
  });
  return { router, calls };
}

describe('the attachment to the hosted session', () => {
  test('is renewed on the schedule while the session is in use, and stops at dispose', async () => {
    let run: () => void = () => {};
    let stopped = 0;
    const { router, calls } = harness({ scheduleRenewal: (fn) => { run = fn; return () => { stopped += 1; }; } });

    await router.observeNative(snapshot('hosted-1'), async () => {});
    run();

    const renewals = calls.filter((call) => call.methodId === 'sessions.hosted.attach');
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    router.dispose();
    expect(stopped).toBe(1);
  });

  test('detach tells the host this surface is leaving, and says when there was nothing to leave', async () => {
    const { router, calls } = harness();

    expect(await router.detach()).toBe('none');
    await router.observeNative(snapshot('hosted-1'), async () => {});
    expect(await router.detach()).toBe('detached');

    expect(calls.find((call) => call.methodId === 'sessions.hosted.detach')?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    router.dispose();
  });

  test('a reset leaves the old session and forgets it', async () => {
    const { router, calls } = harness();

    await router.observeNative(snapshot('hosted-1'), async () => {});
    expect(router.hostedSessionId()).toBe('hosted-1');
    router.reset();
    expect(router.hostedSessionId()).toBeNull();
    expect(calls.find((call) => call.methodId === 'sessions.hosted.detach')?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    router.dispose();
  });

  test('a refused detach is reported as failed, not thrown', async () => {
    const { router } = harness({ invoke: (methodId) => methodId === 'sessions.hosted.detach' ? new Error('host unreachable') : {} });

    await router.observeNative(snapshot('hosted-1'), async () => {});

    expect(await router.detach()).toBe('failed');
    router.dispose();
  });
});

describe('the hosted session event stream address', () => {
  test('is the per-session events route on the connected host', () => {
    expect(hostedSessionEventStreamUrl('http://127.0.0.1:3421', 'hosted-abc'))
      .toBe('http://127.0.0.1:3421/api/sessions/hosted-abc/events');
  });

  test('keeps a base path prefix', () => {
    expect(hostedSessionEventStreamUrl('https://host.example/goodvibes', 'hosted-abc'))
      .toBe('https://host.example/goodvibes/api/sessions/hosted-abc/events');
  });

  test('escapes a session id rather than letting it shape the path', () => {
    expect(hostedSessionEventStreamUrl('http://127.0.0.1:3421', 'a/b'))
      .toBe('http://127.0.0.1:3421/api/sessions/a%2Fb/events');
  });
});
