import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { resolveNativeHostCredential } from '../../runtime/client/native-host-credential.ts';
import { beginTuiHostPairing, completeTuiHostPairing, tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  let host = 'https://host.example:4443'; let enabled = true; let home = makeProjectTempDir('native-credential'); let broken = false;
  const options = { homeDirectory: () => home, configManager: { get: (key: string) => {
    if (broken) throw new Error('Fixture config unavailable');
    return key === 'daemon.enabled' ? enabled : key === 'controlPlane.publicBaseUrl' ? host : undefined;
  } } as unknown as ConfigManager };
  return { options, get home() { return home; }, set home(value: string) { home = value; }, get host() { return host; }, set host(value: string) { host = value; }, set enabled(value: boolean) { enabled = value; }, set broken(value: boolean) { broken = value; } };
}
async function seed(f: ReturnType<typeof fixture>) {
  await beginTuiHostPairing(f.home, f.host, { attemptId: 'attempt', name: 'Fixture', startedAt: 1 });
  await completeTuiHostPairing(f.home, f.host, 'attempt', { token: 'synthetic-read-only-token', tokenId: 'fixture-token', name: 'Fixture', createdAt: 2 });
}

test('passive missing resolution creates nothing and never borrows global, environment or Agent secrets', () => {
  const f = fixture(); expect(resolveNativeHostCredential(f.options).available).toBe(false); expect(existsSync(join(f.home, '.goodvibes'))).toBe(false);
  mkdirSync(join(f.home, '.goodvibes', 'daemon'), { recursive: true }); mkdirSync(join(f.home, '.goodvibes', 'agent', 'connected-host-pairings'), { recursive: true });
  const global = join(f.home, '.goodvibes', 'daemon', 'operator-tokens.json'); const agent = join(f.home, '.goodvibes', 'agent', 'connected-host-pairings', 'pairings.json');
  writeFileSync(global, JSON.stringify({ token: 'synthetic-global' })); writeFileSync(agent, JSON.stringify({ version: 1, records: [{ host: f.host, pairing: { status: 'paired', token: 'synthetic-agent', tokenId: 'other', name: 'Agent', createdAt: 1 } }] }));
  const env = process.env.GOODVIBES_DAEMON_TOKEN; const connected = process.env.GOODVIBES_CONNECTED_HOST_TOKEN;
  try {
    process.env.GOODVIBES_DAEMON_TOKEN = 'synthetic-env'; process.env.GOODVIBES_CONNECTED_HOST_TOKEN = 'synthetic-connected-env';
    const result = resolveNativeHostCredential(f.options); expect(result.available).toBe(false); expect(JSON.stringify(result)).not.toContain('synthetic');
    expect(existsSync(join(f.home, '.goodvibes', 'tui'))).toBe(false); expect(readFileSync(global, 'utf8')).toContain('synthetic-global'); expect(readFileSync(agent, 'utf8')).toContain('synthetic-agent');
  } finally {
    if (env === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = env;
    if (connected === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connected;
  }
});

test('captured exact-origin credentials preserve scope-neutral read resolution and invalidate semantic replacements', async () => {
  const f = fixture(); await seed(f); const initial = resolveNativeHostCredential(f.options);
  expect(initial).toMatchObject({ available: true, baseUrl: f.host, token: 'synthetic-read-only-token', expectedPrincipalId: 'pairing:fixture-token' });
  const path = tuiHostPairingStorePath(f.home); const before = readFileSync(path, 'utf8');
  expect(resolveNativeHostCredential(f.options)).toEqual(initial); expect(readFileSync(path, 'utf8')).toBe(before);
  const changed = JSON.parse(before); changed.records[0].pairing.createdAt++;
  writeFileSync(path, JSON.stringify(changed)); expect(resolveNativeHostCredential(f.options).identity).not.toBe(initial.identity);
  writeFileSync(path, before); expect(resolveNativeHostCredential(f.options).identity).not.toBe(initial.identity);
  for (const host of ['https://other.example:4443', 'http://host.example:4443', 'https://host.example:4444']) { f.host = host; expect(resolveNativeHostCredential(f.options).available).toBe(false); }
});

test('credential labels belong to their actual config owner and cannot survive an observed read failure', async () => {
  const f = fixture(); await seed(f);
  const initial = resolveNativeHostCredential(f.options);
  expect(initial.identity).not.toContain('synthetic'); expect(initial.identity).not.toContain(f.home); expect(initial.identity).not.toContain(f.host);
  const otherOwner = { get: f.options.configManager.get.bind(f.options.configManager) } as unknown as ConfigManager;
  const other = resolveNativeHostCredential({ ...f.options, configManager: otherOwner });
  expect(other.available).toBe(true); expect(other.identity).not.toBe(initial.identity);
  expect(resolveNativeHostCredential(f.options).identity).toBe(initial.identity);
  f.broken = true; expect(resolveNativeHostCredential(f.options).available).toBe(false);
  f.broken = false;
  const recovered = resolveNativeHostCredential(f.options);
  expect(recovered.available).toBe(true); expect(recovered.identity).not.toBe(initial.identity);
});

for (const host of ['https://host.example:4443///', ' https://host.example:4443', 'https://host.example:4443?x=1', 'https://user@host.example:4443', 'https://host.example:4443/path/..']) test(`explicit malformed origin is not normalized into credential authority: ${host}`, async () => {
  const f = fixture(); await seed(f); f.host = host; expect(resolveNativeHostCredential(f.options).available).toBe(false);
});

test('unknown, corrupt, disabled and different home all fail closed without fallback or mutation', async () => {
  const f = fixture(); await beginTuiHostPairing(f.home, f.host, { attemptId: 'unknown', name: 'Fixture', startedAt: 1 });
  const unknown = resolveNativeHostCredential(f.options); expect(unknown.available).toBe(false); if (!unknown.available) expect(unknown.reason).toContain('unknown');
  const path = tuiHostPairingStorePath(f.home); const before = readFileSync(path);
  f.enabled = false; expect(resolveNativeHostCredential(f.options).identity).not.toBe(unknown.identity); expect(readFileSync(path)).toEqual(before);
  f.enabled = true; writeFileSync(path, '{bad'); const corrupt = resolveNativeHostCredential(f.options); expect(corrupt.available).toBe(false); expect(readFileSync(path, 'utf8')).toBe('{bad');
  f.home = makeProjectTempDir('native-other-home'); expect(resolveNativeHostCredential(f.options).identity).not.toBe(corrupt.identity);
});


test('an operation-owned selection is independent of passive reads using another home', async () => {
  const f = fixture(); await seed(f);
  const owned = { ...f.options, observation: new OwnedSelectionObservation() };
  const first = resolveNativeHostCredential(owned);
  expect(first.available).toBe(true);
  const passive = resolveNativeHostCredential({ ...f.options, homeDirectory: makeProjectTempDir('unrelated-native-home') });
  expect(passive.available).toBe(false);
  expect(resolveNativeHostCredential(owned).identity).toBe(first.identity);
  expect(resolveNativeHostCredential(f.options).identity).not.toBe(first.identity);
});
