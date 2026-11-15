/**
 * What the webhook adapters answer when a provider redelivers, a message is
 * refused or unreadable, or a caller supplies more than it should: no repeated
 * work, no failure status for an ordinary refusal, no stale or foreign callback.
 */
import { describe, expect, test } from 'bun:test';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.js';
import { handleSignalSurfaceWebhook } from '../platform/src/platform/adapters/signal/index.js';
import { handleSlackSurfacePayload } from '../platform/src/platform/adapters/slack/index.js';
import { handleTelegramSurfaceWebhook } from '../platform/src/platform/adapters/telegram/index.js';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.js';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.js';

type Call = { kind: string; input: unknown };

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

  test('a refused sender in the same payload does not fail it, so Meta has no reason to redeliver the allowed one', async () => {
    const { context, calls } = sharedContext(config, {
      authorizeSurfaceIngress: async (input: { userId?: string }) => (input.userId === '222' ? { allowed: false, reason: 'user-not-allowlisted' } : { allowed: true }),
    });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'hello' } }, { id: 'wamid.B', from: '222', text: { body: 'hello' } }];
    const first = await post(context, messages);
    expect(first.status).toBe(200);
    expect(spawns(calls)).toBe(1);
    // Redelivered anyway: the handled message is not run again.
    const second = await post(context, messages);
    expect(second.status).toBe(200);
    expect(spawns(calls)).toBe(1);
  });

  test('a message whose handling failed is retried on redelivery while the one already handled is not', async () => {
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
  });

  test('a caption nested under the media object is the task; media without one is reported as unsupported', async () => {
    const { context, calls } = sharedContext(config);
    const captioned = await post(context, [{ id: 'wamid.1', from: '111', image: { id: 'm1', caption: 'what is in this build log' } }]);
    expect(captioned.status).toBe(200);
    expect(spawns(calls)).toBe(1);
    const bare = await post(context, [{ id: 'wamid.2', from: '111', voice: { id: 'm2' } }]);
    expect(await bare.json()).toMatchObject({ outcome: 'ignored', reason: 'unsupported-attachment', attachment: 'voice' });
    expect(spawns(calls)).toBe(1);
  });
});

describe('a message that is only an attachment', () => {
  const whatsapp = { 'surfaces.whatsapp.provider': 'bridge', 'surfaces.whatsapp.signingSecret': 'wa-token', 'surfaces.whatsapp.phoneNumberId': 'phone-1' };
  const postWhatsApp = (context: never) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
    method: 'POST', headers: { 'x-goodvibes-whatsapp-token': 'wa-token' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ id: 'wamid.9', from: '111', voice: { id: 'm9' } }] } }] }] }),
  }), context);
  const postSignal = (context: never, extra: Record<string, unknown>) => handleSignalSurfaceWebhook(new Request('http://localhost/signal', {
    method: 'POST', headers: { 'x-goodvibes-signal-token': 'sig-token' },
    body: JSON.stringify({ recipient: '+1555', messageId: `m-${JSON.stringify(extra).length}`, attachments: [{ id: 'a1' }], ...extra }),
  }), context);

  test('the sender of a one-to-one message is told attachments cannot be read; the answer is reported as sent', async () => {
    const notices: string[] = [];
    const { context } = sharedContext(whatsapp, { deliverSurfaceNotice: async (_binding: unknown, text: string) => { notices.push(text); return { delivered: true }; } });
    expect(await (await postWhatsApp(context)).json()).toMatchObject({ reason: 'unsupported-attachment', attachment: 'voice', notified: true });
    expect(notices).toEqual(['I cannot read voices yet. Send the request as text.']);
  });

  test('a failed or refused notice does not fail the message, and is reported as not sent', async () => {
    const { context } = sharedContext(whatsapp, { deliverSurfaceNotice: async () => { throw new Error('channel down'); } });
    const response = await postWhatsApp(context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ reason: 'unsupported-attachment', notified: false });
  });

  test('a group stays silent: the attachment is named in the outcome but nobody is answered', async () => {
    const notices: string[] = [];
    const { context } = sharedContext({ 'surfaces.signal.token': 'sig-token' }, { deliverSurfaceNotice: async (_binding: unknown, text: string) => { notices.push(text); return { delivered: true }; } });
    const group = await postSignal(context, { groupId: 'group-1' });
    expect(await group.json()).toMatchObject({ reason: 'unsupported-attachment', notified: false });
    expect(notices).toEqual([]);
    const direct = await postSignal(context, {});
    expect(await direct.json()).toMatchObject({ reason: 'unsupported-attachment', notified: true });
    expect(notices).toHaveLength(1);
  });
});

describe('a slack message that is only a file', () => {
  const fileShare = (channel: string, channelType: string, ts: string, extra: Record<string, unknown> = {}) => ({
    type: 'event_callback', team_id: 'T1',
    event: { type: 'message', subtype: 'file_share', text: '', user: 'U1', channel, channel_type: channelType, ts, files: [{ id: 'F1' }], ...extra },
  });

  test('the sender of a direct message is told files cannot be read, and the outcome says so', async () => {
    const notices: string[] = [];
    const { context, calls } = sharedContext({}, { deliverSurfaceNotice: async (_binding: unknown, text: string) => { notices.push(text); return { delivered: true }; } });
    const response = await handleSlackSurfacePayload(fileShare('D1', 'im', '1.1'), context as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'ignored', reason: 'unsupported-attachment', attachment: 'file', notified: true });
    expect(notices).toEqual(['I cannot read files yet. Send the request as text.']);
    expect(spawns(calls)).toBe(0);
  });

  test('a channel stays silent, and a file the bot itself posted is not answered', async () => {
    const notices: string[] = [];
    const { context } = sharedContext({}, { deliverSurfaceNotice: async (_binding: unknown, text: string) => { notices.push(text); return { delivered: true }; } });
    const inChannel = await handleSlackSurfacePayload(fileShare('C1', 'channel', '2.1'), context as never);
    expect(await inChannel.json()).toMatchObject({ reason: 'unsupported-attachment', notified: false });
    const fromBot = await handleSlackSurfacePayload(fileShare('D1', 'im', '3.1', { bot_id: 'B1' }), context as never);
    expect(fromBot.status).toBe(200);
    expect(notices).toEqual([]);
  });
});

describe('telegram', () => {
  const config = { 'surfaces.telegram.webhookSecret': 'tg-secret', 'surfaces.telegram.botUsername': 'goodvibes_bot' };
  const post = (context: never, message: Record<string, unknown>, deps = {}) => handleTelegramSurfaceWebhook(new Request('http://localhost/telegram', {
    method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' }, body: JSON.stringify({ update_id: 1, message }),
  }), context, deps);

  test('an unaddressed group message the policy refuses is acknowledged, not failed, so Telegram does not redeliver it', async () => {
    const { context, calls } = sharedContext(config, { authorizeSurfaceIngress: async () => ({ allowed: false, reason: 'mention-required' }) });
    const response = await post(context, { chat: { id: 5, type: 'group' }, from: { id: 9 }, text: 'lunch anyone?' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'ignored', queued: false, policyReason: 'mention-required' });
    expect(spawns(calls)).toBe(0);
  });

  test('a control command carries the conversation it came from', async () => {
    const seen: unknown[] = [];
    const { context } = sharedContext(config, {
      parseSurfaceControlCommand: async () => ({ action: 'cancel', id: 'agent-9' }),
      performSurfaceControlCommand: async (_command: unknown, origin: unknown) => { seen.push(origin); return 'Cancelled'; },
    });
    await post(context, { chat: { id: 5, type: 'private' }, from: { id: 9 }, text: 'cancel agent-9' });
    expect(seen).toEqual([{ surface: 'telegram', routeId: 'binding-1', channelId: '5', userId: '9' }]);
  });

  test('a photo sent in a private chat is answered with what the bot cannot read; in a group it is left alone', async () => {
    const sent: string[] = [];
    const deps = { sendMessage: async (input: { text: string }) => { sent.push(input.text); } };
    const { context, calls } = sharedContext(config);
    const privateResponse = await post(context, { chat: { id: 5, type: 'private' }, from: { id: 9 }, photo: [{ file_id: 'f' }] }, deps);
    expect(await privateResponse.json()).toMatchObject({ outcome: 'ignored', reason: 'unsupported-attachment', attachment: 'photo', notified: true });
    expect(sent).toHaveLength(1);
    await post(context, { chat: { id: 6, type: 'group' }, from: { id: 9 }, photo: [{ file_id: 'f' }] }, deps);
    expect(sent).toHaveLength(1);
    expect(spawns(calls)).toBe(0);
  });

  test('/stop says nothing was stopped', async () => {
    const sent: string[] = [];
    const { context } = sharedContext(config);
    await post(context, { chat: { id: 5, type: 'private' }, from: { id: 9 }, text: '/stop', entities: [{ type: 'bot_command', offset: 0, length: 5 }] },
      { sendMessage: async (input: { text: string }) => { sent.push(input.text); } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.split('\n')[0]).toContain('Nothing was stopped');
  });
});

describe('telephony', () => {
  test('a refused caller is acknowledged, not failed', async () => {
    const { context } = sharedContext({ 'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555' }, {
      authorizeSurfaceIngress: async () => ({ allowed: false, reason: 'user-not-allowlisted' }),
    });
    const response = await handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' },
      body: JSON.stringify({ from: '+1999', text: 'hi' }),
    }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: 'ignored', reason: 'blocked-by-channel-policy' });
  });

  test('each spoken turn of one call is its own message; only a real message id identifies a redelivery', async () => {
    const { calls, context } = sharedContext({ 'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555' });
    const send = (body: Record<string, unknown>) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' }, body: JSON.stringify(body),
    }), context);
    await send({ From: '+1999', CallSid: 'CA1', SpeechResult: 'first turn' });
    await send({ From: '+1999', CallSid: 'CA1', SpeechResult: 'second turn' });
    await send({ From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    const ids = calls.filter((call) => call.kind === 'submitMessage').map((call) => (call.input as { providerMessageId?: string }).providerMessageId);
    expect(ids).toEqual([undefined, undefined, 'SM1']);
  });
});

describe('generic webhook', () => {
  const config = { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' };
  const post = (context: never, body: Record<string, unknown>) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' }, body: JSON.stringify(body),
  }), context);

  test('a call without a callback does not inherit the callback or correlation of an earlier call on the same route', async () => {
    const { context, bindings } = sharedContext(config);
    await post(context, { task: 'X', callbackUrl: 'https://a.example.com/hook', correlationId: 'c1', callbackSignature: 'shared-secret' });
    const afterFirst = bindings.get('webhook:webhook')!;
    expect(afterFirst.metadata.callbackUrl).toBe('https://a.example.com/hook');
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
    expect(submitted.metadata).toEqual({ note: 'kept' });
    const foreign = await post(context, { task: 'X', sessionId: 'telegram-session' });
    expect(foreign.status).toBe(403);
    expect(calls.filter((call) => call.kind === 'submitMessage')).toHaveLength(1);
  });
});
