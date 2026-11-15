/**
 * The files every surface writes (provider subscriptions, the shared settings
 * tier) are changed under one cross-process lock, a store that cannot be read
 * is never rewritten from empty, a rotating-token refresh never overwrites a
 * newer sign-in, and an unreadable safety setting refuses start instead of
 * quietly falling back to a weaker default.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionManager, type OAuthProviderConfig, type ProviderSubscription } from '../platform/src/platform/config/subscriptions.js';
import { refreshOpenAISubscriptionAfterRejection, resolveFreshOpenAIAccessToken } from '../platform/src/platform/config/subscription-auth.js';
import { syncFileLockPath, withSyncFileLock } from '../platform/src/platform/config/sync-file-lock.js';
import { holdProcessLock } from '../platform/src/platform/utils/process-lock.js';
import { persistSharedKey, raiseReaderFloorInFile, removeSharedKey } from '../platform/src/platform/config/shared-config-tier.js';
import { stripFrozenDefaults } from '../platform/src/platform/config/settings-io.js';
import { CONFIG_SCHEMA } from '../platform/src/platform/config/schema.js';
import { ingestSettingsFile, isSafetyGateConfigKey, SettingsIngestionRefusal } from '../platform/src/platform/config/settings-ingestion.js';
import { logger } from '../platform/src/platform/utils/logger.js';

const realFetch = globalThis.fetch;
const dirs: string[] = [];
const undo: Array<() => void> = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const restore of undo.splice(0)) restore();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-shared-store-')); dirs.push(dir);
  return dir;
}
function quiet(): void {
  for (const level of ['info', 'warn', 'error'] as const) {
    const spy = spyOn(logger, level).mockImplementation(() => {});
    undo.push(() => spy.mockRestore());
  }
}
function subscription(provider: string, overrides: Partial<ProviderSubscription> = {}): ProviderSubscription {
  return { provider, accessToken: `${provider}-access`, refreshToken: `${provider}-refresh`, tokenType: 'Bearer', authMode: 'oauth',
    overrideAmbientApiKeys: true, createdAt: 1, updatedAt: 1, ...overrides };
}

// -- the lock itself ---------------------------------------------------------

/** True while some holder has the lock for `target`: taking it here fails. */
function lockHeld(target: string): boolean {
  const probe = holdProcessLock(syncFileLockPath(target));
  probe?.release();
  return probe === null;
}

test('the lock is held while the operation runs and released after it, however it ends', () => {
  const target = join(tempDir(), 'file.json');
  expect(withSyncFileLock(target, () => lockHeld(target))).toBe(true);
  expect(lockHeld(target)).toBe(false);
  expect(() => withSyncFileLock(target, () => { throw new Error('boom'); })).toThrow('boom');
  expect(lockHeld(target)).toBe(false);
});

test('a nested call in the same process joins the lock instead of being refused by it', () => {
  const target = join(tempDir(), 'file.json');
  expect(withSyncFileLock(target, () => withSyncFileLock(target, () => 'inner'))).toBe('inner');
});

test('a change still lands when the lock cannot be taken', () => {
  quiet();
  const target = join(tempDir(), 'file.json');
  const other = holdProcessLock(syncFileLockPath(target));
  try {
    expect(withSyncFileLock(target, () => 'ran anyway')).toBe('ran anyway');
  } finally {
    other?.release();
  }
});

// -- the writers keep each other's changes ----------------------------------------

test('persistSharedKey, removeSharedKey and raiseReaderFloorInFile keep each other\'s keys', () => {
  quiet();
  const path = join(tempDir(), 'shared', 'settings.json');
  persistSharedKey(path, 'tts.voice', 'alloy');
  persistSharedKey(path, 'tts.speed', 1.5);
  expect(raiseReaderFloorInFile(path, '9.0.0', 'test')).toBe(true);
  removeSharedKey(path, 'tts.voice');
  const stored = JSON.parse(readFileSync(path, 'utf-8')) as { tts: unknown; $goodvibes: { minReaderVersion: string } };
  expect(stored.tts).toEqual({ speed: 1.5 });
  expect(stored.$goodvibes.minReaderVersion).toBe('9.0.0');
});

// -- an unreadable store is not an empty one -------------------------------------

test('a subscription store that cannot be read is not rewritten from empty', () => {
  const dir = tempDir();
  // A directory where the file belongs: the read fails with something other than "absent" or "corrupt".
  const path = join(dir, 'subscriptions.json');
  mkdirSync(path);
  const manager = new SubscriptionManager(path);
  expect(manager.get('a')).toBeNull();
  expect(manager.list()).toEqual([]);
  expect(() => manager.saveSubscription(subscription('a'))).toThrow();
  expect(() => manager.logout('a')).toThrow();
  expect(() => manager.savePending({ provider: 'a', state: 's', verifier: 'v', redirectUri: 'http://127.0.0.1/cb', createdAt: Date.now() })).toThrow();
});

test('a corrupt subscription store is quarantined and the write that follows still lands', () => {
  quiet();
  const dir = tempDir();
  const path = join(dir, 'subscriptions.json');
  writeFileSync(path, '{not json');
  const manager = new SubscriptionManager(path);
  manager.saveSubscription(subscription('a'));
  expect(manager.get('a')?.accessToken).toBe('a-access');
});

// -- a refresh never overwrites a newer record ------------------------------------

const refreshConfig: OAuthProviderConfig = { authUrl: 'https://auth.invalid/authorize', tokenUrl: 'https://auth.invalid/token', clientId: 'synthetic', redirectUri: 'http://127.0.0.1/cb' };

test('a refresh answered after another process signed in again returns that sign-in and keeps it', async () => {
  const path = join(tempDir(), 'subscriptions.json');
  const refreshing = new SubscriptionManager(path);
  const other = new SubscriptionManager(path);
  refreshing.saveSubscription(subscription('p', { expiresAt: Date.now() - 1000 }));
  globalThis.fetch = (async () => {
    other.saveSubscription(subscription('p', { accessToken: 'newer-access', refreshToken: 'newer-refresh', updatedAt: 5 }));
    return Response.json({ access_token: 'stale-answer', refresh_token: 'stale-refresh', token_type: 'Bearer', expires_in: 3600 });
  }) as unknown as typeof fetch;
  const result = await refreshing.refreshOAuthToken('p', refreshConfig);
  expect(result.accessToken).toBe('newer-access');
  expect(refreshing.get('p')?.refreshToken).toBe('newer-refresh');
});

test('a refresh keeps another provider that another process saved while it was in flight', async () => {
  const path = join(tempDir(), 'subscriptions.json');
  const refreshing = new SubscriptionManager(path);
  const other = new SubscriptionManager(path);
  refreshing.saveSubscription(subscription('p', { expiresAt: Date.now() - 1000 }));
  globalThis.fetch = (async () => {
    other.saveSubscription(subscription('q'));
    return Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 });
  }) as unknown as typeof fetch;
  await refreshing.refreshOAuthToken('p', refreshConfig);
  expect(refreshing.get('p')?.accessToken).toBe('fresh-access');
  expect(refreshing.get('q')?.accessToken).toBe('q-access');
});

function openaiFixture(): { manager: SubscriptionManager; other: SubscriptionManager } {
  const path = join(tempDir(), 'subscriptions.json');
  const manager = new SubscriptionManager(path);
  manager.saveSubscription(subscription('openai', { accessToken: 'old-access', refreshToken: 'old-refresh' }));
  return { manager, other: new SubscriptionManager(path) };
}

test('a refusal of the old refresh token does not mark a newer sign-in revoked', async () => {
  const { manager, other } = openaiFixture();
  globalThis.fetch = (async () => {
    other.saveSubscription(subscription('openai', { accessToken: 'newer-access', refreshToken: 'newer-refresh', updatedAt: 5 }));
    return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
  }) as unknown as typeof fetch;
  const outcome = await refreshOpenAISubscriptionAfterRejection(manager, 'old-access');
  expect(outcome).toEqual({ kind: 'refreshed', accessToken: 'newer-access' });
  expect(manager.get('openai')?.revokedAt).toBeUndefined();
});

test('a refusal of the refresh token the store still holds marks the session revoked', async () => {
  const { manager } = openaiFixture();
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as unknown as typeof fetch;
  expect(await refreshOpenAISubscriptionAfterRejection(manager, 'old-access')).toEqual({ kind: 'session-dead' });
  expect(manager.get('openai')?.revokedAt).toBeDefined();
});

test('a successful exchange after another sign-in does not overwrite that sign-in', async () => {
  const { manager, other } = openaiFixture();
  globalThis.fetch = (async () => {
    other.saveSubscription(subscription('openai', { accessToken: 'newer-access', refreshToken: 'newer-refresh', updatedAt: 5 }));
    return Response.json({ access_token: 'stale-access', refresh_token: 'stale-refresh', token_type: 'Bearer', expires_in: 3600 });
  }) as unknown as typeof fetch;
  const outcome = await refreshOpenAISubscriptionAfterRejection(manager, 'old-access');
  expect(outcome).toEqual({ kind: 'refreshed', accessToken: 'newer-access' });
  expect(manager.get('openai')?.refreshToken).toBe('newer-refresh');
});

test('concurrent recoveries share one request and all get the new token, which is stored', async () => {
  const { manager } = openaiFixture();
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return Response.json({ access_token: 'fresh-access', refresh_token: 'fresh-refresh', token_type: 'Bearer', expires_in: 3600 });
  }) as unknown as typeof fetch;
  const outcomes = await Promise.all([
    refreshOpenAISubscriptionAfterRejection(manager, 'old-access'),
    refreshOpenAISubscriptionAfterRejection(manager, 'old-access'),
  ]);
  expect(outcomes).toEqual([{ kind: 'refreshed', accessToken: 'fresh-access' }, { kind: 'refreshed', accessToken: 'fresh-access' }]);
  expect(requests).toBe(1);
  expect(manager.get('openai')?.refreshToken).toBe('fresh-refresh');
});

test('a session already marked revoked is reported dead without a request', async () => {
  const { manager } = openaiFixture();
  manager.saveSubscription(subscription('openai', { accessToken: 'old-access', refreshToken: 'old-refresh', revokedAt: 9 }));
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return new Response('{}', { status: 400 }); }) as unknown as typeof fetch;
  expect(await resolveFreshOpenAIAccessToken(manager)).toEqual({ kind: 'session-dead' });
  expect(requests).toBe(0);
});

// -- settings files --------------------------------------------------------------------

test('stripFrozenDefaults drops default-equal leaves, keeps changed and unknown ones, and keeps list settings explicit', () => {
  const mode = CONFIG_SCHEMA.find(setting => setting.key === 'permissions.mode')!;
  const listSetting = CONFIG_SCHEMA.find(setting => Array.isArray(setting.default) && !setting.key.includes('*'))!;
  const listPath = listSetting.key.split('.');
  const nested: Record<string, unknown> = {};
  let cursor = nested;
  for (const part of listPath.slice(0, -1)) { const next: Record<string, unknown> = {}; cursor[part] = next; cursor = next; }
  cursor[listPath[listPath.length - 1]!] = listSetting.default;

  const atDefault = stripFrozenDefaults({ permissions: { mode: mode.default }, custom: { kept: 1 } });
  expect(atDefault.changed).toBe(true);
  expect(atDefault.config).toEqual({ custom: { kept: 1 } });

  const changed = stripFrozenDefaults({ permissions: { mode: 'plan' } });
  expect(changed.changed).toBe(false);
  expect(changed.config).toEqual({ permissions: { mode: 'plan' } });

  expect(stripFrozenDefaults(structuredClone(nested)).config).toEqual(nested);
});

test.each([
  ['relay.requireStepUpForMutations', { relay: { requireStepUpForMutations: 'true' } }],
  ['conversationGate.mode', { conversationGate: { mode: 'Confirm-All' } }],
  ['fetch.blockedHosts', { fetch: { blockedHosts: 5 } }],
  ['sandbox.windowsMode', { sandbox: { windowsMode: 'Require-WSL' } }],
  ['storage.secretPolicy', { storage: { secretPolicy: 'require-secure' } }],
  ['runtime.toolBudget.enforced', { runtime: { toolBudget: { enforced: 'yes' } } }],
  ['runtime.toolBudget.maxCostUsd', { runtime: { toolBudget: { maxCostUsd: 'five' } } }],
])('an unreadable stored %s refuses to start rather than falling back to its weaker default', (key, raw) => {
  expect(isSafetyGateConfigKey(key)).toBe(true);
  const notices: string[] = [];
  expect(() => ingestSettingsFile(structuredClone(raw), '/synthetic/settings.json', { write: () => {}, onNotice: (entry) => notices.push(`${entry.key}:${entry.action}`) }))
    .toThrow(SettingsIngestionRefusal);
  expect(notices).toContain(`${key}:refused`);
});

test('readable values of those safety settings are accepted, and an unreadable ordinary key is still only skipped', () => {
  const ok = ingestSettingsFile({ relay: { requireStepUpForMutations: true }, conversationGate: { mode: 'confirm-all' } }, '/synthetic/settings.json', { write: () => {} });
  expect(ok.notices).toEqual([]);
  const skipped = ingestSettingsFile({ tts: { speed: 'fast' } }, '/synthetic/settings.json', { write: () => {} });
  expect(skipped.notices.map(entry => `${entry.key}:${entry.action}`)).toEqual(['tts.speed:skipped']);
});
