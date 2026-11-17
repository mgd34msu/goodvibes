// Proves: An owner alert (an approval prompt that could not be shown, a dead channel, a failed update) is sent to a group, a shared channel, a webhook route or another person's chat.
// Red when: isOwnerConversation stops requiring the owner's own private conversation.
/**
 * An alert names what the assistant is doing for the owner, so it goes only to
 * a conversation that is the owner's own. The conversations are recorded the
 * way the product records them: the adapters write the route bindings from the
 * messages they receive, and the channel policies name each surface's owner.
 *
 * Real route bindings over their file, real channel policies, the real
 * Telegram, Slack and generic webhook adapters; the delivery port records the
 * conversation it was asked to send on and the receipt it was asked to keep.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processTelegramUpdate } from '../platform/src/platform/adapters/telegram/index.ts';
import { handleSlackSurfacePayload } from '../platform/src/platform/adapters/slack/index.ts';
import { handleGenericWebhookSurface } from '../platform/src/platform/adapters/webhook/index.ts';
import { surfaceInboundDedup } from '../platform/src/platform/adapters/inbound-dedup.ts';
import { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.ts';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.ts';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.ts';
import { ChannelPolicyManager } from '../platform/src/platform/channels/policy-manager.ts';
import type { ChannelSurface } from '../platform/src/platform/channels/types.ts';
import { deliverOwnerAlert, type OwnerAlertDelivery } from '../platform/src/platform/daemon/owner-alert.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  surfaceInboundDedup.clear();
});

test('an owner alert is offered only to the owner\'s own private chat, never to a group, a channel, a webhook route or a friend\'s chat', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-owner-alert-'));
  dirs.push(dir);
  const routeBindings = new RouteBindingManager({ store: new AutomationRouteStore(join(dir, 'bindings.json')) });
  await routeBindings.start();
  const policy = new ChannelPolicyManager({ storePath: join(dir, 'policies.json') });
  await policy.upsertPolicy('telegram', { allowlistUserIds: ['42', '77'] });
  await policy.upsertPolicy('slack', { allowlistUserIds: ['U-OWNER'] });
  await policy.upsertPolicy('webhook', { allowlistUserIds: ['hook-owner'] });

  const config: Record<string, unknown> = { 'surfaces.webhook.enabled': true, 'surfaces.webhook.secret': 'hook-secret' };
  let agents = 0;
  const context = {
    serviceRegistry: { resolveSecret: async () => null },
    configManager: { get: (key: string) => config[key] },
    routeBindings,
    sessionBroker: {
      getSession: () => null,
      submitMessage: async () => ({ mode: 'spawn', task: { prompt: 'task' }, session: { id: 'session-1' }, input: { id: `input-${++agents}` } }),
      bindAgent: async () => undefined,
    },
    authorizeSurfaceIngress: async () => ({ allowed: true }),
    parseSurfaceControlCommand: () => null,
    performSurfaceControlCommand: async () => 'ok',
    performInteractiveSurfaceAction: async () => 'ok',
    trySpawnAgent: () => ({ id: `agent-${++agents}` }),
    queueSurfaceReplyFromBinding: () => undefined,
    surfaceDeliveryEnabled: () => true,
    signWebhookPayload: () => '',
    queueWebhookReply: () => undefined,
  } as never;

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
  }), context);
  const surfaces = routeBindings.listBindings().map((binding) => binding.surfaceKind).sort();
  expect(surfaces).toEqual(['slack', 'telegram', 'telegram', 'telegram', 'webhook']);

  const tried: AutomationRouteBinding[] = [];
  const receipts: string[] = [];
  // Every conversation refuses, so every candidate is tried and shows here.
  const delivery: OwnerAlertDelivery = {
    deliverSurfaceNotice: async (binding) => { tried.push(binding); return { delivered: false, reason: 'refused-by-fixture' }; },
    channelOwner: (surface) => policy.getPolicy(surface as ChannelSurface).ownerId,
    recordOwnerReceipt: (text) => { receipts.push(text); },
  } as OwnerAlertDelivery;

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
