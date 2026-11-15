/** The credential an inbound adapter checks callers against: only a resolved value authorises, a broken one never falls through. */
import { afterEach, expect, test } from 'bun:test';
import { resolveSurfaceCredential, surfaceCredentialUnavailable } from '../platform/src/platform/adapters/surface-credential.js';

const ENV = 'GOODVIBES_TEST_SURFACE_CREDENTIAL';
afterEach(() => { delete process.env[ENV]; });

const config = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

test('a literal config value resolves; nothing configured anywhere is absent', async () => {
  expect(await resolveSurfaceCredential({ configManager: config({ k: 'literal-secret' }) }, { kind: 'config', key: 'k' }))
    .toEqual({ state: 'resolved', value: 'literal-secret' });
  expect(await resolveSurfaceCredential({ configManager: config({}) }, { kind: 'config', key: 'k' }, { kind: 'env', name: ENV }))
    .toEqual({ state: 'absent' });
});

test('a whitespace-only config value counts as configured and is unresolvable, never absent', async () => {
  expect(await resolveSurfaceCredential({ configManager: config({ k: '   ' }) }, { kind: 'config', key: 'k' }))
    .toEqual({ state: 'unresolvable', configKey: 'k' });
});

test('a config reference that resolves to nothing stops the walk instead of falling through to the environment', async () => {
  process.env[ENV] = 'stale-environment-value';
  const credential = await resolveSurfaceCredential(
    { configManager: config({ k: 'goodvibes://secrets/goodvibes/MISSING_KEY' }), secretsManager: { get: async () => null, getGlobalHome: () => undefined } as never },
    { kind: 'config', key: 'k' }, { kind: 'env', name: ENV });
  expect(credential).toEqual({ state: 'unresolvable', configKey: 'k' });
});

test('an empty config value is skipped, and the registry and the environment are tried in order', async () => {
  const registry = { resolveSecret: async (service: string) => (service === 'telegram' ? 'registry-secret' : null) };
  expect(await resolveSurfaceCredential({ configManager: config({}), serviceRegistry: registry },
    { kind: 'config', key: 'k' }, { kind: 'registry', service: 'telegram', field: 'signingSecret' }, { kind: 'env', name: ENV }))
    .toEqual({ state: 'resolved', value: 'registry-secret' });
  process.env[ENV] = 'env-secret';
  expect(await resolveSurfaceCredential({ configManager: config({}), serviceRegistry: registry },
    { kind: 'registry', service: 'other', field: 'signingSecret' }, { kind: 'env', name: ENV }))
    .toEqual({ state: 'resolved', value: 'env-secret' });
});

test('an unresolvable credential answers 503 without naming the config key', async () => {
  const response = surfaceCredentialUnavailable('telegram', { state: 'unresolvable', configKey: 'surfaces.telegram.webhookSecret' });
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain('surfaces.telegram.webhookSecret');
});
