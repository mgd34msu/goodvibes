/** Home Assistant conversation: one chat session per conversation under
 * concurrency, one posted turn per client messageId, honest cancel / failure
 * statuses, and a cancel that can only reach Home Assistant's own sessions. */
import { describe, expect, test } from 'bun:test';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.js';
import type { CompanionChatTurnEvent } from '../platform/src/platform/companion/companion-chat-types.js';
import { HomeAssistantConversationRoutes } from '../platform/src/platform/daemon/http/homeassistant-routes.js';
import {
  resolveHomeAssistantChatSession,
  type HomeAssistantChatInput,
  type HomeAssistantChatRuntime,
} from '../platform/src/platform/daemon/homeassistant-chat.js';

const HA_PROMPT = 'You are GoodVibes responding inside Home Assistant.\n\nAnswer as a normal assistant.';

type ChatMessage = { id: string; role: 'user' | 'assistant'; content: string; inReplyTo?: string; deliveryState?: string };
type Reply = { messageId: string; assistantMessageId?: string; response?: string; error?: string; timedOut?: true };
type PostWait = (sessionId: string, content: string, clientId: string, options: { onTurnEvent?: (event: CompanionChatTurnEvent) => void }) => Promise<Reply>;

/** In-memory chat manager and route bindings; `binding metadata` is shared across upserts like the real store. */
function fixture(options: { postDetached?: (options: { onTurnEvent?: (event: CompanionChatTurnEvent) => void }) => void; postWait?: PostWait; homeGraphAsk?: () => Promise<never>; caller?: { admin: boolean; scopes: readonly string[] } } = {}) {
  const caller = options.caller ?? { admin: true, scopes: [] };
  const sessions = new Map<string, { id: string; status: string; title: string; updatedAt: number; systemPrompt: string | null }>();
  const transcripts = new Map<string, ChatMessage[]>();
  const bindingMetadata: Record<string, unknown> = {};
  const created: string[] = [];
  const posted: string[] = [];
  const cancels: Array<{ sessionId: string; input: unknown }> = [];
  let cancelImpl: (sessionId: string, input: unknown) => Promise<unknown> = async () => ({ cancelled: true });
  let nextSession = 0;
  const chatManager = {
    init: async () => undefined,
    getSession: (id: string) => sessions.get(id) ?? null,
    getMessages: (id: string) => [...(transcripts.get(id) ?? [])],
    createSession: (input: { title?: string; systemPrompt?: string }) => {
      const session = { id: `ha-session-${++nextSession}`, status: 'active', title: input.title ?? '', updatedAt: Date.now(), systemPrompt: input.systemPrompt ?? null };
      sessions.set(session.id, session);
      created.push(session.id);
      return session;
    },
    updateSession: (id: string) => sessions.get(id)!,
    closeSession: () => null,
    postMessage: async (sessionId: string, _content: string, _clientId: string, opts: { onTurnEvent?: (event: CompanionChatTurnEvent) => void } = {}) => { posted.push(sessionId); options.postDetached?.(opts); return `user-msg-${posted.length}`; },
    postMessageAndWaitForReply: (async (sessionId, content, clientId, opts) => {
      posted.push(sessionId);
      return (options.postWait ?? (async () => ({ messageId: `user-msg-${posted.length}`, response: 'ok' })))(sessionId, content, clientId, opts);
    }) as PostWait,
    cancelTurn: async (sessionId: string, input: unknown) => { cancels.push({ sessionId, input }); return cancelImpl(sessionId, input); },
  };
  const routeBindings = {
    start: async () => undefined,
    upsertBinding: async (input: Partial<AutomationRouteBinding>) => ({
      id: 'route-ha', kind: 'channel', surfaceKind: 'homeassistant', surfaceId: String(input.surfaceId),
      externalId: String(input.externalId), channelId: String(input.channelId),
      createdAt: 0, updatedAt: 0, lastSeenAt: 0,
      metadata: { ...(input.metadata ?? {}), ...bindingMetadata },
    } as AutomationRouteBinding),
    patchBinding: async (_id: string, patch: { metadata?: Record<string, unknown> }) => {
      await Promise.resolve();
      Object.assign(bindingMetadata, patch.metadata ?? {});
      return null;
    },
  };
  const runtime = {
    configManager: { get: () => undefined },
    routeBindings,
    chatManager,
    resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
    ...(options.homeGraphAsk ? { homeGraph: { ask: options.homeGraphAsk } } : {}),
  } as unknown as HomeAssistantChatRuntime;
  const routes = new HomeAssistantConversationRoutes({
    configManager: {
      get: (key: string): unknown => ({
        'surfaces.homeassistant.enabled': true,
        'surfaces.homeassistant.defaultConversationId': 'goodvibes',
        'surfaces.homeassistant.remoteSessionTtlMs': 20 * 60_000,
      } as Record<string, unknown>)[key],
    },
    routeBindings,
    chatManager,
    parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
    requireScope: (_req: Request, scope: string) => (caller.admin || caller.scopes.includes(scope) ? null : Response.json({ error: `missing scope ${scope}` }, { status: 403 })),
    requireAdmin: () => (caller.admin ? null : Response.json({ error: 'admin required' }, { status: 403 })),
    resolveDefaultProviderModel: () => ({ provider: 'openai', model: 'gpt-5.5' }),
  } as unknown as ConstructorParameters<typeof HomeAssistantConversationRoutes>[0]);
  return {
    routes, runtime, created, posted, cancels, transcripts, sessions,
    onCancel(impl: typeof cancelImpl) { cancelImpl = impl; },
  };
}

function conversation(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://daemon.local/api/homeassistant/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function chatInput(overrides: Partial<HomeAssistantChatInput> = {}): HomeAssistantChatInput {
  return {
    text: 'is the door locked', messageId: 'm1', conversationId: 'c1', surfaceId: 'homeassistant', channelId: 'kitchen',
    title: 'Home Assistant', remoteSessionTtlMs: 20 * 60_000, ...overrides,
  };
}

describe('one chat session per conversation', () => {
  test('two overlapping first messages share the session the first one creates', async () => {
    const gate = Promise.withResolvers<never>();
    const { runtime, created } = fixture({ homeGraphAsk: () => gate.promise });
    const grounded = chatInput({ grounding: { installationId: 'house-1' } });
    const first = resolveHomeAssistantChatSession(runtime, grounded);
    const second = resolveHomeAssistantChatSession(runtime, { ...grounded, messageId: 'm2' });
    gate.reject(new Error('graph unavailable'));
    const [a, b] = await Promise.all([first, second]);
    expect(created).toHaveLength(1);
    expect(a.session.id).toBe(b.session.id);
    expect(a.newSession).toBe(true);
    expect(b.newSession).toBe(false);
    expect(b.binding.metadata.homeAssistantChatSessionId).toBe(a.session.id);
  });

  test('different conversations do not wait for each other', async () => {
    const { runtime, created } = fixture();
    const [a, b] = await Promise.all([
      resolveHomeAssistantChatSession(runtime, chatInput({ conversationId: 'c1' })),
      resolveHomeAssistantChatSession(runtime, chatInput({ conversationId: 'c2' })),
    ]);
    expect(created).toHaveLength(2);
    expect(a.session.id).not.toBe(b.session.id);
  });
});

describe('a repeated messageId posts the utterance once', () => {
  test('a retry while the first submit still waits shares its outcome', async () => {
    const gate = Promise.withResolvers<Reply>();
    const { routes, posted } = fixture({ postWait: () => gate.promise });
    const first = routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-1', conversationId: 'c1' }));
    const retry = routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-1', conversationId: 'c1' }));
    gate.resolve({ messageId: 'user-msg-1', assistantMessageId: 'a1', response: 'Locked.' });
    const [one, two] = await Promise.all([first, retry]);
    expect(posted).toHaveLength(1);
    expect(one?.status).toBe(200);
    expect(await two!.json()).toMatchObject({ status: 'completed', duplicate: true, assistant: { text: 'Locked.' } });
  });

  test('a retry after a 202 timeout reports the running turn, then its reply, without posting again', async () => {
    const { routes, posted, transcripts } = fixture({
      postWait: async () => ({ messageId: 'user-msg-1', timedOut: true, error: 'Timed out waiting for companion chat reply' }),
    });
    const timedOut = await routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-2', conversationId: 'c1' }));
    expect(timedOut?.status).toBe(202);
    const running = await routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-2', conversationId: 'c1' }));
    expect(running?.status).toBe(202);
    expect(await running!.json()).toMatchObject({ status: 'running', duplicate: true });

    transcripts.set('ha-session-1', [
      { id: 'user-msg-1', role: 'user', content: 'lock up' },
      { id: 'assistant-1', role: 'assistant', content: 'Locked.', inReplyTo: 'user-msg-1' },
    ]);
    const done = await routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-2', conversationId: 'c1' }));
    expect(done?.status).toBe(200);
    expect(await done!.json()).toMatchObject({ status: 'completed', duplicate: true, assistant: { text: 'Locked.' } });
    expect(posted).toHaveLength(1);
  });

  test('a submit that was refused before posting can be retried with the same messageId', async () => {
    let attempt = 0;
    const { routes, posted } = fixture({
      postWait: async () => {
        if (++attempt === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
        return { messageId: 'user-msg-2', response: 'Locked.' };
      },
    });
    const refused = await routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-3', conversationId: 'c1' }));
    expect(refused?.status).toBe(429);
    const retried = await routes.handle(conversation('conversation', { message: 'lock up', messageId: 'dup-3', conversationId: 'c1' }));
    expect(retried?.status).toBe(200);
    expect(await retried!.json()).toMatchObject({ status: 'completed' });
    expect(posted).toHaveLength(2);
  });

  test('server-generated ids never collide, so submits without a messageId always post', async () => {
    const { routes, posted } = fixture();
    await routes.handle(conversation('conversation', { message: 'one', conversationId: 'c1' }));
    await routes.handle(conversation('conversation', { message: 'two', conversationId: 'c1' }));
    expect(posted).toHaveLength(2);
  });
});

describe('submit outcomes', () => {
  test('a turn the user cancelled answers cancelled / 409, not failed / 500', async () => {
    const { routes } = fixture({
      postWait: async (_s, _c, _id, opts) => {
        opts.onTurnEvent?.({ type: 'turn.cancelled', sessionId: 's', turnId: 't1', stoppedBy: 'user', partialPersisted: false } as CompanionChatTurnEvent);
        return { messageId: 'user-msg-1', error: 'Turn cancelled' };
      },
    });
    const response = await routes.handle(conversation('conversation', { message: 'long task', conversationId: 'c1' }));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ ok: false, status: 'cancelled' });
  });

  test('a failure that merely mentions cancelling stays failed', async () => {
    const { routes } = fixture({ postWait: async () => ({ messageId: 'user-msg-1', error: 'Turn cancelled by the provider quota' }) });
    const response = await routes.handle(conversation('conversation', { message: 'x', conversationId: 'c1' }));
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ status: 'failed' });
  });

  test('a post refused with a rate limit keeps its 429', async () => {
    const { routes } = fixture({ postWait: async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); } });
    const response = await routes.handle(conversation('conversation', { message: 'x', conversationId: 'c1' }));
    expect(response?.status).toBe(429);
    expect(await response!.json()).toMatchObject({ ok: false, status: 'rejected' });
  });

  test('a post that fails without a status is a server fault, 500', async () => {
    const { routes } = fixture({ postWait: async () => { throw new Error('provider unreachable'); } });
    const response = await routes.handle(conversation('conversation', { message: 'x', conversationId: 'c1' }));
    expect(response?.status).toBe(500);
    expect(await response!.json()).toMatchObject({ ok: false, status: 'failed', error: 'provider unreachable' });
  });

  test('a tools list is refused with 400 and nothing is posted, and a fire-and-forget submit returns the chat message id', async () => {
    const { routes, posted } = fixture();
    const withTools = await routes.handle(conversation('conversation', { message: 'x', conversationId: 'c1', tools: ['homeassistant_state'] }));
    expect(withTools?.status).toBe(400);
    expect(await withTools!.json()).toMatchObject({ ok: false, status: 'rejected', error: expect.stringContaining('tools') });
    expect(posted).toHaveLength(0);
    const detached = await routes.handle(conversation('conversation', { message: 'y', conversationId: 'c1', wait: false }));
    expect(detached?.status).toBe(202);
    expect(await detached!.json()).toMatchObject({ status: 'running', chatMessageId: expect.any(String) });
  });
});

describe('conversation access', () => {
  test('a token without write:sessions can neither post, stream nor cancel, and nothing is posted', async () => {
    const { routes, posted, cancels } = fixture({ caller: { admin: false, scopes: ['read:sessions'] } });
    for (const path of ['conversation', 'conversation/stream', 'conversation/cancel']) {
      const response = await routes.handle(conversation(path, { message: 'x', conversationId: 'c1', sessionId: 's' }));
      expect(response?.status, path).toBe(403);
    }
    expect(posted).toHaveLength(0);
    expect(cancels).toHaveLength(0);
  });

  test('a write:sessions token may post, but a provider or model of its own choosing needs admin', async () => {
    const { routes, posted } = fixture({ caller: { admin: false, scopes: ['write:sessions'] } });
    expect((await routes.handle(conversation('conversation', { message: 'x', conversationId: 'c1' })))?.status).toBe(200);
    const posts = posted.length;
    expect((await routes.handle(conversation('conversation', { message: 'y', conversationId: 'c1', modelId: 'big' })))?.status).toBe(403);
    expect((await routes.handle(conversation('conversation/stream', { message: 'y', conversationId: 'c1', provider: 'x' })))?.status).toBe(403);
    expect(posted).toHaveLength(posts);
  });

  test('health needs read:sessions', async () => {
    const { routes } = fixture({ caller: { admin: false, scopes: [] } });
    expect((await routes.handle(new Request('http://daemon.local/api/homeassistant/health')))?.status).toBe(403);
  });
});

describe('conversation cancel', () => {
  test('only a session this surface created can be cancelled', async () => {
    const { routes, cancels, sessions } = fixture();
    sessions.set('tui-session-9', { id: 'tui-session-9', status: 'active', title: 'TUI', updatedAt: 0, systemPrompt: null });
    sessions.set('ha-session-9', { id: 'ha-session-9', status: 'active', title: 'HA', updatedAt: 0, systemPrompt: HA_PROMPT });
    const foreign = await routes.handle(conversation('conversation/cancel', { sessionId: 'tui-session-9' }));
    expect(foreign?.status).toBe(404);
    expect(cancels).toEqual([]);
    const own = await routes.handle(conversation('conversation/cancel', { sessionId: 'ha-session-9' }));
    expect(own?.status).toBe(200);
    expect(cancels).toEqual([{ sessionId: 'ha-session-9', input: {} }]);
  });

  test('cancelling by messageId stops only that message\'s turn', async () => {
    const { routes, cancels, onCancel } = fixture({
      postWait: async (_s, _c, _id, opts) => {
        opts.onTurnEvent?.({ type: 'turn.started', sessionId: 's', turnId: 'turn-old', messageId: 'user-msg-1' } as unknown as CompanionChatTurnEvent);
        return { messageId: 'user-msg-1', response: 'done' };
      },
    });
    await routes.handle(conversation('conversation', { message: 'first', messageId: 'old-msg', conversationId: 'c1' }));
    onCancel(async () => { throw Object.assign(new Error('a newer turn is running'), { code: 'TURN_MISMATCH', status: 409 }); });
    const response = await routes.handle(conversation('conversation/cancel', { messageId: 'old-msg' }));
    expect(cancels).toEqual([{ sessionId: 'ha-session-1', input: { turnId: 'turn-old' } }]);
    // The turn the caller named is no longer running, so the stop intent is already true.
    expect(response?.status).toBe(200);
  });

  test('a message whose turn has not started cannot be cancelled by messageId, and no other turn is stopped', async () => {
    const { routes, cancels } = fixture();
    await routes.handle(conversation('conversation', { message: 'queued', messageId: 'q-msg', conversationId: 'c1', wait: false }));
    const response = await routes.handle(conversation('conversation/cancel', { messageId: 'q-msg' }));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toMatchObject({ ok: false, status: 'queued' });
    expect(cancels).toEqual([]);
  });

  test('a fire-and-forget message records its turn, so a later cancel by messageId names that turn', async () => {
    const { routes, cancels } = fixture({
      postDetached: (opts) => opts.onTurnEvent?.({ type: 'turn.started', sessionId: 's', turnId: 'turn-bg', messageId: 'user-msg-1' } as unknown as CompanionChatTurnEvent),
    });
    await routes.handle(conversation('conversation', { message: 'bg', messageId: 'bg-msg', conversationId: 'c1', wait: false }));
    const response = await routes.handle(conversation('conversation/cancel', { messageId: 'bg-msg' }));
    expect(response?.status).toBe(200);
    expect(cancels).toEqual([{ sessionId: 'ha-session-1', input: { turnId: 'turn-bg' } }]);
  });
});

describe('streaming disconnect', () => {
  const started = (turnId: string) => ({ type: 'turn.started', sessionId: 's', turnId, messageId: 'user-msg-1' }) as unknown as CompanionChatTurnEvent;

  test('a client that goes away mid-turn cancels its own turn, by id', async () => {
    const entered = Promise.withResolvers<void>();
    const never = new Promise<Reply>(() => {});
    const { routes, cancels } = fixture({ postWait: (_s, _c, _id, opts) => { opts.onTurnEvent?.(started('turn-mine')); entered.resolve(); return never; } });
    const response = await routes.handle(conversation('conversation/stream', { message: 'long', conversationId: 'c1' }));
    const reader = response!.body!.getReader();
    await entered.promise;
    await reader.cancel();
    expect(cancels).toEqual([{ sessionId: 'ha-session-1', input: { turnId: 'turn-mine' } }]);
  });

  test('a client that leaves while its message is queued does not stop the running turn, and cancels its own once it starts', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Reply>();
    let emit: ((event: CompanionChatTurnEvent) => void) | undefined;
    const { routes, cancels } = fixture({ postWait: (_s, _c, _id, opts) => { emit = opts.onTurnEvent; entered.resolve(); return release.promise; } });
    const response = await routes.handle(conversation('conversation/stream', { message: 'queued', conversationId: 'c1' }));
    const reader = response!.body!.getReader();
    await entered.promise;
    await reader.cancel();
    expect(cancels).toEqual([]);
    emit?.(started('turn-late'));
    expect(cancels).toEqual([{ sessionId: 'ha-session-1', input: { turnId: 'turn-late' } }]);
    release.resolve({ messageId: 'user-msg-1', error: 'Turn cancelled' });
  });
});
