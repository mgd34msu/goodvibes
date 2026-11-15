/**
 * hosted-handoff.test.ts
 *
 * Handing an inbound channel conversation to the daemon to host: the setting
 * governs it both ways, the first message creates the hosted session and every
 * later one is steered into it, and no refusal ever costs the owner a message,
 * every one of them falls back to answering in this process.
 */
import { describe, expect, test } from 'bun:test';
import type { DaemonReachability, DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { ConnectedHostVerbError } from '../../runtime/client/daemon-verbs.ts';
import {
  HOSTED_HANDOFF_CLIENT_ID,
  PROMOTION_DISABLED_REASON,
  createHostedConversationHandoff,
  heldDispositionForUnconfirmedHandoff,
  hostedSessionTitle,
  type HostedHandoffRequest,
} from '../../runtime/client/hosted-handoff.ts';

interface Call {
  readonly methodId: string;
  readonly input: unknown;
}

function recorder(options: {
  readonly probe?: DaemonReachability;
  readonly answer?: (methodId: string, input: unknown) => unknown;
}): { readonly verbs: DaemonVerbCaller; readonly calls: Call[] } {
  const calls: Call[] = [];
  const verbs: DaemonVerbCaller = {
    probe: () => options.probe ?? { available: true },
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      calls.push({ methodId, input });
      const answer = options.answer?.(methodId, input);
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
  return { verbs, calls };
}

function request(overrides: Partial<HostedHandoffRequest> = {}): HostedHandoffRequest {
  return {
    sessionId: 'session-a',
    task: 'Continue the conversation. The owner said: fix the sink',
    body: 'fix the sink',
    surfaceKind: 'telegram',
    surfaceId: 'telegram:home',
    ...overrides,
  };
}

/** The calls that act on a conversation, leaving out the lookup that precedes a first create. */
const acting = (calls: readonly Call[]): Call[] => calls.filter((call) => call.methodId !== 'sessions.hosted.list');

const quietLog = { debug: () => {}, info: () => {}, warn: () => {} };

function handoff(options: {
  readonly enabled: boolean;
  readonly verbs: DaemonVerbCaller;
  readonly workspaceRoot?: string;
}): ReturnType<typeof createHostedConversationHandoff> {
  return createHostedConversationHandoff({
    verbs: options.verbs,
    isEnabled: () => options.enabled,
    workspaceRoot: () => options.workspaceRoot ?? '/home/owner/project',
    clientId: 'agent',
    log: quietLog,
  });
}

describe('hosted handoff: the setting decides, and it works both ways', () => {
  test('off: nothing is asked of the daemon and the caller is told to answer locally', async () => {
    const { verbs, calls } = recorder({});
    const outcome = await handoff({ enabled: false, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    expect(outcome).toMatchObject({ disabled: true, reason: PROMOTION_DISABLED_REASON });
    // Off means off: not one round trip was spent finding that out.
    expect(calls).toHaveLength(0);
  });

  test('on: the first message of a conversation creates the hosted session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create'
        ? { session: { id: 'hosted-1' } }
        : {}),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'created' });
    expect(acting(calls)).toHaveLength(1);
    expect(acting(calls)[0]?.methodId).toBe('sessions.hosted.create');
    expect(acting(calls)[0]?.input).toMatchObject({
      workspaceRoot: '/home/owner/project',
      // The OWNER's words open the session, not the broker's enriched framing.
      initialPrompt: 'fix the sink',
      // This conversation's own identity, so a restarted process can find it.
      clientId: 'agent:session-a',
    });
  });

  test('a live toggle takes effect on the next message, not the next restart', async () => {
    let enabled = false;
    const { verbs, calls } = recorder({
      answer: () => ({ session: { id: 'hosted-1' } }),
    });
    const live = createHostedConversationHandoff({
      verbs,
      isEnabled: () => enabled,
      workspaceRoot: () => '/home/owner/project',
      clientId: 'agent',
      log: quietLog,
    });

    expect((await live.promote(request())).promoted).toBe(false);
    enabled = true;
    expect((await live.promote(request())).promoted).toBe(true);
    expect(acting(calls)).toHaveLength(1);
  });
});

describe('hosted handoff: later messages are steered into the same conversation', () => {
  test('the second message steers rather than creating a second session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create' ? { session: { id: 'hosted-1' } } : {}),
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const second = await promoter.promote(request({ body: 'and the tap' }));

    expect(second).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(acting(calls).map((call) => call.methodId)).toEqual(['sessions.hosted.create', 'sessions.hosted.attach', 'sessions.steer']);
    expect(acting(calls)[1]?.input).toEqual({ sessionId: 'hosted-1', clientId: 'agent:session-a' });
    expect(acting(calls)[2]?.input).toMatchObject({
      sessionId: 'hosted-1',
      body: 'and the tap',
      surfaceKind: 'telegram',
      surfaceId: 'telegram:home',
    });
    expect(promoter.hostedIdFor('session-a')).toBe('hosted-1');
  });

  test('two conversations get two hosted sessions', async () => {
    let minted = 0;
    const { verbs } = recorder({
      answer: (methodId) => (methodId === 'sessions.hosted.create'
        ? { session: { id: `hosted-${++minted}` } }
        : {}),
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request({ sessionId: 'session-a' }));
    await promoter.promote(request({ sessionId: 'session-b' }));

    expect(promoter.entries()).toEqual([
      { sessionId: 'session-a', hostedSessionId: 'hosted-1' },
      { sessionId: 'session-b', hostedSessionId: 'hosted-2' },
    ]);
  });

  test('a hosted session that is gone is started again with the message in hand', async () => {
    let minted = 0;
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: `hosted-${++minted}` } };
        if (methodId === 'sessions.hosted.attach') return {};
        return new ConnectedHostVerbError("'sessions.steer' failed: no such session", 404);
      },
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const afterLoss = await promoter.promote(request({ body: 'still there?' }));

    expect(afterLoss).toEqual({ promoted: true, hostedSessionId: 'hosted-2', action: 'recreated' });
    expect(acting(calls).map((call) => call.methodId)).toEqual([
      'sessions.hosted.create',
      'sessions.hosted.attach',
      'sessions.steer',
      'sessions.hosted.create',
    ]);
    expect(acting(calls)[3]?.input).toMatchObject({ initialPrompt: 'still there?' });
  });

  test('a message after a long quiet renews the conversation\'s lease first, and a lease already reaped starts it again', async () => {
    let minted = 0;
    let reaped = false;
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: `hosted-${++minted}` } };
        if (methodId === 'sessions.hosted.attach' && reaped) return new ConnectedHostVerbError("'sessions.hosted.attach' failed: no such session", 404);
        return {};
      },
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    expect(await promoter.promote(request({ body: 'later' }))).toMatchObject({ action: 'steered' });
    reaped = true;
    const after = await promoter.promote(request({ body: 'much later' }));

    expect(after).toEqual({ promoted: true, hostedSessionId: 'hosted-2', action: 'recreated' });
    // The reaped session is never steered into: the renewal answered first.
    expect(acting(calls).map((call) => call.methodId)).toEqual([
      'sessions.hosted.create', 'sessions.hosted.attach', 'sessions.steer', 'sessions.hosted.attach', 'sessions.hosted.create',
    ]);
  });

  test('a renewal that fails for a reason other than "gone" still lets the steer carry the message', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-1' } };
        if (methodId === 'sessions.hosted.attach') return new ConnectedHostVerbError("'sessions.hosted.attach' failed: busy", 503);
        return {};
      },
    });
    const promoter = handoff({ enabled: true, verbs });
    await promoter.promote(request());
    expect(await promoter.promote(request({ body: 'again' }))).toMatchObject({ promoted: true, action: 'steered' });
    expect(acting(calls).map((call) => call.methodId).at(-1)).toBe('sessions.steer');
  });

  test('a steer the daemon could not serve right now does NOT mint a second session', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-1' } };
        return new ConnectedHostVerbError("'sessions.steer' failed: upstream is unwell", 503);
      },
    });
    const promoter = handoff({ enabled: true, verbs });

    await promoter.promote(request());
    const outcome = await promoter.promote(request({ body: 'again' }));

    // A 5xx may have been acted on, so the runner HOLDS the message instead of
    // answering it locally as well (which would answer it twice on the channel).
    expect(outcome).toMatchObject({ promoted: false, unconfirmed: true });
    expect(heldDispositionForUnconfirmedHandoff(outcome)).not.toBeNull();
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
    // The mapping is kept: the conversation is still that hosted session's.
    expect(promoter.hostedIdFor('session-a')).toBe('hosted-1');
  });
});

describe('hosted handoff: every refusal is a stated reason, never a lost message', () => {
  test('an unreachable daemon refuses with the reason the verb layer gave', async () => {
    const { verbs, calls } = recorder({
      probe: { available: false, reason: 'the connected host is disabled (daemon.enabled=false).' },
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toEqual({
      promoted: false,
      disabled: false,
      reason: 'the connected host is disabled (daemon.enabled=false).',
    });
    expect(calls).toHaveLength(0);
  });

  test('a relative workspace root is refused here rather than resolved by the daemon', async () => {
    const { verbs, calls } = recorder({});
    const outcome = await handoff({ enabled: true, verbs, workspaceRoot: 'project' }).promote(request());

    expect(outcome.promoted).toBe(false);
    expect(outcome).toMatchObject({ disabled: false });
    if (!outcome.promoted) expect(outcome.reason).toContain('absolute');
    expect(calls).toHaveLength(0);
  });

  test('a host at its hosted-session cap refuses with the daemon\'s own words', async () => {
    const { verbs } = recorder({
      answer: () => new ConnectedHostVerbError(
        "'sessions.hosted.create' failed: 8 hosted sessions are live and hostedSessions.maxSessions is 8",
        429,
      ),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    if (!outcome.promoted) expect(outcome.reason).toContain('hostedSessions.maxSessions');
  });

  test('a reply with no readable session id is reported, not treated as a promotion', async () => {
    const { verbs } = recorder({ answer: () => ({ session: {} }) });
    const promoter = handoff({ enabled: true, verbs });
    const outcome = await promoter.promote(request());

    expect(outcome.promoted).toBe(false);
    expect(promoter.hostedIdFor('session-a')).toBeNull();
  });

  test('a 404 from a host that has not wired the verb is named as such', async () => {
    const { verbs } = recorder({
      answer: () => new ConnectedHostVerbError("'sessions.hosted.create' failed: HTTP 404", 404),
    });
    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome.promoted).toBe(false);
    if (!outcome.promoted) expect(outcome.reason).toContain('not wired');
  });
});

describe('hosted handoff: the session list reads like the conversation', () => {
  test('the title carries the channel and the owner\'s words', () => {
    expect(hostedSessionTitle(request())).toBe('telegram: fix the sink');
    expect(hostedSessionTitle(request({ displayName: 'Mike' }))).toBe('Mike: fix the sink');
  });

  test('a long message is cut rather than pasted whole into a list row', () => {
    const title = hostedSessionTitle(request({ body: 'x'.repeat(200), surfaceKind: undefined }));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  test('an empty message still gets a name', () => {
    expect(hostedSessionTitle(request({ body: '   ', task: '  ', surfaceKind: undefined }))).toBe('Inbound conversation');
  });
});

describe('hosted handoff: one conversation survives a restart and overlapping messages', () => {
  test('two messages arriving together create one session and the second steers into it', async () => {
    const creates: Array<(reply: unknown) => void> = [];
    const calls: Call[] = [];
    const verbs: DaemonVerbCaller = {
      probe: () => ({ available: true }),
      invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
        calls.push({ methodId, input });
        if (methodId === 'sessions.hosted.create') return await new Promise<T>((resolve) => { creates.push(resolve as (reply: unknown) => void); });
        return {} as T;
      },
    };
    const promoter = handoff({ enabled: true, verbs });

    const first = promoter.promote(request());
    const second = promoter.promote(request({ body: 'and the tap' }));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    for (let i = 0; i < 5 && creates.length === 0; i += 1) await Promise.resolve();
    creates[0]!({ session: { id: 'hosted-1' } });

    expect(await first).toMatchObject({ action: 'created' });
    expect(await second).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
  });

  test('a restarted process finds the conversation\'s hosted session and steers instead of creating', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.list') {
          return { sessions: [
            { id: 'hosted-other', status: 'idle', attachedClients: ['agent:session-b'] },
            { id: 'hosted-old', status: 'terminated', attachedClients: ['agent:session-a'] },
            { id: 'hosted-1', status: 'idle', attachedClients: ['agent:session-a'] },
          ] };
        }
        return {};
      },
    });

    const outcome = await handoff({ enabled: true, verbs }).promote(request({ body: 'still there?' }));

    expect(outcome).toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(calls.map((call) => call.methodId)).toEqual(['sessions.hosted.list', 'sessions.hosted.attach', 'sessions.steer']);
  });

  test('a restart under a different process identity still finds the conversation', async () => {
    const hosted = new Map<string, string[]>();
    const shared = recorder({
      answer: (methodId, input) => {
        if (methodId === 'sessions.hosted.create') {
          hosted.set('hosted-1', [(input as { clientId: string }).clientId]);
          return { session: { id: 'hosted-1' } };
        }
        if (methodId === 'sessions.hosted.list') {
          return { sessions: [...hosted].map(([id, attachedClients]) => ({ id, status: 'idle', attachedClients })) };
        }
        return {};
      },
    });
    const start = (clientId: string) => createHostedConversationHandoff({
      verbs: shared.verbs, isEnabled: () => true, workspaceRoot: () => '/home/owner/project', clientId, log: quietLog,
    });

    expect(await start(HOSTED_HANDOFF_CLIENT_ID).promote(request())).toMatchObject({ action: 'created' });
    // A new process: the same stable identity must find the old session.
    expect(await start(HOSTED_HANDOFF_CLIENT_ID).promote(request({ body: 'again' })))
      .toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(shared.calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
  });

  test('a restarted process steers into a live session whose attachedClients is empty', async () => {
    let mapping: Record<string, string> = {};
    const store = { load: () => ({ ...mapping }), save: (next: Record<string, string>) => { mapping = { ...next }; } };
    const shared = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-1' } };
        // The daemon cleared the list on lease lapse; the session is still live.
        if (methodId === 'sessions.hosted.list') return { sessions: [{ id: 'hosted-1', status: 'idle', attachedClients: [] }] };
        return {};
      },
    });
    const start = () => createHostedConversationHandoff({
      verbs: shared.verbs, isEnabled: () => true, workspaceRoot: () => '/home/owner/project',
      clientId: HOSTED_HANDOFF_CLIENT_ID, store, log: quietLog,
    });

    expect(await start().promote(request())).toMatchObject({ action: 'created' });
    expect(mapping).toEqual({ 'session-a': 'hosted-1' });
    expect(await start().promote(request({ body: 'later' })))
      .toEqual({ promoted: true, hostedSessionId: 'hosted-1', action: 'steered' });
    expect(shared.calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
  });

  test('a persisted mapping to a terminated session is replaced and the new one persisted', async () => {
    let mapping: Record<string, string> = { 'session-a': 'hosted-old' };
    const store = { load: () => ({ ...mapping }), save: (next: Record<string, string>) => { mapping = { ...next }; } };
    const { verbs } = recorder({
      answer: (methodId, input) => {
        if (methodId === 'sessions.steer' && (input as { sessionId: string }).sessionId === 'hosted-old') {
          return new ConnectedHostVerbError('Hosted session hosted-old is unavailable: it is terminated (killed).', 409);
        }
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-2' } };
        return {};
      },
    });
    const outcome = await createHostedConversationHandoff({
      verbs, isEnabled: () => true, workspaceRoot: () => '/home/owner/project', clientId: 'agent', store, log: quietLog,
    }).promote(request());
    expect(outcome).toMatchObject({ action: 'recreated', hostedSessionId: 'hosted-2' });
    expect(mapping).toEqual({ 'session-a': 'hosted-2' });
  });

  test('the production client id carries nothing that differs between processes', () => {
    expect(HOSTED_HANDOFF_CLIENT_ID).not.toContain(String(process.pid));
    expect(HOSTED_HANDOFF_CLIENT_ID).toMatch(/^[a-z][a-z-]*$/);
  });

  test('a 409 that names a terminated session starts the conversation again', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.steer') return new ConnectedHostVerbError("'sessions.steer' failed: Hosted session hosted-1 is unavailable: it is terminated (killed).", 409);
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-2' } };
        return {};
      },
    });
    const promoter = handoff({ enabled: true, verbs });
    await promoter.promote(request()); // creates hosted-2 mapping via create path
    const outcome = await promoter.promote(request({ body: 'next' }));
    expect(outcome).toEqual({ promoted: true, hostedSessionId: 'hosted-2', action: 'recreated' });
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(2);
  });

  test('a 409 on a session that may still be live does not fork the conversation', async () => {
    const { verbs, calls } = recorder({
      answer: (methodId) => {
        if (methodId === 'sessions.steer') return new ConnectedHostVerbError("'sessions.steer' failed: Hosted session hosted-1 is unavailable: its loop could not be composed.", 409);
        if (methodId === 'sessions.hosted.create') return { session: { id: 'hosted-1' } };
        return {};
      },
    });
    const promoter = handoff({ enabled: true, verbs });
    await promoter.promote(request());
    const outcome = await promoter.promote(request({ body: 'next' }));
    expect(outcome.promoted).toBe(false);
    expect(promoter.hostedIdFor('session-a')).toBe('hosted-1');
    expect(calls.filter((call) => call.methodId === 'sessions.hosted.create')).toHaveLength(1);
  });

  test('a create whose reply is lost is reported as unconfirmed, not as a plain refusal', async () => {
    const { verbs } = recorder({
      answer: (methodId) => methodId === 'sessions.hosted.create' ? new Error('socket hang up') : undefined,
    });

    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toMatchObject({ promoted: false, disabled: false, unconfirmed: true });
    // The runner holds the message instead of answering it locally as well.
    expect(heldDispositionForUnconfirmedHandoff(outcome)).toEqual({ disposition: 'held', reason: (outcome as { reason: string }).reason });
  });

  test('a definite refusal is not marked unconfirmed', async () => {
    const { verbs } = recorder({
      answer: (methodId) => methodId === 'sessions.hosted.create' ? new ConnectedHostVerbError('at capacity', 429) : undefined,
    });

    const outcome = await handoff({ enabled: true, verbs }).promote(request());

    expect(outcome).toMatchObject({ promoted: false });
    expect((outcome as { unconfirmed?: true }).unconfirmed).toBeUndefined();
    expect(heldDispositionForUnconfirmedHandoff(outcome)).toBeNull();
  });
});

