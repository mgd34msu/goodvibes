/**
 * remote-conversation-outcomes.test.ts
 *
 * What the router does when the daemon's answer is lost, wrong or late: a
 * message whose outcome is unknown must not also run locally, a reply that
 * names a different session is not a routed turn, a replaced hosted session is
 * disclosed, an unused session is left, and the attachment is kept alive and
 * released.
 */
import { describe, expect, test } from 'bun:test';
import {
  createRemoteConversationRouter,
  type ConnectedHostResolution,
} from '../../runtime/client/remote-conversation.ts';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';

const LIVE_HOST: ConnectedHostResolution = { baseUrl: 'http://127.0.0.1:3421', token: 'operator-token' };

interface Call { readonly methodId: string; readonly input: Record<string, unknown> }

function harness(input: {
  readonly invoke: (methodId: string, payload: Record<string, unknown>, call: number) => unknown;
  readonly scheduleRenewal?: (run: () => void, ms: number) => () => void;
}) {
  const calls: Call[] = [];
  const system: string[] = [];
  const router = createRemoteConversationRouter({
    verbs: {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string, payload?: unknown): Promise<T> => {
        const body = (payload ?? {}) as Record<string, unknown>;
        calls.push({ methodId, input: body });
        const result = await input.invoke(methodId, body, calls.length);
        if (result instanceof Error) throw result;
        return result as T;
      },
    },
    configManager: { get: ((key: string) => key === 'hostedSessions.routeConversationTurns' ? true : undefined) as never },
    resolveConnection: () => LIVE_HOST,
    conversation: {
      addAssistantMessage: () => {}, addToolResults: () => {},
      addSystemMessage: (content: string) => { system.push(content); },
      startStreamingBlock: () => {}, updateStreamingBlock: () => {}, finalizeStreamingBlock: () => {},
    },
    requestRender: () => {},
    workspaceRoot: '/home/someone/project',
    clientId: 'goodvibes-agent:test',
    reconnect: { enabled: false },
    ...(input.scheduleRenewal ? { scheduleRenewal: input.scheduleRenewal } : {}),
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      start: (controller) => { controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch,
  });
  return { router, calls, system };
}

const createdAs = (id: string) => ({ session: { id } });

describe('a steer whose outcome is unknown', () => {
  test.each([
    ['a 502', new ConnectedHostVerbError('bad gateway', 502)],
    ['a dropped connection', new Error('socket hang up')],
  ])('after %s the message is not also run locally', async (_label, failure) => {
    const { router, calls } = harness({
      invoke: (methodId) => methodId === 'sessions.hosted.create' ? createdAs('hosted-1') : failure,
    });

    const outcome = await router.submit('deploy it');

    expect(outcome).toMatchObject({ routed: false, chosen: true, cancelled: true });
    if (outcome.routed) throw new Error('unreachable');
    expect(outcome.reason).toContain('not run locally');
    expect(calls.filter((call) => call.methodId === 'sessions.steer')).toHaveLength(1);
    router.dispose();
  });

  test('a definite refusal still lets the caller run the message here', async () => {
    const { router } = harness({
      invoke: (methodId) => methodId === 'sessions.hosted.create' ? createdAs('hosted-1') : new ConnectedHostVerbError('bad request', 400),
    });

    const outcome = await router.submit('hello');

    expect(outcome).toMatchObject({ routed: false, chosen: false });
    router.dispose();
  });
});

describe('a steer the daemon answered from somewhere else', () => {
  test('a reply naming another session is not a routed turn, and the next message opens a new session', async () => {
    let creates = 0;
    const { router, calls } = harness({
      invoke: (methodId) => {
        if (methodId === 'sessions.hosted.create') { creates += 1; return createdAs(`hosted-${creates}`); }
        return { session: { id: 'someone-elses-session' }, mode: 'spawn' };
      },
    });

    const first = await router.submit('hello');

    expect(first).toMatchObject({ routed: false, chosen: true, cancelled: true });
    expect(router.hostedSessionId()).toBeNull();
    await router.submit('again');
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(2);
    router.dispose();
  });
});

describe('a replaced hosted session', () => {
  test('is disclosed in the transcript when the remembered one is gone', async () => {
    let steers = 0;
    let creates = 0;
    const { router, system } = harness({
      invoke: (methodId) => {
        if (methodId === 'sessions.hosted.create') { creates += 1; return createdAs(`hosted-${creates}`); }
        steers += 1;
        return steers === 2 ? new ConnectedHostVerbError('gone', 404) : {};
      },
    });

    const lost = () => system.filter((line) => line.includes('no memory of what came before'));
    await router.submit('first');
    expect(lost()).toEqual([]);
    const second = await router.submit('second');

    expect(second).toMatchObject({ routed: true, action: 'recreated' });
    expect(lost()).toHaveLength(1);
    router.dispose();
  });
});

describe('a session created for a submission that was replaced', () => {
  test('is left rather than orphaned', async () => {
    const pendingCreates: Array<(reply: unknown) => void> = [];
    const { router, calls } = harness({
      invoke: (methodId) => {
        if (methodId === 'sessions.hosted.create') return new Promise((resolve) => { pendingCreates.push(resolve); });
        return {};
      },
    });

    const first = router.submit('first');
    await Promise.resolve();
    const second = router.submit('second');
    await Promise.resolve();
    expect(pendingCreates).toHaveLength(2);
    pendingCreates[0]!(createdAs('orphan-1'));
    await first;

    const detaches = calls.filter((call) => call.methodId === 'sessions.hosted.detach');
    expect(detaches).toHaveLength(1);
    expect(detaches[0]?.input).toEqual({ sessionId: 'orphan-1', clientId: 'goodvibes-agent:test' });

    pendingCreates[1]!(createdAs('live-2'));
    expect(await second).toMatchObject({ routed: true, hostedSessionId: 'live-2' });
    router.dispose();
  });
});

describe('the attachment to the hosted session', () => {
  test('is renewed on the schedule while the session is in use, and stops at dispose', async () => {
    let run: () => void = () => {};
    let stopped = 0;
    const { router, calls } = harness({
      invoke: (methodId) => methodId === 'sessions.hosted.create' ? createdAs('hosted-1') : {},
      scheduleRenewal: (fn) => { run = fn; return () => { stopped += 1; }; },
    });

    await router.submit('hello');
    run();

    const renewals = calls.filter((call) => call.methodId === 'sessions.hosted.attach');
    expect(renewals).toHaveLength(1);
    expect(renewals[0]?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    router.dispose();
    expect(stopped).toBe(1);
  });

  test('detach tells the daemon this surface is leaving, and says when there was nothing to leave', async () => {
    const { router, calls } = harness({
      invoke: (methodId) => methodId === 'sessions.hosted.create' ? createdAs('hosted-1') : {},
    });

    expect(await router.detach()).toBe('none');
    await router.submit('hello');
    expect(await router.detach()).toBe('detached');

    const detach = calls.find((call) => call.methodId === 'sessions.hosted.detach');
    expect(detach?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    router.dispose();
  });

  test('after a reset the next message creates a new hosted session and the old one is left', async () => {
    let minted = 0;
    const { router, calls } = harness({
      invoke: (methodId) => methodId === 'sessions.hosted.create' ? createdAs(`hosted-${++minted}`) : {},
    });

    await router.submit('first');
    expect(router.hostedSessionId()).toBe('hosted-1');
    router.reset();
    expect(router.hostedSessionId()).toBeNull();
    const second = await router.submit('second');

    expect(second).toMatchObject({ routed: true, hostedSessionId: 'hosted-2', action: 'created' });
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(2);
    expect(calls.find((call) => call.methodId === 'sessions.hosted.detach')?.input).toEqual({ sessionId: 'hosted-1', clientId: 'goodvibes-agent:test' });
    // Each message went to the session it created; the cleared one received only its own.
    expect(calls.filter((call) => call.methodId === 'sessions.steer').map((call) => call.input.sessionId)).toEqual(['hosted-1', 'hosted-2']);
    router.dispose();
  });

  test('a refused detach is reported as failed, not thrown', async () => {
    const { router } = harness({
      invoke: (methodId) => {
        if (methodId === 'sessions.hosted.create') return createdAs('hosted-1');
        if (methodId === 'sessions.hosted.detach') return new Error('host unreachable');
        return {};
      },
    });

    await router.submit('hello');

    expect(await router.detach()).toBe('failed');
    router.dispose();
  });
});
