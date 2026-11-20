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
 * says so, that no agent is free. The decision model is off.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { ntfyInboundDedup, surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { handleNtfySurfacePayload } from '../platform/src/platform/adapters/ntfy/index.ts';
import { handleWhatsAppSurfaceWebhook } from '../platform/src/platform/adapters/whatsapp/index.ts';
import { handleTelephonySurfaceWebhook } from '../platform/src/platform/adapters/telephony/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { surfaceDaemon, type SurfaceDaemon, type SurfaceDaemonOptions } from './_helpers/surface-daemon.ts';

const daemons: SurfaceDaemon[] = [];
let retirePolicy: () => void = () => {};
beforeEach(() => { retirePolicy = configureDecisionModelPolicy(() => 'No Decision Model'); });
afterEach(async () => {
  surfaceInboundDedup.clear(); ntfyInboundDedup.clear();
  for (const daemon of daemons.splice(0)) { await daemon.stop(); rmSync(daemon.root, { recursive: true, force: true }); }
  retirePolicy();
});

async function daemonWith(options: SurfaceDaemonOptions): Promise<SurfaceDaemon> {
  const daemon = await surfaceDaemon(options);
  daemons.push(daemon);
  return daemon;
}

/** The agent runtime answers that no agent is free to the spawn requests `busy` picks. */
const busyOn = (busy: (count: number) => boolean): SurfaceDaemonOptions['spawn'] => (_request, count) =>
  (busy(count) ? Response.json({ error: 'busy' }, { status: 503 }) : { id: `agent-${count}` } as never);

describe('whatsapp', () => {
  const settings = { 'surfaces.whatsapp.provider': 'bridge', 'surfaces.whatsapp.signingSecret': 'wa-token', 'surfaces.whatsapp.phoneNumberId': 'phone-1' };
  const post = (daemon: SurfaceDaemon, messages: unknown[]) => handleWhatsAppSurfaceWebhook(new Request('http://localhost/whatsapp', {
    method: 'POST',
    headers: { 'x-goodvibes-whatsapp-token': 'wa-token' },
    body: JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages } }] }] }),
  }), daemon.adapterContext());

  test('a refused sender in the same payload does not fail it, and a redelivery does not run the allowed message again', async () => {
    // 111 is the owner; 222 is nobody the policy knows.
    const daemon = await daemonWith({ settings, policies: { whatsapp: { allowlistUserIds: ['111'] } } });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'hello' } }, { id: 'wamid.B', from: '222', text: { body: 'hello' } }];
    const first = await post(daemon, messages);
    expect(first.status).toBe(200);
    expect(daemon.spawns).toHaveLength(1);
    const second = await post(daemon, messages);
    expect(second.status).toBe(200);
    expect(daemon.spawns).toHaveLength(1);
  });

  test('a message whose handling failed is run again on redelivery while the one already handled is not', async () => {
    // The second spawn request overall (message B on first delivery) finds no free agent.
    const daemon = await daemonWith({ settings, policies: { whatsapp: { allowlistUserIds: ['111', '112'] } }, spawn: busyOn((count) => count === 2) });
    const messages = [{ id: 'wamid.A', from: '111', text: { body: 'one' } }, { id: 'wamid.B', from: '112', text: { body: 'two' } }];
    const first = await post(daemon, messages);
    expect(first.status).toBe(503);
    expect(daemon.spawns).toHaveLength(2);
    const second = await post(daemon, messages);
    expect(second.status).toBe(200);
    expect(daemon.spawns).toHaveLength(3);
    const third = await post(daemon, messages);
    expect(third.status).toBe(200);
    expect(daemon.spawns).toHaveLength(3);
  });
});

test('ntfy: one message that arrives by both routes starts one agent, and one whose start failed is started when it arrives again', async () => {
  const topic = 'gv-agent-fixture-redelivery';
  let refuseNext = false;
  const daemon = await daemonWith({
    settings: { 'surfaces.ntfy.agentTopic': topic },
    spawn: busyOn(() => { const refuse = refuseNext; refuseNext = false; return refuse; }),
  });
  const arrive = (id: string) => handleNtfySurfacePayload({ id, topic, event: 'message', message: `message ${id}` }, daemon.adapterContext());

  // The subscription and the webhook route both hand over n1.
  await arrive('n1');
  await arrive('n1');
  expect(daemon.spawns).toHaveLength(1);

  // n2's first start finds no free agent; its next arrival starts it, and a third does nothing.
  refuseNext = true;
  expect((await arrive('n2')).status).toBe(503);
  await arrive('n2');
  await arrive('n2');
  expect(daemon.spawns).toHaveLength(3);
});

describe('telephony', () => {
  const settings = { 'surfaces.telephony.webhookSecret': 'tel', 'surfaces.telephony.fromNumber': '+1555' };
  const send = (daemon: SurfaceDaemon, body: Record<string, unknown>) => handleTelephonySurfaceWebhook(new Request('http://localhost/telephony', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-telephony-token': 'tel' }, body: JSON.stringify(body),
  }), daemon.adapterContext());

  test('each spoken turn of one call is its own message; a redelivered text message is run once', async () => {
    const daemon = await daemonWith({ settings, policies: { telephony: { allowlistUserIds: ['+1999'] } } });
    await send(daemon, { From: '+1999', CallSid: 'CA1', SpeechResult: 'first turn' });
    await send(daemon, { From: '+1999', CallSid: 'CA1', SpeechResult: 'second turn' });
    await send(daemon, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    await send(daemon, { From: '+1999', MessageSid: 'SM1', Body: 'a text' });
    expect(daemon.storedMessages().map((message) => message.body).sort()).toEqual(['a text', 'first turn', 'second turn']);
  });
});

describe('generic webhook', () => {
  const settings = { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' };
  const post = (daemon: SurfaceDaemon, body: Record<string, unknown>) => handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' }, body: JSON.stringify(body),
  }), daemon.webhookContext());

  test('a call without a callback does not inherit the callback, correlation or signature of an earlier call', async () => {
    const daemon = await daemonWith({ settings });
    const binding = () => daemon.routeBindings.listBindings().find((entry) => entry.surfaceKind === 'webhook' && entry.externalId === 'webhook')!;
    await post(daemon, { task: 'X', callbackUrl: 'https://a.example.com/hook', correlationId: 'c1', callbackSignature: 'shared-secret' });
    expect(binding().metadata.callbackUrl).toBe('https://a.example.com/hook');
    await post(daemon, { task: 'Y' });
    const afterSecond = binding();
    expect(afterSecond.metadata.callbackUrl).toBeUndefined();
    expect(afterSecond.metadata.correlationId).toBeUndefined();
    expect(afterSecond.metadata.callbackSignature).toBeUndefined();
  });

  test('platform markers in caller metadata are dropped, and a session from another surface cannot be entered', async () => {
    const daemon = await daemonWith({ settings });
    // A Telegram conversation the broker already holds.
    const telegram = await daemon.sessionBroker.submitMessage({ surfaceKind: 'telegram', surfaceId: 'telegram', externalId: 'chat-5', body: 'from telegram' });
    await post(daemon, { task: 'X', metadata: { 'goodvibes.workAuthorized': true, note: 'kept' } });
    const webhookInputs = daemon.sessionBroker.listSessions(100)
      .filter((session) => session.id !== telegram.session.id)
      .flatMap((session) => daemon.sessionBroker.getInputs(session.id, 100));
    expect(webhookInputs).toHaveLength(1);
    expect(webhookInputs[0]!.metadata['goodvibes.workAuthorized']).toBeUndefined();
    const foreign = await post(daemon, { task: 'X', sessionId: telegram.session.id });
    expect(foreign.status).toBe(403);
    expect(daemon.sessionBroker.getMessages(telegram.session.id, 100).map((message) => message.body)).toEqual(['from telegram']);
  });
});
