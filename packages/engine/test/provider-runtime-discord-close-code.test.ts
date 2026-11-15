/**
 * A Discord gateway close the provider will refuse again (bad token, missing
 * intent) must reach the cluster as permanent and stay visible in the status.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { ChannelProviderRuntimeManager } from '../platform/src/platform/channels/provider-runtime.js';
import { DiscordGatewayClient } from '../platform/src/platform/integrations/discord.js';

interface ClientInternals { options: { onClosed(reason: string, code?: number): void } }

async function startedManager(): Promise<{ manager: ChannelProviderRuntimeManager; client: ClientInternals; restore: () => void }> {
  const manager = new ChannelProviderRuntimeManager({
    configManager: { get: (key: string) => (key === 'surfaces.discord.botToken' ? 'discord-test' : undefined) } as never,
    serviceRegistry: { resolveSecret: async () => null, get: () => null } as never,
    buildSurfaceAdapterContext: () => ({}) as never,
  });
  const instances: object[] = [];
  const startSpy = spyOn(DiscordGatewayClient.prototype, 'start').mockImplementation(async function (this: DiscordGatewayClient) {
    instances.push(this);
    return { url: 'wss://gw', shards: 1 } as never;
  });
  const stopSpy = spyOn(DiscordGatewayClient.prototype, 'stop').mockImplementation(() => undefined);
  await manager.start('discord');
  return { manager, client: instances[0] as unknown as ClientInternals, restore: () => { startSpy.mockRestore(); stopSpy.mockRestore(); } };
}

describe('Discord gateway close codes', () => {
  test('a rejected-token close is reported permanent and recorded as the status error', async () => {
    const { manager, client, restore } = await startedManager();
    try {
      const lost: Array<{ reason: string; permanent: boolean | undefined }> = [];
      manager.setSocketLostHandler((_kind, reason, permanent) => { lost.push({ reason, permanent }); });
      client.options.onClosed('the Discord gateway connection closed (code 4004)', 4004);
      expect(lost).toEqual([{ reason: 'the Discord gateway connection closed (code 4004)', permanent: true }]);
      const status = manager.status('discord');
      expect(status.running).toBe(false);
      expect(status.lastError).toContain('code 4004');
    } finally { restore(); }
  });

  test('a network drop is reported as retryable and leaves no error', async () => {
    const { manager, client, restore } = await startedManager();
    try {
      const lost: Array<boolean | undefined> = [];
      manager.setSocketLostHandler((_kind, _reason, permanent) => { lost.push(permanent); });
      client.options.onClosed('the Discord gateway connection closed', 1006);
      expect(lost).toEqual([false]);
      expect(manager.status('discord').lastError).toBeUndefined();
    } finally { restore(); }
  });
});
