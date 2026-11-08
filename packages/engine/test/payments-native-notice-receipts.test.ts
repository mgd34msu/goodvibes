import { afterEach, expect, spyOn, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../sdk/src/platform/channels/delivery-router.js';
import { createTelegramDeliveryStrategy } from '../sdk/src/platform/channels/delivery/strategies-core.js';
import type { ChannelDeliveryResult } from '../sdk/src/platform/channels/delivery/types.js';
import type { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { ServiceRegistry } from '../sdk/src/platform/config/service-registry.js';
import type { ArtifactStore } from '../sdk/src/platform/artifacts/index.js';
import { channelBackedPaymentNotifier } from '../sdk/src/platform/payments/host/notifier.js';
import { createChannelPaymentNotifier } from '../sdk/src/platform/payments/notice-delivery.js';

const restore: (() => void)[] = [];
afterEach(() => { for (const close of restore.splice(0).reverse()) close(); });
const replies = { async waitForAnswer() { return null; } };

function fixture(payload: unknown) {
  const values: Record<string, unknown> = { 'payments.notifyChannels': 'telegram', 'surfaces.telegram.defaultChatId': '@original-alias' };
  const config = { get: (key: string) => values[key] };
  const secrets = { async get() { return null; }, getGlobalHome: () => '/synthetic/no-secrets' };
  const registry = { async resolveSecret() { return 'synthetic-not-a-live-token'; }, get() { return undefined; } } as unknown as ServiceRegistry;
  const strategy = createTelegramDeliveryStrategy(config as unknown as ConfigManager, registry, {} as ArtifactStore, secrets);
  const router = new ChannelDeliveryRouter({ strategies: [strategy] });
  const sent: Record<string, unknown>[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    // The request has already selected the old alias. Looking at current
    // configuration after the acknowledgement would invent a new recipient.
    values['surfaces.telegram.defaultChatId'] = '@replacement-alias';
    return Response.json(payload);
  }, { preconnect() { throw new Error('Unexpected fixture preconnect'); } }));
  restore.push(() => fetch.mockRestore());
  return { sent, router, notifier: channelBackedPaymentNotifier(config, router, replies) };
}

test('native Telegram acknowledgement survives the real router and payment adapter as the original recipient and message', async () => {
  const f = fixture({ ok: true, result: { message_id: 51, chat: { id: -100123 }, message_thread_id: 7 } });
  const deliveries = await f.notifier.deliver({ kind: 'approval', message: 'The exact original purchase notice' });
  expect(f.sent).toHaveLength(1); expect(f.sent[0]?.['chat_id']).toBe('@original-alias');
  expect(deliveries).toEqual([{ channel: 'telegram', delivered: true, backfillable: false,
    receipt: { surfaceKind: 'telegram', conversationId: '-100123', messageId: '51', threadId: '7' } }]);
  expect(Object.isFrozen(deliveries[0]?.receipt)).toBe(true);
  expect(JSON.stringify(deliveries)).not.toContain('synthetic-not-a-live-token');
  expect(JSON.stringify(deliveries)).not.toContain('@replacement-alias');
});

test('the existing string-result delivery API still performs just one send', async () => {
  const f = fixture({ ok: true, result: { message_id: 51, chat: { id: -100123 } } });
  expect(await f.router.deliver({ target: { kind: 'surface', surfaceKind: 'telegram' }, body: 'An ordinary notice',
    title: 'Purchase', jobId: 'fixture', runId: 'fixture', includeLinks: false })).toBe('51');
  expect(f.sent).toHaveLength(1);
});

test.each([
  { message_id: 51 }, { message_id: 51, chat: { id: 0 } },
  { message_id: 1.5, chat: { id: -100123 } }, { message_id: 51, chat: { id: -100123 }, message_thread_id: -1 },
])('incomplete provider metadata cannot be reconstructed from current configuration', async result => {
  const f = fixture({ ok: true, result });
  expect(await f.notifier.deliver({ kind: 'approval', message: 'Original notice' }))
    .toEqual([{ channel: 'telegram', delivered: true, backfillable: false }]);
  expect(f.sent).toHaveLength(1);
});

test('borrowed receipt data is detached and cannot claim another channel or retain private extensions', async () => {
  const receipt = { surfaceKind: 'telegram' as const, conversationId: 'chat-A', messageId: 'message-A' };
  let result: ChannelDeliveryResult = { receipt };
  const notifier = createChannelPaymentNotifier({ router: {
    async deliver() { throw new Error('Detailed delivery must not dispatch twice'); },
    async deliverWithReceipt() { return result; },
  }, targets: [{ channel: 'telegram', request: {}, backfillable: false }], replies });
  const deliveries = await notifier.deliver({ kind: 'approval', message: 'Notice' });
  receipt.conversationId = 'chat-B';
  expect(deliveries[0]?.receipt?.conversationId).toBe('chat-A');
  result = { receipt: { ...receipt, surfaceKind: 'slack' } };
  expect((await notifier.deliver({ kind: 'approval', message: 'Notice' }))[0]?.receipt).toBeUndefined();
  result = { receipt: { ...receipt, secret: 'must-not-retain' } as typeof receipt };
  expect(JSON.stringify(await notifier.deliver({ kind: 'approval', message: 'Notice' }))).not.toContain('must-not-retain');
});
