import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { WebSocketOutbox } from '../platform/src/platform/daemon/websocket-outbox.js';
import { isSurfaceDeliveryEnabled } from '../platform/src/platform/daemon/surface-policy.js';
import { readResponseSpool } from '../platform/src/platform/daemon/response-spool.js';
import { isPortAvailable } from '../platform/src/platform/daemon/port-check.js';
import { reservedApiPathRoots } from '../platform/src/platform/daemon/http/webui-serving.js';
import { DaemonReceiptStore, type ReceiptStoreIo } from '../platform/src/platform/daemon/receipts.js';
import { deliverOwnerAlert } from '../platform/src/platform/daemon/owner-alert.js';
import { parseLaunchdList } from '../platform/src/platform/daemon/launchd-handover.js';
import { openScopedSessionEventStream } from '../platform/src/platform/daemon/http/session-event-stream.js';
import { tryResolvePaymentReplyFromChannel } from '../platform/src/platform/daemon/payment-reply.js';
import { DaemonSurfaceActionHelper } from '../platform/src/platform/daemon/surface-actions.js';
import { DaemonSurfaceDeliveryHelper } from '../platform/src/platform/daemon/surface-delivery.js';
import { ChannelPluginRegistry } from '../platform/src/platform/channels/plugin-registry.js';
import { ChannelReplyPipeline } from '../platform/src/platform/channels/reply-pipeline.js';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { emitTurnCancel, emitTurnCompleted, emitTurnSubmitted } from '../platform/src/platform/runtime/emitters/turn.js';
import type { ControlPlaneGateway } from '../platform/src/platform/control-plane/index.js';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.js';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.js';
import type { ChannelPolicyDecision } from '../platform/src/platform/channels/index.js';
import type { PendingSurfaceReply } from '../platform/src/platform/daemon/types.js';
import type { PaymentReplyInbox } from '../platform/src/platform/payments/reply-inbox.js';

const directories: string[] = [];
afterEach(() => {
  setSystemTime();
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'goodvibes-daemon-hardening-'));
  directories.push(dir);
  return dir;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('websocket outbox', () => {
  function stalledSocket() {
    const sent: string[] = [];
    const closed: Array<{ code: number; reason: string }> = [];
    return {
      sent,
      closed,
      socket: {
        send: (data: string) => { sent.push(data); },
        getBufferedAmount: () => 64 * 1024 * 1024,
        close: (code: number, reason: string) => { closed.push({ code, reason }); },
      },
    };
  }

  test('a client that never reads is closed once the queued bytes pass the cap, and nothing more is queued', () => {
    const { socket, closed, sent } = stalledSocket();
    const outbox = new WebSocketOutbox(socket, 100);
    outbox.send('a'.repeat(60)); // taken by the drain loop, which then waits on the stalled socket
    outbox.send('b'.repeat(60)); // queued: 60 of 100
    expect(closed).toEqual([]);
    outbox.send('c'.repeat(60)); // would make 120
    expect(closed).toEqual([{ code: 1013, reason: 'WebSocket client is too slow' }]);
    outbox.send('d'.repeat(10));
    expect(closed).toHaveLength(1);
    expect(sent).toEqual([]);
    outbox.close();
  });

  test('a client that stops reading is closed by the stall deadline even though the byte cap is never reached', async () => {
    const { socket, closed } = stalledSocket();
    const closedOnce = new Promise<void>((resolve) => {
      const close = socket.close;
      socket.close = (code: number, reason: string) => { close(code, reason); resolve(); };
    });
    const dropped: number[] = [];
    const outbox = new WebSocketOutbox(socket, 64 * 1024 * 1024, (count) => dropped.push(count), 0);
    outbox.send('a'.repeat(60));
    outbox.send('b'.repeat(60));
    await closedOnce;
    expect(closed).toEqual([{ code: 1013, reason: 'WebSocket client is too slow' }]);
    expect(dropped).toEqual([2]);
    outbox.close();
  });
});

describe('surface delivery policy', () => {
  function configWith(dir: string, enabled?: boolean): ConfigManager {
    const config = new ConfigManager({ configDir: dir });
    if (enabled !== undefined) config.set('surfaces.slack.enabled', enabled);
    return config;
  }

  test('an enabled=false the owner chose beats a token that happens to be present', () => {
    const saved = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    try {
      expect(isSurfaceDeliveryEnabled(configWith(join(scratch(), 'a')), 'slack')).toBe(true);
      expect(isSurfaceDeliveryEnabled(configWith(join(scratch(), 'b'), false), 'slack')).toBe(false);
      expect(isSurfaceDeliveryEnabled(configWith(join(scratch(), 'c'), true), 'slack')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = saved;
    }
  });
});

describe('response spool', () => {
  function bodyOf(chunks: readonly string[]): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }));
  }

  test('a body is read back whole, and one over the byte limit is refused', async () => {
    expect(await readResponseSpool(bodyOf(['hello ', 'world']))).toBe('hello world');
    await expect(readResponseSpool(bodyOf(['12345', '67890']), undefined, 8)).rejects.toThrow('larger than the 8 byte limit');
  });

  test('a refused body leaves no spool directory behind', async () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-response-')).length;
    await expect(readResponseSpool(bodyOf(['1234567890']), undefined, 4)).rejects.toThrow();
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('goodvibes-response-')).length;
    expect(after).toBeLessThanOrEqual(before);
  });
});

describe('port check', () => {
  test('a listening port reports unavailable and a closed one reports available', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect(await isPortAvailable(port, '127.0.0.1')).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortAvailable(port, '127.0.0.1')).toBe(true);
  });
});

describe('web UI reserved paths', () => {
  test('the first segment of every advertised path is reserved, and a templated first segment is not', () => {
    const roots = reservedApiPathRoots(['/status', '/config/credentials', '/{id}/events', 'relative', '']);
    expect(roots).toEqual(['/api', '/config', '/login', '/status', '/task', '/webhook']);
  });
});

describe('daemon receipts', () => {
  function memoryIo(initial: string | null = null) {
    const state = { contents: initial, failWrites: 0, quarantined: [] as string[] };
    const io: ReceiptStoreIo = {
      read: () => state.contents,
      write: (_path, contents) => {
        if (state.failWrites > 0) { state.failWrites -= 1; throw new Error('disk full'); }
        state.contents = contents;
      },
      quarantine: (path) => { state.quarantined.push(path); state.contents = null; return `${path}.aside`; },
    };
    return { state, io };
  }

  test('a receipt is still handed over when it could not be saved as delivered', () => {
    const { state, io } = memoryIo();
    const store = new DaemonReceiptStore('/receipts.json', { io, now: () => 1_000 });
    store.record('updated to 3.3.0');
    state.failWrites = 1;
    const consumed = store.consumeUndelivered();
    expect(consumed.map((receipt) => receipt.text)).toEqual(['updated to 3.3.0']);
    expect(JSON.parse(state.contents!)[0].deliveredAt).toBeUndefined();
  });

  test('a receipt that cannot be saved is kept in memory rather than thrown away', () => {
    const { state, io } = memoryIo();
    const store = new DaemonReceiptStore('/receipts.json', { io, now: () => 1_000 });
    state.failWrites = 1;
    expect(() => store.record('restarted')).not.toThrow();
    expect(store.list().map((receipt) => receipt.text)).toEqual(['restarted']);
  });

  test('an unreadable file is set aside before the next write can erase it', () => {
    const { state, io } = memoryIo('{"torn":');
    const store = new DaemonReceiptStore('/receipts.json', { io, now: () => 1_000 });
    expect(state.quarantined).toEqual(['/receipts.json']);
    store.record('after the crash');
    expect(store.list()).toHaveLength(1);
  });
});

describe('owner alert', () => {
  function binding(id: string, surfaceKind: string): AutomationRouteBinding {
    return { id, surfaceKind, lastSeenAt: id === 'first' ? 2 : 1 } as unknown as AutomationRouteBinding;
  }

  test('a route whose delivery throws does not stop the next route from being tried', async () => {
    const tried: string[] = [];
    const result = await deliverOwnerAlert(
      { listBindings: () => [binding('first', 'slack'), binding('second', 'ntfy')] } as unknown as RouteBindingManager,
      {
        deliverSurfaceNotice: async (route) => {
          tried.push(route!.id);
          if (route!.id === 'first') throw new Error("Cannot read properties of undefined (reading 'responseUrl')");
          return { delivered: true };
        },
      },
      null,
      'the update failed',
    );
    expect(tried).toEqual(['first', 'second']);
    expect(result?.id).toBe('second');
  });
});

describe('launchctl list parsing', () => {
  const listing = [
    'PID\tStatus\tLabel',
    '412\t0\tcom.apple.Finder',
    '-\t78\tcom.example.a-very-long-unrelated-label-that-goes-on-and-on-and-on-past-any-sensible-length',
    '9876543\t-9\tsh.goodvibes.daemon',
    '-\t0\tsh.goodvibes.daemon.helper',
  ].join('\n');

  test('finds the exact label with its pid and ignores near matches', () => {
    expect(parseLaunchdList(listing, 'sh.goodvibes.daemon')).toEqual({ loaded: true, pid: 9876543 });
  });

  test('a loaded job with a dash pid is loaded without a pid, and a missing job is not loaded', () => {
    expect(parseLaunchdList(listing, 'sh.goodvibes.daemon.helper')).toEqual({ loaded: true });
    expect(parseLaunchdList(listing, 'sh.goodvibes.absent')).toEqual({ loaded: false });
  });

  test('a final row without a trailing newline is still read', () => {
    expect(parseLaunchdList('77\t0\tlast.job', 'last.job')).toEqual({ loaded: true, pid: 77 });
  });
});

describe('session event streams', () => {
  test('two readers of one session get distinct gateway client ids', () => {
    const ids: string[] = [];
    const gateway = {
      createEventStream: (_request: Request, options: { clientId?: string }) => { ids.push(options.clientId ?? ''); return new Response(''); },
    } as unknown as ControlPlaneGateway;
    const request = new Request('http://localhost/api/sessions/s1/events');
    openScopedSessionEventStream(gateway, request, { clientPrefix: 'shared-session', sessionId: 's1' });
    openScopedSessionEventStream(gateway, request, { clientPrefix: 'shared-session', sessionId: 's1' });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids.every((id) => id.startsWith('shared-session:s1:'))).toBe(true);
  });
});

describe('payment reply identity check', () => {
  test('an identity lookup that never answers stops waiting once the purchase window is aborted', async () => {
    const abort = new AbortController();
    let verification: Promise<unknown> | undefined;
    const inbox = {
      pending: 1,
      offer: async (_channel: string, _text: string, correlation?: { verifyAccount?: () => Promise<unknown> }) => {
        verification = correlation?.verifyAccount?.();
        await verification?.catch(() => {});
        return { consumed: false, reason: 'no-window' };
      },
    } as unknown as PaymentReplyInbox;
    const decision = { allowed: true, reason: 'allowed', policy: { allowlistUserIds: ['owner'] } } as unknown as ChannelPolicyDecision;
    const outcome = tryResolvePaymentReplyFromChannel(
      {
        surface: 'telegram', userId: 'owner', channelId: 'chat', text: 'yes',
        acquireTelegramAccount: () => new Promise(() => {}),
      } as never,
      decision,
      inbox,
      { read: async () => null, assertCurrent: () => ({ id: 'a', revision: 1 }) } as never,
      { signal: abort.signal },
    );
    await settle();
    abort.abort();
    await outcome;
    await expect(verification).rejects.toThrow('source-unavailable');
  });
});

describe('ntfy chat reply correlation', () => {
  function build() {
    const runtimeBus = new RuntimeEventBus();
    const published: Array<{ topic: string; message: string }> = [];
    const helper = new DaemonSurfaceActionHelper({
      runtimeBus,
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: () => undefined },
    } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
    (helper as unknown as { publishNtfyReply: (topic: string, message: string) => Promise<void> }).publishNtfyReply =
      async (topic, message) => { published.push({ topic, message }); };
    const context = helper.buildSurfaceAdapterContext();
    const queue = (sessionId: string, body: string, messageId: string) =>
      context.queueNtfyChatReply!({ sessionId, topic: 'owner-topic', body, messageId });
    const ctx = (sessionId: string) => ({ sessionId, source: 'test', traceId: `trace-${sessionId}` });
    return { runtimeBus, published, queue, ctx };
  }

  test("another session's identical prompt long after the message is not matched, so its answer stays off the topic", async () => {
    const { runtimeBus, published, queue, ctx } = build();
    setSystemTime(new Date('2026-01-01T10:00:00Z'));
    queue('tui-session', 'yes', 'm1');
    setSystemTime(new Date('2026-01-01T10:05:00Z'));
    emitTurnSubmitted(runtimeBus, ctx('other-session'), { turnId: 't-other', prompt: 'yes', origin: { surface: 'ntfy' } });
    emitTurnCompleted(runtimeBus, ctx('other-session'), { turnId: 't-other', response: 'private answer', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([]);
  });

  test('two waiting messages with the same text are not guessed between', async () => {
    const { runtimeBus, published, queue, ctx } = build();
    queue('tui-session-a', 'yes', 'm1');
    queue('tui-session-b', 'yes', 'm2');
    emitTurnSubmitted(runtimeBus, ctx('runtime-session'), { turnId: 't1', prompt: 'yes', origin: { surface: 'ntfy' } });
    emitTurnCompleted(runtimeBus, ctx('runtime-session'), { turnId: 't1', response: 'answer', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([]);
  });

  test("another session's identical prompt shortly after the message is not matched unless the turn came from ntfy", async () => {
    const { runtimeBus, published, queue, ctx } = build();
    queue('tui-session', 'yes', 'm1');
    emitTurnSubmitted(runtimeBus, ctx('other-session'), { turnId: 't-other', prompt: 'yes', origin: { surface: 'tui' } });
    emitTurnCompleted(runtimeBus, ctx('other-session'), { turnId: 't-other', response: 'private answer', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([]);
  });

  test('an ntfy turn without a message id is still matched shortly after the message', async () => {
    const { runtimeBus, published, queue, ctx } = build();
    queue('tui-session', 'hi', 'm1');
    emitTurnSubmitted(runtimeBus, ctx('runtime-session'), { turnId: 't1', prompt: 'hi', origin: { surface: 'ntfy' } });
    emitTurnCompleted(runtimeBus, ctx('runtime-session'), { turnId: 't1', response: 'hello', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([{ topic: 'owner-topic', message: 'hello' }]);
  });

  test('a turn carrying the ntfy message id is answered on the topic even from another session', async () => {
    const { runtimeBus, published, queue, ctx } = build();
    queue('tui-session', 'yes', 'm1');
    emitTurnSubmitted(runtimeBus, ctx('runtime-session'), { turnId: 't1', prompt: 'yes', origin: { messageId: 'm1' } });
    emitTurnCompleted(runtimeBus, ctx('runtime-session'), { turnId: 't1', response: 'done', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([{ topic: 'owner-topic', message: 'done' }]);
  });

  test('a cancelled turn tells the topic and drops the pending entry', async () => {
    const { runtimeBus, published, queue, ctx } = build();
    queue('tui-session', 'run it', 'm2');
    emitTurnSubmitted(runtimeBus, ctx('tui-session'), { turnId: 't2', prompt: 'run it' });
    emitTurnCancel(runtimeBus, ctx('tui-session'), { turnId: 't2', stopReason: 'cancelled' });
    await settle();
    expect(published).toHaveLength(1);
    expect(published[0]?.message).toContain('cancelled');
    emitTurnCompleted(runtimeBus, ctx('tui-session'), { turnId: 't2', response: 'late', stopReason: 'completed' });
    await settle();
    expect(published).toHaveLength(1);
  });

  test('a matched turn that runs past the ten minute wait still gets its answer', async () => {
    const { runtimeBus, published, queue, ctx } = build();
    setSystemTime(new Date('2026-01-01T10:00:00Z'));
    queue('tui-session', 'long job', 'm3');
    emitTurnSubmitted(runtimeBus, ctx('tui-session'), { turnId: 't3', prompt: 'long job' });
    await settle();
    setSystemTime(new Date('2026-01-01T10:11:00Z'));
    queue('tui-session', 'another', 'm4'); // runs the expiry sweep
    emitTurnCompleted(runtimeBus, ctx('tui-session'), { turnId: 't3', response: 'finished', stopReason: 'completed' });
    await settle();
    expect(published).toEqual([{ topic: 'owner-topic', message: 'finished' }]);
  });
});

describe('ntfy reply token', () => {
  test('a stored secret reference is resolved before it is used as the bearer token', async () => {
    const helper = new DaemonSurfaceActionHelper({
      runtimeBus: new RuntimeEventBus(),
      serviceRegistry: { resolveSecret: async () => null },
      configManager: { get: (key: string) => (key === 'surfaces.ntfy.token' ? 'goodvibes://secrets/goodvibes/NTFY_TOKEN' : undefined) },
      secretsManager: { get: async (key: string) => (key === 'NTFY_TOKEN' ? 'real-token' : null) },
    } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
    const token = await (helper as unknown as { resolveNtfyToken(): Promise<string | null> }).resolveNtfyToken();
    expect(token).toBe('real-token');
  });
});

describe('surface reply completion', () => {
  function telegramBinding(): AutomationRouteBinding {
    return {
      id: 'route-1', kind: 'conversation', surfaceKind: 'telegram', surfaceId: 'telegram', externalId: 'chat-1',
      channelId: 'chat-1', lastSeenAt: 1, createdAt: 1, updatedAt: 1, metadata: {},
    } as unknown as AutomationRouteBinding;
  }

  function build(options: { readonly bindingMetadata?: boolean } = {}) {
    const binding = options.bindingMetadata === false
      ? ({ ...telegramBinding(), surfaceKind: 'slack', metadata: undefined } as unknown as AutomationRouteBinding)
      : telegramBinding();
    const routeBindings = { getBinding: () => binding, listBindings: () => [binding] } as unknown as RouteBindingManager;
    const delivered: string[] = [];
    const channelPlugins = new ChannelPluginRegistry();
    for (const surface of ['telegram', 'slack'] as const) {
      channelPlugins.register({
        id: `${surface}-test`, surface, displayName: surface, capabilities: ['egress'],
        deliverReply: async (_pending, message) => { delivered.push(message); },
        deliverProgress: async () => {},
      });
    }
    const pipeline = new ChannelReplyPipeline({ channelPlugins, routeBindings });
    const pendingSurfaceReplies = new Map<string, PendingSurfaceReply>();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stored: string[] = [];
    const helper = new DaemonSurfaceDeliveryHelper({
      pendingSurfaceReplies,
      channelReplyPipeline: pipeline,
      configManager: { get: () => undefined },
      secretsManager: { get: async () => null, getGlobalHome: () => null },
      serviceRegistry: { resolveSecret: async () => null },
      agentManager: { getStatus: () => null },
      sessionBroker: { completeAgent: async (_session: string, _agent: string, body: string) => { stored.push(body); await gate; } },
      routeBindings,
      channelPlugins,
      authToken: () => null,
      surfaceDeliveryEnabled: () => true,
    } as never);
    const pending: PendingSurfaceReply = {
      agentId: 'agent-1', surfaceKind: 'telegram', task: 'work', createdAt: 1, sessionId: 'session-1', routeId: 'route-1',
    };
    pendingSurfaceReplies.set('agent-1', pending);
    pipeline.trackPending(pending);
    return { helper, pipeline, delivered, stored, release, binding };
  }

  test('a repeated completion while the first is still in flight neither stores nor delivers the answer twice', async () => {
    const { helper, pipeline, delivered, stored, release } = build();
    try {
      const first = helper.completeSurfaceReplyFromSurface({ agentId: 'agent-1', sessionId: 'session-1', body: 'the answer' });
      const second = await helper.completeSurfaceReplyFromSurface({ agentId: 'agent-1', sessionId: 'session-1', body: 'the answer' });
      expect(second).toBe(false);
      release();
      expect(await first).toBe(true);
      expect(stored).toEqual(['the answer']);
      expect(delivered).toHaveLength(1);
    } finally {
      pipeline.dispose();
    }
  });

  test('a notice to a binding saved without metadata is refused by name instead of throwing', async () => {
    const { helper, pipeline, binding } = build({ bindingMetadata: false });
    try {
      await expect(helper.deliverSurfaceNotice(binding, 'hello')).resolves.toHaveProperty('delivered');
    } finally {
      pipeline.dispose();
    }
  });
});

describe('model and batch routes need an admin to change anything', () => {
  function buildRouter(requireAdminCalls: string[]) {
    const bus = new RuntimeEventBus();
    const configWrites: string[] = [];
    const context = {
      configManager: { get: () => undefined, set: (key: string) => { configWrites.push(key); } },
      providerRegistry: {
        listModels: () => [],
        getCurrentModel: () => { throw new Error('no current model'); },
        getConfiguredProviderIds: () => [],
        describeRuntime: async () => null,
      },
      runtimeBus: bus,
      secretsManager: { get: async () => null },
      batchManager: { createJob: () => { throw new Error('a batch must not be created'); }, dispose: () => {} },
      controlPlaneGateway: {},
      requireAdmin: (req: Request) => {
        requireAdminCalls.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ error: 'Admin role required' }, { status: 403 });
      },
      authToken: () => null,
      checkAuth: () => true,
      companionChatManager: null,
    };
    return { router: new DaemonHttpRouter(context as never), configWrites };
  }

  test('PATCH /api/models/current and POST /api/batch/jobs are refused for a non-admin, and a model read is not', async () => {
    const calls: string[] = [];
    const { router, configWrites } = buildRouter(calls);
    try {
      const patch = await router.dispatchApiRoutes(new Request('http://localhost/api/models/current', {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'x:y' }),
      }));
      expect(patch?.status).toBe(403);
      const batch = await router.dispatchApiRoutes(new Request('http://localhost/api/batch/jobs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
      }));
      expect(batch?.status).toBe(403);
      expect(configWrites).toEqual([]);
      expect(calls).toEqual(['PATCH /api/models/current', 'POST /api/batch/jobs']);

      const read = await router.dispatchApiRoutes(new Request('http://localhost/api/models', { method: 'GET' }));
      expect(read?.status).toBe(200);
      expect(calls).toHaveLength(2);
    } finally {
      router.dispose();
    }
  });
});
