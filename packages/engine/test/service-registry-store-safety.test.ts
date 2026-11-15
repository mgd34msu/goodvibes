/**
 * A services file that cannot be used says so instead of reading as "no such
 * service", a connection test never reports a credential-less request as a
 * healthy connection, and a stored subscription only overrides the services
 * whose auth is a bearer token.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../platform/src/platform/config/secrets.js';
import { ServiceRegistry } from '../platform/src/platform/config/service-registry.js';
import { SubscriptionManager } from '../platform/src/platform/config/subscriptions.js';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(servicesJson: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'gv-service-registry-')); dirs.push(root);
  const servicesPath = join(root, 'services.json');
  if (servicesJson !== null) writeFileSync(servicesPath, servicesJson);
  const secrets = new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), surfaceRoot: 'synthetic', policy: 'plaintext_allowed' });
  const subscriptions = new SubscriptionManager(join(root, 'subscriptions.json'));
  const registry = new ServiceRegistry(servicesPath, { secretsManager: secrets, subscriptionManager: subscriptions });
  return { registry, secrets, subscriptions };
}

test('a services file that is not JSON is reported as unusable, not as an unknown service', async () => {
  const { registry } = fixture('{bad');
  expect(registry.unreadableReason()).toContain('is not valid JSON');
  expect(await registry.resolveAuth('openai')).toBeNull();
  const result = await registry.testConnection('openai');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Service list unusable');
  expect(result.error).not.toBe('Unknown service');
});

test('a services file holding JSON null is unusable and does not throw from get()', () => {
  const { registry } = fixture('null');
  expect(registry.get('openai')).toBeNull();
  expect(registry.unreadableReason()).toContain('not a JSON object');
});

test('an absent services file is just an empty registry', async () => {
  const { registry } = fixture(null);
  expect(registry.unreadableReason()).toBeNull();
  expect((await registry.testConnection('openai')).error).toBe('Unknown service');
});

test('a service name that is an object prototype property is not a registered service', () => {
  const { registry } = fixture('{}');
  expect(registry.get('constructor')).toBeNull();
});

test('a bearer service whose token is missing is not reported as a working connection', async () => {
  const { registry } = fixture(JSON.stringify({ svc: { name: 'svc', baseUrl: 'https://svc.invalid', authType: 'bearer', tokenKey: 'unset-token' } }));
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
  const result = await registry.testConnection('svc');
  expect(result.ok).toBe(false);
  expect(result.error).toContain('credential');
  expect(requests).toBe(0);
});

test('a bearer service with its token present is tested with that token', async () => {
  const { registry, secrets } = fixture(JSON.stringify({ svc: { name: 'svc', baseUrl: 'https://svc.invalid', authType: 'bearer', tokenKey: 'svc-token' } }));
  await secrets.set('svc-token', 'present-token');
  let seen = null as string | null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen = new Headers(init?.headers).get('authorization');
    return new Response('ok', { status: 200 });
  }) as unknown as typeof fetch;
  const result = await registry.testConnection('svc');
  expect(result.ok).toBe(true);
  expect(seen).toBe('Bearer present-token');
});

test('a stored subscription does not replace the header an api-key service is configured to send', async () => {
  const { registry, secrets, subscriptions } = fixture(JSON.stringify({
    shared: { name: 'shared', authType: 'api-key', tokenKey: 'shared-key', apiKeyHeader: 'X-Custom-Key' },
    viaBearer: { name: 'viaBearer', authType: 'bearer', tokenKey: 'unused', providerId: 'shared' },
  }));
  await secrets.set('shared-key', 'the-api-key');
  subscriptions.saveSubscription({ provider: 'shared', accessToken: 'subscription-token', tokenType: 'Bearer', authMode: 'oauth', overrideAmbientApiKeys: true, createdAt: 1, updatedAt: 1 });
  expect(await registry.resolveAuth('shared')).toEqual({ 'X-Custom-Key': 'the-api-key' });
  // A bearer service still takes the subscription token for its provider.
  expect(await registry.resolveAuth('viaBearer')).toEqual({ Authorization: 'Bearer subscription-token' });
});
