// Proves: A provider redelivery starts a second agent run, a message whose handling failed is never run, a refused sender is run, or a webhook caller reaches another caller's callback, the platform's own markers or another surface's session.
// Red when: The shared pipeline runs a refused sender or answers a refusal with a failure, a claim (the shared pipeline's or ntfy's own) is kept after a failed handling or dropped after a success, telephony keys spoken turns by call id, or a webhook caller inherits another's callback, sets platform markers or enters another surface's session.
/**
 * What the webhook adapters do when a provider redelivers, a sender is refused,
 * or a caller supplies more than it should: no second run of a message already
 * handled, a retry for one whose handling failed, an acknowledgement (never a
 * failure status) for an ordinary refusal so the provider does not stall its
 * queue redelivering it, and no stale or foreign callback or session.
 *
 * The adapters, their shared delivery claim and every daemon piece behind
 * them are real, composed as the daemon composes them
 * (_helpers/surface-daemon.ts): settings, secret store, service registry,
 * route bindings, session broker, channel policy and the surface-action helper
 * whose adapter context they get. The agent runtime, where the model begins,
 * records each spawn request and answers a started agent or, where a case
 * says so, that no agent is free. The decision model is off. One daemon serves
 * the file, as one owner's daemon serves every surface: each case uses its own
 * provider message ids and counts only what it started.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ntfyInboundDedup, surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { handleNtfySurfacePayload } from '../platform/src/platform/adapters/ntfy/index.ts';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.ts';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { surfaceDaemon, type SurfaceDaemon } from './_helpers/surface-daemon.ts';

const NTFY_TOPIC = 'gv-agent-fixture-redelivery';

/** Which of this case's spawn requests (1 = its first) the agent runtime answers with "no agent is free". */
let busy: (nth: number) => boolean = () => false;
/** Spawn requests made before this case. */
let before = 0;
let daemon: SurfaceDaemon;
let retirePolicy: () => void = () => {};

beforeAll(async () => {
  daemon = await surfaceDaemon({
    settings: {
      'surfaces.whatsapp.provider': 'bridge', 'surfaces.whatsapp.signingSecret': 'wa-token', 'surfaces.whatsapp.phoneNumberId': 'phone-1',
      'surfaces.ntfy.agentTopic': NTFY_TOPIC,
      'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555',
      'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret',
    },
    // WhatsApp's 111 and 112 and the caller +1999 are known; WhatsApp's 222 is nobody the policy knows.
    policies: { whatsapp: { allowlistUserIds: ['111', '112'] }, telephony: { allowlistUserIds: ['+1999'] } },
    spawn: (_request, count) => (busy(count - before) ? Response.json({ error: 'busy' }, { status: 503 }) : { id: `agent-${count}` } as never),
  });
});
afterAll(async () => {
  await daemon.stop();
  rmSync(daemon.root, { recursive: true, force: true });
});
beforeEach(() => {
  retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
  before = daemon.spawns.length;
  busy = () => false;
});
afterEach(() => {
  surfaceInboundDedup.clear(); ntfyInboundDedup.clear();
  retirePolicy();
});

/** Agent runs this case started. */
const spawned = () => daemon.spawns.length - before;

describe('whatsapp', () => {
  const post = (messages: unknown[]) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
    method: 'POST',
    headers: { 'x-goodvibes-whatsapp-token': 'wa-token' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages } }] }] }),
  }), daemon.adapterContext());

  test('a refused sender in the same payload does not fail it, and a redelivery does not run the allowed message again', async () => {
    const messages = [{ id: 'wamid.A1', from: '111', text: { body: 'hello' } }, { id: 'wamid.B1', from: '222', text: { body: 'hello' } }];
    const first = await post(messages);
    expect(first.status).toBe(200);
    expect(spawned()).toBe(1);
    const second = await post(messages);
    expect(second.status).toBe(200);
    expect(spawned()).toBe(1);
  });

  test('a message whose handling failed is run again on redelivery while the one already handled is not', async () => {
    // The second spawn request of this case (message B on first delivery) finds no free agent.
    busy = (nth) => nth === 2;
    const messages = [{ id: 'wamid.A2', from: '111', text: { body: 'one' } }, { id: 'wamid.B2', from: '112', text: { body: 'two' } }];
    const first = await post(messages);
    expect(first.status).toBe(503);
    expect(spawned()).toBe(2);
    const second = await post(messages);
    expect(second.status).toBe(200);
    expect(spawned()).toBe(3);
    const third = await post(messages);
    expect(third.status).toBe(200);
    expect(spawned()).toBe(3);
  });
});

test('ntfy: one message that arrives by both routes starts one agent, and one whose start failed is started when it arrives again', async () => {
  const arrive = (id: string) => handleNtfySurfacePayload({ id, topic: NTFY_TOPIC, event: 'message', message: `message ${id}` }, daemon.adapterContext());

  // The subscription and the webhook route both hand over n1.
  await arrive('n1');
  await arrive('n1');
  expect(spawned()).toBe(1);

  // n2's first start finds no free agent; its next arrival starts it, and a third does nothing.
  busy = (nth) => nth === 2;
  expect((await arrive('n2')).status).toBe(503);
  await arrive('n2');
  await arrive('n2');
  expect(spawned()).toBe(3);
});

describe('telephony', () => {
  const send = (body: Record<string, unknown>) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' }, body: JSON.stringify(body),
  }), daemon.adapterContext());

  test('each spoken turn of one call is its own message; a redelivered text message is run once', async () => {
    const said = ['first turn', 'second turn', 'a text'];
    await send({ From: '+1999', CallSid: 'CA1', SpeechResult: 'first turn' });
    await send({ From: '+1999', CallSid: 'CA1', SpeechResult: 'second turn' });
    await send({ From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    await send({ From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    expect(daemon.storedMessages().map((message) => message.body).filter((body) => said.includes(body)).sort()).toEqual(['a text', 'first turn', 'second turn']);
  });
});

describe('generic webhook', () => {
  const post = (body: Record<string, unknown>) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' }, body: JSON.stringify(body),
  }), daemon.webhookContext());

  test('a call without a callback does not inherit the callback, correlation or signature of an earlier call', async () => {
    const binding = () => daemon.routeBindings.listBindings().find((entry) => entry.surfaceKind === 'webhook' && entry.externalId === 'webhook')!;
    await post({ task: 'X', callbackUrl: 'https://a.example.com/hook', correlationId: 'c1', callbackSignature: 'shared-secret' });
    expect(binding().metadata.callbackUrl).toBe('https://a.example.com/hook');
    await post({ task: 'Y' });
    const afterSecond = binding();
    expect(afterSecond.metadata.callbackUrl).toBeUndefined();
    expect(afterSecond.metadata.correlationId).toBeUndefined();
    expect(afterSecond.metadata.callbackSignature).toBeUndefined();
  });

  test('platform markers in caller metadata are dropped, and a session from another surface cannot be entered', async () => {
    // A Telegram conversation the broker already holds.
    const telegram = await daemon.sessionBroker.submitMessage({ surfaceKind: 'telegram', surfaceId: 'telegram', externalId: 'chat-5', body: 'from telegram' });
    await post({ task: 'marked task', metadata: { 'goodvibes.workAuthorized': true, note: 'kept' } });
    const marked = daemon.sessionBroker.listSessions(100)
      .flatMap((session) => daemon.sessionBroker.getInputs(session.id, 100))
      .filter((input) => input.body === 'marked task');
    expect(marked).toHaveLength(1);
    expect(marked[0]!.metadata['goodvibes.workAuthorized']).toBeUndefined();
    const foreign = await post({ task: 'foreign task', sessionId: telegram.session.id });
    expect(foreign.status).toBe(403);
    expect(daemon.sessionBroker.getMessages(telegram.session.id, 100).map((message) => message.body)).toEqual(['from telegram']);
  });
});
