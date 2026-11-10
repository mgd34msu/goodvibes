import { expect, spyOn, test } from 'bun:test';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';

test('browser judgment trusts the original bound listener rather than stale configured or forwarded origins', async () => {
  const discovery = spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]);
  const benchmarks = spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined);
  let host: Awaited<ReturnType<typeof startDaemonFixture>> | undefined;
  try {
    host = await startDaemonFixture({
    hostSessions: false,
    inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    configure(config) {
      config.set('controlPlane.port', 3421);
      config.set('controlPlane.cors.enabled', false);
    },
    });
    expect(host.daemon.boundPort).not.toBe(3421);
    const selected = host;
    const post = (origin: string, extra: Record<string, string> = {}) => selected.fetch('/api/judgment/batteries/run', {
      method: 'POST', headers: { origin, 'content-type': 'application/json', ...extra },
      // Deliberately invalid input stops after origin admission, without any
      // model request or a synthetic semantic approval.
      body: JSON.stringify({ protocolVersion: 0 }),
    });
    const original = await post(host.baseUrl);
    expect(original.status).toBe(400);
    expect(await original.json()).toMatchObject({ error: { code: 'JUDGMENT_INVALID_INPUT' } });
    for (const origin of ['http://127.0.0.1:3421', 'https://foreign.invalid']) {
      const refused = await post(origin, { 'x-forwarded-host': new URL(origin).host, 'x-forwarded-proto': 'https' });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ error: { code: 'JUDGMENT_ORIGIN_DENIED' } });
    }
    const anonymous = await host.fetchAnonymous('/api/judgment/batteries/run', {
      method: 'POST', headers: { origin: host.baseUrl, 'content-type': 'application/json' }, body: '{}',
    });
    expect(anonymous.status).toBe(401);
  } finally {
    try { await host?.stop(); }
    finally { benchmarks.mockRestore(); discovery.mockRestore(); }
  }
});
