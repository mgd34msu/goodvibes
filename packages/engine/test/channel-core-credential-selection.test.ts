import { afterEach, expect, spyOn, test } from 'bun:test';
import { ChannelDeliveryRouter } from '../platform/src/platform/channels/delivery-router.js';
import type { ChannelDeliveryRequest } from '../platform/src/platform/channels/delivery/types.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { ServiceRegistry } from '../platform/src/platform/config/service-registry.js';
import type { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import {
  createDiscordDeliveryStrategy, createGoogleChatDeliveryStrategy, createSlackDeliveryStrategy,
} from '../platform/src/platform/channels/delivery/strategies-core.js';
import { logger } from '../platform/src/platform/utils/logger.js';
const restores: Array<() => void> = [];
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore(); });
const PUBLIC_ADDRESS = '203.0.113.7';
function fixture(surface: 'telegram' | 'slack' | 'discord' | 'google-chat', values: Record<string, unknown> = {}, webhookStrategies = false) {
  let lookups = 0;
  const calls: string[] = [];
  const fetched = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (url: string | URL | Request) => {
    calls.push(String(url)); return Response.json({ ok: true, id: 'owned-id' });
  }, { preconnect() {} }));
  restores.push(() => fetched.mockRestore());
  for (const level of ['info', 'warn', 'error'] as const) {
    const log = spyOn(logger, level).mockImplementation(() => {}); restores.push(() => log.mockRestore());
  }
  const configManager = { get: (key: string) => values[key] } as unknown as ConfigManager;
  const serviceRegistry = { get: () => undefined, resolveSecret: async () => null } as unknown as ServiceRegistry;
  const artifactStore = {} as ArtifactStore;
  const secretsManager = { get: async () => { lookups += 1; return null; }, getGlobalHome: () => '/owned-synthetic-home' };
  // An explicit webhook host is resolved and pinned before sending; a fixed public answer keeps the test off the network.
  const resolveHost = async () => [{ address: PUBLIC_ADDRESS, family: 4 as const }];
  const router = webhookStrategies && (surface === 'slack' || surface === 'discord' || surface === 'google-chat')
    ? new ChannelDeliveryRouter({ strategies: [
      surface === 'slack' ? createSlackDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager, { resolveHost })
        : surface === 'discord' ? createDiscordDeliveryStrategy(serviceRegistry, configManager, artifactStore, secretsManager, { resolveHost })
        : createGoogleChatDeliveryStrategy(configManager, serviceRegistry, artifactStore, secretsManager, { resolveHost }),
    ] })
    : new ChannelDeliveryRouter({ configManager, serviceRegistry, artifactStore, secretsManager });
  const request: ChannelDeliveryRequest = {
    target: { kind: 'surface', surfaceKind: surface, ...(surface === 'google-chat' ? {} : { address: '123456789012345678' }) },
    body: 'owned body', title: 'owned', jobId: 'owned-job', runId: 'owned-run', includeLinks: false,
  };
  return { router, request, calls, lookups: () => lookups };
}
for (const [surface, key, environment] of [
  ['telegram', 'surfaces.telegram.botToken', 'TELEGRAM_BOT_TOKEN'],
  ['slack', 'surfaces.slack.botToken', 'SLACK_BOT_TOKEN'],
  ['discord', 'surfaces.discord.botToken', 'DISCORD_BOT_TOKEN'],
  ['google-chat', 'surfaces.googleChat.webhookUrl', 'GOOGLE_CHAT_WEBHOOK_URL'],
] as const) {
  test(`${surface} unresolved configured credential refuses instead of selecting an environment account`, async () => {
    const previous = process.env[environment];
    process.env[environment] = surface === 'google-chat' ? 'https://owned-other.example.invalid/hook' : 'owned-other-token';
    restores.push(() => { if (previous === undefined) delete process.env[environment]; else process.env[environment] = previous; });
    const owned = fixture(surface, { [key]: 'goodvibes://secrets/goodvibes/OWNED_MISSING_SECRET' });
    await expect(owned.router.deliver(owned.request)).rejects.toThrow('Could not resolve');
    expect(owned.calls).toHaveLength(0);
    expect(owned.lookups()).toBe(1);
  });
}
test('an invalid explicit Google Chat target cannot fall back to its configured destination', async () => {
  const owned = fixture('google-chat', { 'surfaces.googleChat.webhookUrl': 'https://owned-default.example.invalid/hook' });
  await expect(owned.router.deliver({ ...owned.request, target: { kind: 'surface', surfaceKind: 'google-chat', address: 'http://owned-requested.example.invalid/hook' } }))
    .rejects.toThrow('explicit HTTPS');
  expect(owned.calls).toHaveLength(0); expect(owned.lookups()).toBe(0);
});
for (const surface of ['slack', 'discord', 'google-chat'] as const) {
  test(`${surface} explicit webhook does not require an unrelated broken fallback`, async () => {
    const key = surface === 'google-chat' ? 'surfaces.googleChat.webhookUrl' : `surfaces.${surface}.botToken`;
    const owned = fixture(surface, { [key]: 'goodvibes://secrets/goodvibes/OWNED_MISSING_SECRET' }, true);
    const target = surface === 'slack' ? 'https://hooks.slack.com/services/owned-synthetic-token'
      : surface === 'discord' ? 'https://discord.com/api/webhooks/123456789012345678/owned-synthetic-token'
      : 'https://owned-requested.example.invalid/hook';
    await owned.router.deliver({ ...owned.request, target: { kind: 'surface', surfaceKind: surface, address: target } });
    const pinned = new URL(target); pinned.hostname = PUBLIC_ADDRESS;
    expect(owned.calls).toEqual([pinned.toString()]); expect(owned.lookups()).toBe(0);
  });
}
