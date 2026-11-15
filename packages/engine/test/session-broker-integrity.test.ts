/**
 * Shared session broker integrity: a failed boot write is retried, concurrent
 * creators of one session or one channel route converge on a single record, a
 * refused follow-up start is reported on its row, and records are never
 * brought back or invented for sessions the broker does not hold.
 */
import { describe, expect, test } from 'bun:test';
import type { RouteBindingManager } from '../platform/src/platform/channels/index.ts';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.ts';
import { SharedSessionBroker } from '../platform/src/platform/control-plane/session-broker.ts';
import { recordSharedSessionInput, moveSharedSessionInput } from '../platform/src/platform/control-plane/session-broker-inputs.ts';
import { createNativeInboundSourceOwner, sameNativeInboundSourceRef, type NativeInboundSourceRef } from '../platform/src/platform/control-plane/native-inbound-source.ts';
import type { DelegatedSessionInputBinding } from '../platform/src/platform/control-plane/session-broker-delegated.ts';
import type { SharedSessionInputRecord } from '../platform/src/platform/control-plane/session-intents.ts';
import type { SharedSessionStoreSnapshot } from '../platform/src/platform/control-plane/session-broker-helpers.ts';
import type { SharedSessionParticipant, SharedSessionRecord } from '../platform/src/platform/control-plane/session-types.ts';
import { sessionsActive } from '../platform/src/platform/runtime/metrics.ts';
import { PersistentStore } from '../platform/src/platform/state/persistent-store.ts';
import { trackDisposables } from './_helpers/disposables.ts';
import { RuntimeEventBus, createEventEnvelope } from './_helpers/runtime-seam.ts';

const disposables = trackDisposables();

type BrokerConfig = ConstructorParameters<typeof SharedSessionBroker>[0];

function memoryStore(): PersistentStore<SharedSessionStoreSnapshot> {
  return new PersistentStore<SharedSessionStoreSnapshot>(':memory:');
}

function makeBroker(options: { store?: PersistentStore<SharedSessionStoreSnapshot>; binding?: AutomationRouteBinding } = {}) {
  const events: Array<{ event: string; payload: unknown }> = [];
  const binding = options.binding;
  const routeBindings = {
    start: async () => {},
    getBinding: () => binding ?? null,
    resolve: () => binding ?? null,
    patchBinding: async (_id: string, patch: { sessionId?: string }) => {
      if (binding && patch.sessionId !== undefined) (binding as { sessionId?: string }).sessionId = patch.sessionId;
      return binding ?? null;
    },
  } as unknown as RouteBindingManager;
  const broker = disposables.add(new SharedSessionBroker({
    store: options.store ?? memoryStore(),
    routeBindings,
    agentStatusProvider: { getStatus: () => null },
    messageSender: { send: () => false },
  } as BrokerConfig));
  broker.setEventPublisher((_event, payload) => { events.push(payload as { event: string; payload: unknown }); });
  return { broker, events };
}

function participant(surfaceId: string): SharedSessionParticipant {
  return { surfaceKind: 'tui', surfaceId, lastSeenAt: 1 };
}

describe('start after a failed first write', () => {
  test('the next start() loads again instead of reporting a broker that never finished starting', async () => {
    const store = memoryStore();
    let loads = 0;
    let persists = 0;
    const load = store.load.bind(store);
    store.load = async () => { loads += 1; return load(); };
    const persist = store.persist.bind(store);
    store.persist = async (data, options) => {
      persists += 1;
      if (persists === 1) throw new Error('disk full');
      return persist(data, options);
    };
    const { broker } = makeBroker({ store });
    await expect(broker.start()).rejects.toThrow('disk full');
    await broker.start();
    expect(loads).toBe(2);
    await broker.start();
    expect(loads).toBe(2);
  });
});

describe('concurrent creators of one session', () => {
  test('two registers for one new id create it once and keep both participants', async () => {
    const { broker, events } = makeBroker();
    await Promise.all([
      broker.register({ sessionId: 'shared-1', participant: participant('surface-a') }),
      broker.register({ sessionId: 'shared-1', participant: participant('surface-b') }),
    ]);
    expect(events.filter((entry) => entry.event === 'session-created')).toHaveLength(1);
    const record = broker.getSession('shared-1') as SharedSessionRecord;
    expect(record.participants.map((entry) => entry.surfaceId).sort()).toEqual(['surface-a', 'surface-b']);
  });

  test('createSession for an id that already exists returns that session untouched', async () => {
    const { broker, events } = makeBroker();
    await broker.createSession({ id: 'kept' });
    await broker.appendSystemMessage('kept', 'earlier note');
    const again = await broker.createSession({ id: 'kept' });
    expect(again.messageCount).toBe(1);
    expect(broker.getMessages('kept')).toHaveLength(1);
    expect(events.filter((entry) => entry.event === 'session-created')).toHaveLength(1);
  });

  test('two messages for a brand-new channel route land in one session', async () => {
    const binding = { id: 'route-1', surfaceKind: 'slack', surfaceId: 'slack-1', externalId: 'chat-1', sessionPolicy: 'create-or-bind', metadata: {} } as unknown as AutomationRouteBinding;
    const { broker } = makeBroker({ binding });
    const message = (body: string) => ({ routeId: 'route-1', surfaceKind: 'slack' as const, surfaceId: 'slack-1', externalId: 'chat-1', body });
    await Promise.all([broker.submitMessage(message('first')), broker.submitMessage(message('second'))]);
    expect(broker.listSessions()).toHaveLength(1);
    expect(broker.getMessages(broker.listSessions()[0]!.id).map((entry) => entry.body)).toEqual(['first', 'second']);
  });
});

describe('change subscription', () => {
  test('a subscriber hears a new session and a new message, and nothing after unsubscribing', async () => {
    const { broker } = makeBroker();
    let heard = 0;
    const off = broker.subscribe(() => { heard += 1; });
    await broker.createSession({ id: 'watched' });
    const afterCreate = heard;
    expect(afterCreate).toBeGreaterThan(0);
    await broker.appendSystemMessage('watched', 'hello');
    expect(heard).toBeGreaterThan(afterCreate);
    off();
    const settled = heard;
    await broker.appendSystemMessage('watched', 'unheard');
    expect(heard).toBe(settled);
  });
});

describe('workspace swap intake hold', () => {
  test('a message arriving during a swap is refused as retryable and recorded nowhere, then accepted once the swap ends', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'held' });
    let swapping = true;
    broker.setIntakeHold(() => swapping);
    const refusal = await broker.submitMessage({ sessionId: 'held', surfaceKind: 'service', surfaceId: 'service-1', body: 'during the swap' }).then(() => null, (error: unknown) => error as { code?: string; status?: number; message: string });
    expect(refusal?.code).toBe('WORKSPACE_BUSY');
    expect(refusal?.status).toBe(409);
    expect(refusal?.message).toContain('Retry');
    expect(broker.getMessages('held')).toEqual([]);
    expect(broker.getInputs('held')).toEqual([]);
    swapping = false;
    await broker.submitMessage({ sessionId: 'held', surfaceKind: 'service', surfaceId: 'service-1', body: 'after the swap' });
    expect(broker.getMessages('held').map((entry) => entry.body)).toEqual(['after the swap']);
  });
});

describe('steer and follow-up name an existing session', () => {
  const refusalOf = (run: () => Promise<unknown>) => run().then(() => null, (error: unknown) => error as { code?: string; status?: number });

  test('an id nobody holds is a 404 and creates nothing, for steer and for follow-up', async () => {
    const { broker } = makeBroker();
    const message = { sessionId: 'nobody', surfaceKind: 'service' as const, surfaceId: 'service-1', body: 'hello?' };
    const steer = await refusalOf(() => broker.steerMessage({ ...message, allowSpawnFallback: true }));
    const followUp = await refusalOf(() => broker.followUpMessage(message));
    expect(steer).toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 });
    expect(followUp).toMatchObject({ code: 'SESSION_NOT_FOUND', status: 404 });
    expect(broker.listSessions()).toEqual([]);
  });

  test('a channel route with a binding still creates its own session on a follow-up', async () => {
    const binding = { id: 'route-2', surfaceKind: 'slack', surfaceId: 'slack-1', externalId: 'chat-2', sessionPolicy: 'create-or-bind', metadata: {} } as unknown as AutomationRouteBinding;
    const { broker } = makeBroker({ binding });
    await broker.followUpMessage({ routeId: 'route-2', surfaceKind: 'slack', surfaceId: 'slack-1', externalId: 'chat-2', body: 'first' });
    expect(broker.listSessions()).toHaveLength(1);
  });
});

describe('provider message idempotency', () => {
  const binding = () => ({ id: 'route-p', surfaceKind: 'telegram', surfaceId: 'bot-1', externalId: 'chat-1', sessionPolicy: 'create-or-bind', metadata: {} }) as unknown as AutomationRouteBinding;
  const message = (providerMessageId: string | undefined, body = 'hello') => ({
    routeId: 'route-p', surfaceKind: 'telegram' as const, surfaceId: 'bot-1', externalId: 'chat-1', body,
    ...(providerMessageId ? { providerMessageId } : {}),
  });

  test('a redelivery after a restart is answered from the earlier submission and stores nothing new', async () => {
    const store = memoryStore();
    const first = makeBroker({ store, binding: binding() }).broker;
    const original = await first.submitMessage(message('update-7'));
    await first.bindAgent(original.session.id, 'agent-1', original.input.id);
    await first.completeAgent(original.session.id, 'agent-1', 'answered');
    await first.stop();

    const restarted = makeBroker({ store, binding: binding() }).broker;
    const repeat = await restarted.submitMessage(message('update-7'));
    expect(repeat.duplicate).toBe(true);
    expect(repeat.mode).toBe('continued-live');
    expect(repeat.input.id).toBe(original.input.id);
    expect(restarted.getMessages(original.session.id).filter((entry) => entry.role === 'user')).toHaveLength(1);
    expect(restarted.getInputs(original.session.id)).toHaveLength(1);
  });

  test('a message whose first attempt never reached a runner is processed again', async () => {
    const { broker } = makeBroker({ binding: binding() });
    const first = await broker.submitMessage(message('update-8'));
    expect(first.input.state).toBe('queued');
    const retry = await broker.submitMessage(message('update-8'));
    expect(retry.duplicate).toBeUndefined();
    expect(retry.input.id).not.toBe(first.input.id);
  });

  test('a different provider id, or none, is never collapsed into an earlier message', async () => {
    const { broker } = makeBroker({ binding: binding() });
    const first = await broker.submitMessage(message('update-9'));
    await broker.bindAgent(first.session.id, 'agent-1', first.input.id);
    expect((await broker.submitMessage(message('update-10'))).duplicate).toBeUndefined();
    expect((await broker.submitMessage(message(undefined))).duplicate).toBeUndefined();
    expect((await broker.submitMessage(message(undefined))).duplicate).toBeUndefined();
  });
});

describe('follow-up continuation', () => {
  test('a refused start fails the follow-up with the reason instead of leaving it queued', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'followed' });
    broker.setContinuationRunner(() => { throw new Error('agent fleet is full'); });
    const queued = await broker.followUpMessage({ sessionId: 'followed', surfaceKind: 'service', surfaceId: 'service-1', body: 'and then?' });
    expect(queued.input.state).toBe('queued');
    await broker.completeAgent('followed', 'agent-1', 'done');
    const row = broker.getInputs('followed').find((entry) => entry.id === queued.input.id)!;
    expect(row.state).toBe('failed');
    expect(row.error).toContain('agent fleet is full');
  });

  test('the prompt carries a bounded tail of the transcript, not all of it', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'long' });
    for (let index = 0; index < 150; index += 1) await broker.appendSystemMessage('long', `note-${index}`);
    const submission = await broker.submitMessage({ sessionId: 'long', surfaceKind: 'service', surfaceId: 'service-1', body: 'next question' });
    expect(submission.task).toContain('note-149');
    expect(submission.task).not.toContain('note-0\n');
    expect(submission.task).not.toContain('note-49\n');
    expect((submission.task ?? '').split('System: note-').length - 1).toBeLessThanOrEqual(100);
    expect(broker.getMessages('long', 500).length).toBe(151);
  });
});

describe('messages for sessions the broker does not hold', () => {
  test('a system message for an unknown id is refused and leaves no bucket behind', async () => {
    const { broker } = makeBroker();
    const before = broker.retainedRecordCount();
    expect(await broker.appendSystemMessage('ghost', 'hello')).toBeNull();
    expect(await broker.appendCompanionMessage('ghost', { messageId: 'm1', body: 'hi', timestamp: 1, source: 'test' })).toBeNull();
    expect(broker.getMessages('ghost')).toEqual([]);
    expect(broker.retainedRecordCount()).toBe(before);
  });
});

describe('sessions.active gauge', () => {
  test('counts only active sessions and drops when one is closed', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'g1' });
    await broker.createSession({ id: 'g2' });
    expect(sessionsActive.value()).toBe(2);
    await broker.closeSession('g1');
    expect(sessionsActive.value()).toBe(1);
    await broker.reopenSession('g1');
    expect(sessionsActive.value()).toBe(2);
  });
});

describe('deleting a closed session that is still live elsewhere', () => {
  test('is refused while the hosted engine vouches for it', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'hosted-1' });
    await broker.closeSession('hosted-1');
    broker.setExternalLivenessProbe(() => true);
    expect(await broker.deleteSession('hosted-1')).toBe('active');
    expect(broker.getSession('hosted-1')).not.toBeNull();
    broker.setExternalLivenessProbe(() => false);
    expect(await broker.deleteSession('hosted-1')).toBe('deleted');
  });
});

describe('input retention', () => {
  test('a row still waiting for an answer is never the one dropped at the cap', () => {
    const sessions = new Map<string, SharedSessionRecord>();
    const inputs = new Map<string, SharedSessionInputRecord[]>();
    sessions.set('s', { id: 's', pendingInputCount: 0 } as SharedSessionRecord);
    const store = { sessions, inputs };
    const record = (body: string) => recordSharedSessionInput(store, { sessionId: 's', intent: 'submit', message: { sessionId: 's', surfaceKind: 'service', surfaceId: 'service-1', body }, maxPersistedInputs: 3 });
    const waiting = record('still waiting');
    const done1 = record('done 1');
    const done2 = record('done 2');
    moveSharedSessionInput(store, 's', done1.id, 'completed');
    moveSharedSessionInput(store, 's', done2.id, 'completed');
    record('newest');
    const bodies = (inputs.get('s') ?? []).map((entry) => entry.body);
    expect(bodies).toContain(waiting.body);
    expect(bodies).toContain('newest');
    expect(bodies).toHaveLength(3);
  });
});

describe('delegated completion', () => {
  test('a failed durable write leaves the row queued so the same completion can be retried', async () => {
    const store = memoryStore();
    let failDurable = false;
    const persist = store.persist.bind(store);
    store.persist = async (data, options) => {
      if (failDurable && options?.durable) throw new Error('write failed');
      return persist(data, options);
    };
    const { broker } = makeBroker({ store });
    await broker.createSession({ id: 'delegated' });
    const lifetime = new AbortController();
    const owner = disposables.add(createNativeInboundSourceOwner({
      origin: { kind: 'external-original', accountId: 'telegram', accountRevision: 'a1', routeId: 'chat-1', routeRevision: 'r1' },
      lifetime: lifetime.signal, assertCurrent: () => {},
      readBrokerInput: (target) => broker.getInputs(target.sessionId).find((row) => row.id === target.inputId) ?? null,
    }));
    const handle = owner.producer.capture(() => ({ text: 'private text', unsupportedSources: [] }), lifetime.signal);
    let ref: NativeInboundSourceRef | undefined;
    const bind = (row: SharedSessionInputRecord): DelegatedSessionInputBinding => {
      const bound = owner.producer.bind(handle, { sessionId: row.sessionId, inputId: row.id });
      ref = bound;
      return { ref: bound, assertCurrent: () => {
        const current = owner.resolver.reference(bound);
        if (!current || !sameNativeInboundSourceRef(current, bound)) throw new Error('Source is no longer current');
      } };
    };
    const delegated = await broker.submitDelegatedMessage({ sessionId: 'delegated', surfaceKind: 'telegram', surfaceId: 'bot', externalId: 'chat-1', userId: 'u', body: '[held]' }, bind);
    const receipt = { ref: ref!, disposition: 'transferred' as const, requestId: ref!.requestId };
    failDurable = true;
    await expect(delegated.complete(receipt)).rejects.toThrow('write failed');
    expect(broker.getInputs('delegated')[0]!.state).toBe('queued');
    failDurable = false;
    const completed = await delegated.complete(receipt);
    expect(completed.state).toBe('completed');
  });
});

describe('agent completion racing a delete', () => {
  test('a session deleted while its completion is being written is not brought back', async () => {
    const store = memoryStore();
    let gate: Promise<void> | null = null;
    let writesWaiting = 0;
    const persist = store.persist.bind(store);
    store.persist = async (data, options) => {
      if (gate) {
        writesWaiting += 1;
        await gate;
      }
      return persist(data, options);
    };
    const { broker } = makeBroker({ store });
    await broker.createSession({ id: 'racing' });
    await broker.closeSession('racing');

    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const completion = broker.completeAgent('racing', 'agent-1', 'late answer');
    while (writesWaiting === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const deletion = broker.deleteSession('racing');
    release();
    gate = null;

    expect(await deletion).toBe('deleted');
    expect(await completion).toBeNull();
    expect(broker.getSession('racing')).toBeNull();
  });
});

describe('agent completion arriving over the runtime bus', () => {
  const completed = (agentId: string) => createEventEnvelope('AGENT_COMPLETED', {
    type: 'AGENT_COMPLETED' as const, agentId, durationMs: 0, output: 'the answer', toolCallsMade: 0,
  }, { sessionId: 'bus-session', traceId: 'trace', source: 'session-broker-integrity.test' });

  test('stores the answer once for the resolved session and stops after unsubscribe', async () => {
    const { broker } = makeBroker();
    await broker.createSession({ id: 'bus-session' });
    const bus = new RuntimeEventBus();
    const detach = broker.attachRuntimeBus(bus, (agentId) => (agentId === 'agent-1' ? 'bus-session' : null));
    bus.emit('agents', completed('agent-1'));
    bus.emit('agents', completed('someone-else'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(broker.getMessages('bus-session').map((entry) => entry.body)).toEqual(['the answer']);
    detach();
    bus.emit('agents', completed('agent-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(broker.getMessages('bus-session')).toHaveLength(1);
  });

  test('a completion for a session that is gone does not throw into the bus or recreate it', async () => {
    const { broker } = makeBroker();
    const bus = new RuntimeEventBus();
    broker.attachRuntimeBus(bus, () => 'deleted-session');
    bus.emit('agents', completed('agent-1'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(broker.getSession('deleted-session')).toBeNull();
    expect(broker.getMessages('deleted-session')).toEqual([]);
  });
});
