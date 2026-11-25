// Proves: An owner alert (an approval prompt that could not be shown, a dead channel, a failed update) is sent to a group, a shared channel, a webhook route or another person's chat.
// Red when: isOwnerConversation stops requiring the owner's own private conversation, or takes a Home Assistant conversation for one.
/**
 * An alert names what the assistant is doing for the owner, so it goes only to
 * a conversation that is the owner's own. The conversations are recorded the
 * way the product records them: the adapters write the route bindings from the
 * messages they receive, and the channel policies name each surface's owner.
 *
 * The real Telegram, Slack and generic webhook adapters and every daemon
 * piece behind them, composed as the daemon composes them
 * (_helpers/surface-daemon.ts): settings, secret store, route bindings,
 * session broker, channel policies and the surface-action helper. The agent
 * runtime records each spawn request; the decision model is off. The delivery
 * port records the conversation it was asked to send on and the receipt it
 * was asked to keep.
 */
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { processTelegramUpdate } from '../platform/src/platform/adapters/telegram/index.ts';
import { handleSlackSurfacePayload } from '../platform/src/platform/adapters/slack/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { handleHomeAssistantSurfaceWebhook } from '../platform/src/platform/adapters/homeassistant/index.ts';
import { surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.ts';
import type { ChannelSurface } from '../platform/src/platform/channels/types.ts';
import { deliverOwnerAlert, type OwnerAlertDelivery } from '../platform/src/platform/daemon/owner-alert.ts';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.ts';
import { surfaceDaemon, type SurfaceDaemon } from './_helpers/surface-daemon.ts';

const daemons: SurfaceDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) { await daemon.stop(); rmSync(daemon.root, { recursive: true, force: true }); }
  surfaceInboundDedup.clear();
});

test('an owner alert is offered only to the owner\'s own private chat, never to a group, a channel, a webhook route or a friend\'s chat', async () => {
  const retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
  const daemon = await surfaceDaemon({
    settings: {
      'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret',
      'surfaces.homeassistant.enabled': true, 'surfaces.homeassistant.webhookSecret': 'ha-secret',
    },
    policies: {
      telegram: { allowlistUserIds: ['42', '77'], allowGroupMessages: true, requireMention: false },
      slack: { allowlistUserIds: ['U-OWNER'], allowGroupMessages: true, requireMention: false },
      webhook: { allowlistUserIds: ['hook-owner'] },
      homeassistant: { allowlistUserIds: ['ha-owner'] },
    },
  });
  daemons.push(daemon);
  const { routeBindings, channelPolicy: policy } = daemon;
  const context = daemon.adapterContext();

  // The owner's private chat, a group the owner writes in, and a friend's private chat on Telegram.
  const telegram = (updateId: number, chat: Record<string, unknown>, fromId: number) => processTelegramUpdate({
    update_id: updateId, message: { message_id: updateId, chat, from: { id: fromId, first_name: 'someone' }, text: 'hello' },
  }, context, {});
  await telegram(1, { id: 42, type: 'private' }, 42);
  await telegram(2, { id: -100500, type: 'group', title: 'family' }, 42);
  await telegram(3, { id: 77, type: 'private' }, 77);
  // The owner writing in a shared Slack channel.
  await handleSlackSurfacePayload({
    type: 'event_callback', team_id: 'T1', event_id: 'Ev1',
    event: { type: 'message', channel: 'C-SHARED', channel_type: 'channel', user: 'U-OWNER', text: 'hello', ts: '1.0001' },
  }, context);
  // A webhook caller describing itself as the webhook surface's owner in a direct conversation.
  await handleGenericWebhookSurface(new Request('http://localhost/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-webhook-secret': 'hook-secret' },
    body: JSON.stringify({ task: 'hello', userId: 'hook-owner', conversationKind: 'direct', callbackUrl: 'https://caller.example.test/hook' }),
  }), daemon.webhookContext());
  // A Home Assistant voice conversation naming the surface's owner as the user, one-to-one: it names the device, never who is speaking.
  await handleHomeAssistantSurfaceWebhook(new Request('http://localhost/webhook/homeassistant', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-homeassistant-secret': 'ha-secret' },
    body: JSON.stringify({ message: '', userId: 'ha-owner', conversationId: 'kitchen', mode: 'conversation' }),
  }), context);
  retirePolicy();
  const surfaces = routeBindings.listBindings().map((binding) => binding.surfaceKind).sort();
  expect(surfaces).toEqual(['homeassistant', 'slack', 'telegram', 'telegram', 'telegram', 'webhook']);

  const tried: AutomationRouteBinding[] = [];
  const receipts: string[] = [];
  // Every conversation refuses, so every candidate is tried and shows here.
  const delivery: OwnerAlertDelivery = {
    deliverSurfaceNotice: async (binding) => {
      if (binding) tried.push(binding);
      return { delivered: false, reason: 'delivery-failed', error: 'refused by the fixture' };
    },
    channelOwner: (surface) => policy.getPolicy(surface as ChannelSurface).ownerId,
    recordOwnerReceipt: (text) => { receipts.push(text); },
  };

  for (const preferred of ['telegram', 'slack', null] as const) {
    tried.length = 0;
    await deliverOwnerAlert(routeBindings, delivery, preferred, 'Slack is not working');
    expect({ preferred, tried: tried.map((binding) => `${binding.surfaceKind}:${binding.externalId}`) }).toEqual({ preferred, tried: ['telegram:42'] });
  }

  // Without the owner's private chat there is nowhere to send it: nothing is tried and it is kept for the next terminal.
  const ownChat = routeBindings.listBindings().find((binding) => binding.surfaceKind === 'telegram' && binding.externalId === '42')!;
  await routeBindings.removeBinding(ownChat.id);
  tried.length = 0;
  receipts.length = 0;
  expect(await deliverOwnerAlert(routeBindings, delivery, 'telegram', 'Telegram is not working')).toBeNull();
  expect(tried).toEqual([]);
  expect(receipts).toEqual(['Telegram is not working']);
});
