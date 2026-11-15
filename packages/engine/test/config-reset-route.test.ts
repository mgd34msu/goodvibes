/** POST /config/reset: removing one key's explicit value so it reads as its default again. */
import { describe, expect, test } from 'bun:test';
import { createDaemonSystemRouteHandlers } from '../daemon-api/src/system-routes.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';

function build(options: { admin?: boolean; secretKeys?: readonly string[]; canReset?: boolean; invalid?: readonly string[] } = {}) {
  const defaults: Record<string, unknown> = { 'watchers.pollIntervalMs': 60_000, 'cluster.secret': '' };
  const config: Record<string, unknown> = { ...defaults, 'watchers.pollIntervalMs': 5_000 };
  const resets: string[] = [];
  let body: Record<string, unknown> = {};
  const context = {
    requireAdmin: () => options.admin === false ? Response.json({ error: 'admin required' }, { status: 403 }) : null,
    parseJsonBody: async () => body,
    isValidConfigKey: (key: string) => !(options.invalid ?? []).includes(key),
    ...(options.secretKeys ? { isSecretBearingConfigKey: (key: string) => options.secretKeys!.includes(key) } : {}),
    configManager: {
      get: (key: string) => config[key],
      getAll: () => structuredClone(config),
      setDynamic: (key: string, value: unknown) => { config[key] = value; },
      ...(options.canReset === false ? {} : { reset: (key: string) => { resets.push(key); config[key] = defaults[key]; } }),
      describeConfigKeySource: () => ({ tier: 'daemon', daemonOwned: true, daemonTierPath: '/daemon-tier.json' }),
    },
  } as never;
  return { handlers: createDaemonSystemRouteHandlers(context), config, resets, withBody: (next: Record<string, unknown>) => { body = next; } };
}
const req = () => new Request('http://daemon.invalid/config/reset', { method: 'POST' });

describe('POST /config/reset', () => {
  test('removes the explicit value and reports what the host now holds and where', async () => {
    const f = build();
    f.withBody({ key: 'watchers.pollIntervalMs' });
    const response = await f.handlers.postConfigReset(req());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, key: 'watchers.pollIntervalMs', value: 60_000, persistedTo: '/daemon-tier.json', tier: 'daemon', daemonOwned: true });
    expect(f.resets).toEqual(['watchers.pollIntervalMs']);
  });

  test('a credential key is refused with the way to remove it and nothing is reset', async () => {
    const f = build({ secretKeys: ['cluster.secret'] });
    f.withBody({ key: 'cluster.secret' });
    const response = await f.handlers.postConfigReset(req());
    expect(response.status).toBe(400);
    const body = await response.json() as { code: string; error: string };
    expect(body.code).toBe('SECRET_CONFIG_KEY');
    expect(body.error).toContain('credentials.delete');
    expect(f.resets).toEqual([]);
  });

  test('refuses a non-admin, an unknown key, a missing key and a host that cannot reset', async () => {
    const denied = build({ admin: false });
    denied.withBody({ key: 'watchers.pollIntervalMs' });
    expect((await denied.handlers.postConfigReset(req())).status).toBe(403);
    expect(denied.resets).toEqual([]);

    const unknown = build({ invalid: ['nope.key'] });
    unknown.withBody({ key: 'nope.key' });
    expect((await unknown.handlers.postConfigReset(req())).status).toBe(400);

    const missing = build();
    missing.withBody({});
    expect((await missing.handlers.postConfigReset(req())).status).toBe(400);

    const cannot = build({ canReset: false });
    cannot.withBody({ key: 'watchers.pollIntervalMs' });
    const response = await cannot.handlers.postConfigReset(req());
    expect(response.status).toBe(409);
    expect((await response.json() as { code: string }).code).toBe('CONFIG_RESET_UNSUPPORTED');
    expect(cannot.config['watchers.pollIntervalMs']).toBe(5_000);
  });
});

test('config.reset is published as an admin write verb next to config.set', () => {
  const catalog = new GatewayMethodCatalog();
  expect(catalog.get('config.reset')).toMatchObject({ access: 'admin', scopes: ['write:config'], http: { method: 'POST', path: '/config/reset' } });
});
