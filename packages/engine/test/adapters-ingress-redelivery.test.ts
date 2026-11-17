/**
 * What the webhook adapters do when a provider redelivers, a sender is refused,
 * or a caller supplies more than it should: no second run of a message already
 * handled, a retry for one whose handling failed, an acknowledgement (never a
 * failure status) for an ordinary refusal so the provider does not stall its
 * queue redelivering it, and no stale or foreign callback or session.
 *
 * The adapters and their shared delivery claim are real; the daemon context
 * around them only records what the adapter asked it to do.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.ts';
import { handleTelegramSurfaceWebhook } from '../platform/src/platform/adapters/telegram/index.ts';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';

type Call = { kind: string; input: unknown };

afterEach(() => { surfaceInboundDedup.clear(); });

function sharedContext(config: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const bindings = new Map<string, { id: string; metadata: Record<string, unknown> } & Record<string, unknown>>();
  let agents = 0;
  const context = {
    serviceRegistry: { resolveSecret: async () => null },
    configManager: { get: (key: string) => config[key] },
    // Merges metadata over the previous call's, as the real binding manager does.
    routeBindings: {
      upsertBinding: async (input: { surfaceKind: string; externalId: string; metadata?: Record<string, unknown> }) => {
        calls.push({ kind: 'upsertBinding', input });
        const key = `${input.surfaceKind}:${input.externalId}`;
        const previous = bindings.get(key);
        const binding = { ...input, id: previous?.id ?? `binding-${bindings.size + 1}`, metadata: { ...(previous?.metadata ?? {}), ...(input.metadata ?? {}) } };
        bindings.set(key, binding);
        return binding;
      },
    },
    sessionBroker: {
      getSession: () => null,
      submitMessage: async (input: unknown) => {
        calls.push({ kind: 'submitMessage', input });
        return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
      },
      bindAgent: async () => undefined,
    },
    authorizeSurfaceIngress: async (input: unknown) => { calls.push({ kind: 'authorizeSurfaceIngress', input }); return { allowed: true }; },
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    performInteractiveSurfaceAction: async () => 'ok',
    trySpawnAgent: (input: unknown) => { calls.push({ kind: 'trySpawnAgent', input }); return { id: `agent-${++agents}` }; },
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: (body: string, secret: string) => `signed:${secret}:${body.length}`,
    queueWebhookReply: (input: unknown) => { calls.push({ kind: 'queueWebhookReply', input }); },
    ...overrides,
  };
  return { calls, bindings, context: context as never };
}

const spawns = (calls: Call[]) => calls.filter((call) => call.kind === 'trySpawnAgent').length;

describe('whatsapp', () => {
  const config = { 'surfaces.whatsapp.provider': 'bridge', 'surfaces.whatsapp.signingSecret': 'wa-token', 'surfaces.whatsapp.phoneNumberId': 'phone-1' };
  const post = (context: never, messages: unknown[]) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
    method: 'POST',
    headers: { 'x-goodvibes-whatsapp-token': 'wa-token' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages } }] }] }),
  }), context);

  test('a refused sender in the same payload does not fail it, and a redelivery does not run the allowed message again', async () => {
    const { context, calls } = sharedContext(config, {
      authorizeSurfaceIngress: async (input: { userId?: string }) => (input.userId === '222' ? { allowed: false, reason: 'user-not-allowlisted' } : { allowed: true }),
    });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'hello' } }, { id: 'wamid.B', from: '222', text: { body: 'hello' } }];
    const first = await post(context, messages);
    expect(first.status).toBe(200);
    expect(spawns(calls)).toBe(1);
    const second = await post(context, messages);
    expect(second.status).toBe(200);
    expect(spawns(calls)).toBe(1);
  });

  test('a message whose handling failed is run again on redelivery while the one already handled is not', async () => {
    let spawnCount = 0;
    const { context, calls } = sharedContext(config, {
      // The second spawn overall (message B on first delivery) is refused.
      trySpawnAgent: (input: unknown) => {
        calls.push({ kind: 'trySpawnAgent', input });
        return ++spawnCount === 2 ? Response.json({ error: 'busy' }, { status: 503 }) : { id: `agent-${spawnCount}` };
      },
    });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'one' } }, { id: 'wamid.B', from: '111', text: { body: 'two' } }];
    const first = await post(context, messages);
    expect(first.status).toBe(503);
    expect(spawns(calls)).toBe(2);
    const second = await post(context, messages);
    expect(second.status).toBe(200);
    expect(spawns(calls)).toBe(3);
    const third = await post(context, messages);
    expect(third.status).toBe(200);
    expect(spawns(calls)).toBe(3);
  });
});

test('telegram: a group message the policy refuses is acknowledged, not failed, and starts nothing', async () => {
  const config = { 'surfaces.telegram.webhookSecret': 'tg-secret', 'surfaces.telegram.botUsername': 'goodvibes_bot' };
  const { context, calls } = sharedContext(config, { authorizeSurfaceIngress: async () => ({ allowed: false, reason: 'mention-required' }) });
  const response = await handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 5, type: 'group' }, from: { id: 9 }, text: 'lunch anyone?' } }),
  }), context, {});
  expect(response.status).toBe(200);
  expect(spawns(calls)).toBe(0);
});

describe('telephony', () => {
  const config = { 'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555' };
  const send = (context: never, body: Record<string, unknown>) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' }, body: JSON.stringify(body),
  }), context);

  test('a refused caller is acknowledged, not failed', async () => {
    const { context, calls } = sharedContext(config, { authorizeSurfaceIngress: async () => ({ allowed: false, reason: 'user-not-allowlisted' }) });
    const response = await send(context, { from: '+1999', text: 'hi' });
    expect(response.status).toBe(200);
    expect(calls.filter((call) => call.kind === 'submitMessage')).toHaveLength(0);
  });

  test('each spoken turn of one call is its own message; a redelivered text message is run once', async () => {
    const { calls, context } = sharedContext(config);
    await send(context, { From: '+1999', CallSid: 'CA1', SpeechResult: 'first turn' });
    await send(context, { From: '+1999', CallSid: 'CA1', SpeechResult: 'second turn' });
    await send(context, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    await send(context, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    const submitted = calls.filter((call) => call.kind === 'submitMessage');
    expect(submitted).toHaveLength(3);
    expect(submitted.map((call) => (call.input as { providerMessageId?: string }).providerMessageId)).toEqual([undefined, undefined, 'SM1']);
  });
});

describe('generic webhook', () => {
  const config = { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' };
  const post = (context: never, body: Record<string, unknown>) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' }, body: JSON.stringify(body),
  }), context);

  test('a call without a callback does not inherit the callback, correlation or signature of an earlier call', async () => {
    const { context, bindings } = sharedContext(config);
    await post(context, { task: 'X', callbackUrl: 'https://a.example.com/hook', correlationId: 'c1', callbackSignature: 'shared-secret' });
    expect(bindings.get('webhook:webhook')!.metadata.callbackUrl).toBe('https://a.example.com/hook');
    await post(context, { task: 'Y' });
    const afterSecond = bindings.get('webhook:webhook')!;
    expect(afterSecond.metadata.callbackUrl).toBeUndefined();
    expect(afterSecond.metadata.correlationId).toBeUndefined();
    expect(afterSecond.metadata.callbackSignature).toBeUndefined();
  });

  test('a callbackUrl that is not a string is refused rather than carried on the binding', async () => {
    const { context, bindings } = sharedContext(config);
    const response = await post(context, { task: 'X', callbackUrl: { href: 'http://169.254.169.254' } });
    expect(response.status).toBe(400);
    expect(bindings.size).toBe(0);
  });

  test('platform markers in caller metadata are dropped, and a session from another surface cannot be entered', async () => {
    const { context, calls } = sharedContext(config, {
      sessionBroker: {
        getSession: (id: string) => (id === 'telegram-session' ? { id, surfaceKinds: ['telegram'] } : null),
        submitMessage: async (input: unknown) => {
          calls.push({ kind: 'submitMessage', input });
          return { mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: 'input-1' } };
        },
        bindAgent: async () => undefined,
      },
    });
    await post(context, { task: 'X', metadata: { 'goodvibes.workAuthorized': true, note: 'kept' } });
    const submitted = calls.find((call) => call.kind === 'submitMessage')!.input as { metadata: Record<string, unknown> };
    expect(submitted.metadata['goodvibes.workAuthorized']).toBeUndefined();
    const foreign = await post(context, { task: 'X', sessionId: 'telegram-session' });
    expect(foreign.status).toBe(403);
    expect(calls.filter((call) => call.kind === 'submitMessage')).toHaveLength(1);
  });
});
