/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { acquireDiscordInboxIdentity, acquireDiscordInboxRegistryRevision, resolveDiscordInboxIdentity, resolveDiscordInboxElectionScope,
  type DiscordInboxIdentity, type DiscordInboxIdentityInput } from '../platform/src/platform/intake/providers/discord-identity.js';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import { inboxTriage, TRIAGE_MODEL } from '../platform/src/platform/intake/triage/battery.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, NativeDataCompatibilityError } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const userId = '100000000000000001', channelId = '100000000000000002';
function input(channels: readonly string[] = [channelId], revision = 'fixture-registry'): DiscordInboxIdentityInput {
  return { account: { userId }, channels: { channelIds: channels, revision }, screening: { kind: 'hosted',
    authority: { kind: 'hosted', ownerId: 'fixture-grant', revision: 'fixture-grant-revision', retention: 'provider-managed-zero-retention-unverified', signal: new AbortController().signal, assertCurrent() {} },
    credentials: { abacusApiKey: 'fixture-private-abacus-key', typesafeApiKey: 'fixture-private-typesafe-key' } } };
}
function fixture() {
  const root = makeProjectTempDir('discord-native-identity'), directory = join(root, '.goodvibes', 'tui', 'operator');
  return { root, directory, path: join(directory, 'discord-inbox-identities.json'), owner: { workingDirectory: root, assertCurrent() {} } };
}
const oldDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
test('first Discord initialization under restrictive umask publishes private directories and preserves actual data/selectors', async () => {
  const f = fixture(), source = input(); let pending!: ReturnType<typeof acquireDiscordInboxIdentity>;
  const mask = process.umask(0o777);
  try { pending = acquireDiscordInboxIdentity(f.owner, source); } finally { process.umask(mask); }
  const selected = resolveDiscordInboxIdentity(await pending, source);
  for (const path of [join(f.root, '.goodvibes'), join(f.root, '.goodvibes', 'tui'), f.directory]) expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  const mirror = new InboxCursorStore(f.root, `inbox-discord-${selected.scopeId}.sqlite`, { sweepIntervalMs: 0 });
  await mirror.init(); mirror.upsertItems([{ id: 'discord:umask', provider: 'discord', kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original protected preview', receivedAt: Date.now(), unread: true }]);
  await mirror.flush(); await mirror.close();
  expect(resolveDiscordInboxIdentity(await acquireDiscordInboxIdentity(f.owner, source), source)).toEqual(selected);
  const read = new InboxCursorStore(f.root, `inbox-discord-${selected.scopeId}.sqlite`, { sweepIntervalMs: 0 });
  await read.init(); try { expect(read.listItems({ limit: 1 })[0]?.bodyPreview).toBe('Original protected preview'); } finally { await read.close(); }
});
function historicalScope(source: DiscordInboxIdentityInput, configured: boolean) {
  const ids = [...source.channels.channelIds].sort();
  const revision = configured ? oldDigest([source.account.userId, ids]) : source.channels.revision;
  return oldDigest(['discord-inbox-hosted', 1, source.account.userId, ids, revision,
    'abacus-route-llm+typesafe-jev-latest', 'provider-managed-zero-retention-unverified']);
}

test('fresh native scopes use persisted opaque IDs, private exact facts and stable ordering', async () => {
  const f = fixture(), source = input([channelId, '100000000000000003']);
  const revision = await acquireDiscordInboxRegistryRevision(f.owner, source.account, source.channels.channelIds);
  expect(revision).toMatch(/^[0-9a-f-]{36}$/);
  expect(await acquireDiscordInboxRegistryRevision(f.owner, source.account, [...source.channels.channelIds].reverse())).toBe(revision);
  const first = resolveDiscordInboxIdentity(await acquireDiscordInboxIdentity(f.owner, source), source);
  const reversed = { ...source, channels: { ...source.channels, channelIds: [...source.channels.channelIds].reverse() } };
  const second = resolveDiscordInboxIdentity(await acquireDiscordInboxIdentity(f.owner, reversed), reversed);
  expect(first).toEqual(second); expect(first.scopeId).toMatch(/^[0-9a-f-]{36}$/);
  expect(first.triageFileName).toMatch(/^inbox-triage-discord-[0-9a-f-]{36}\.sqlite$/);
  expect(JSON.stringify(first)).not.toContain(userId); expect(JSON.stringify(first)).not.toContain(channelId);
  expect(readFileSync(f.path, 'utf8')).not.toContain('fixture-private');
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
});

test('opaque identity capability cannot be supplied by wire fields or borrowed by another account', async () => {
  const f = fixture(), source = input(), identity = await acquireDiscordInboxIdentity(f.owner, source);
  expect(() => resolveDiscordInboxIdentity({} as DiscordInboxIdentity, source)).toThrow();
  expect(() => resolveDiscordInboxIdentity(identity, { ...source, account: { userId: '100000000000000099' } })).toThrow();
});

test.each([false, true])('actual saved hashed mirror and triage rows remain reachable (configured registry %s)', async configured => {
  const f = fixture(), source = input(), old = historicalScope(source, configured);
  const mirror = new InboxCursorStore(f.root, `inbox-discord-${old}.sqlite`, { sweepIntervalMs: 0 });
  await mirror.init(); mirror.upsertItems([{ id: 'discord:fixture:original', provider: 'discord', kind: 'dm', fromDigest: 'cafebabedeadbeef', subjectPreview: '', bodyPreview: 'Original protected preview', receivedAt: Date.now(), unread: true }]);
  await mirror.flush(); await mirror.close();
  const triageName = `inbox-triage-${oldDigest(['owned-inbox-triage-v1', 'discord', old])}.sqlite`;
  const historical = new SqliteTriageStore(f.root, triageName);
  await historical.commit([{ id: 'discord:fixture:original', inputHash: 'a'.repeat(64), battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL, status: 'unavailable' }]);
  await historical.close();
  const selected = configured ? { ...source, channels: { ...source.channels, revision: await acquireDiscordInboxRegistryRevision(f.owner, source.account, source.channels.channelIds) } } : source;
  const current = resolveDiscordInboxIdentity(await acquireDiscordInboxIdentity(f.owner, selected, { configuredRegistry: configured }), selected);
  expect(current).toEqual({ scopeId: old, triageFileName: triageName });
  const reopened = new InboxCursorStore(f.root, `inbox-discord-${current.scopeId}.sqlite`, { sweepIntervalMs: 0 });
  await reopened.init(); cleanups.push(() => reopened.close());
  expect(reopened.listItems({ limit: 10 })[0]?.bodyPreview).toBe('Original protected preview');
  const receipts = new SqliteTriageStore(f.root, current.triageFileName); cleanups.push(() => receipts.close());
  expect((await receipts.readBatch(['discord:fixture:original'])).get('discord:fixture:original')?.latest.status).toBe('unavailable');
  // The saved mapping survives reopening without deriving the historical filenames again.
  expect(resolveDiscordInboxIdentity(await acquireDiscordInboxIdentity(f.owner, selected, { configuredRegistry: configured }), selected)).toEqual(current);
});

test('missing identity registry with existing opaque mirrors holds without creating an empty replacement', async () => {
  const f = fixture(); mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  const orphan = join(f.directory, `inbox-discord-${randomUUID()}.sqlite`); writeFileSync(orphan, 'Original opaque mirror', { mode: 0o600 });
  await expect(acquireDiscordInboxIdentity(f.owner, input())).rejects.toThrow('unavailable');
  expect(existsSync(f.path)).toBe(false); expect(readFileSync(orphan, 'utf8')).toBe('Original opaque mirror');
});

test('physical registry replacement during publication is refused even when bytes are restored', async () => {
  const f = fixture(); await acquireDiscordInboxIdentity(f.owner, input());
  const before = readFileSync(f.path);
  const owner = { ...f.owner, beforeWrite() { const stage = `${f.path}.replacement`; writeFileSync(stage, before, { mode: 0o600 }); renameSync(stage, f.path); } };
  await expect(acquireDiscordInboxIdentity(owner, input(['100000000000000003']))).rejects.toThrow('unavailable');
  expect(readFileSync(f.path)).toEqual(before);
});

test('physical lock replacement with identical payload cannot authorize a registry publication', async () => {
  const f = fixture(), lock = `${f.path}.owner.lock`;
  const owner = { ...f.owner, beforeWrite() { const stage = `${lock}.replacement`; writeFileSync(stage, readFileSync(lock)); renameSync(stage, lock); } };
  await expect(acquireDiscordInboxIdentity(owner, input())).rejects.toMatchObject({ name: 'Error', message: 'Inbox native identity registry is unavailable' });
  expect(existsSync(f.path)).toBe(false); expect(existsSync(lock)).toBe(true);
});

test('actual native reader owner declares the new identity format before registry publication', async () => {
  const f = fixture(), execPath = join(f.root, 'goodvibes-daemon');
  const native = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  let declarations = 0;
  await acquireDiscordInboxIdentity({ ...f.owner, beforeWrite() {
    expect(existsSync(f.path)).toBe(false); native.declare('discord-inbox-identities-v1'); declarations++;
  } }, input());
  expect(declarations).toBe(1);
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { schema: 1, version: '3.1.2', formats: [] })).toThrow(NativeDataCompatibilityError);
});


test('an aliased existing ancestor is refused before creating a directory outside the workspace', async () => {
  const f = fixture(), outside = makeProjectTempDir('discord-identity-outside');
  symlinkSync(outside, join(f.root, '.goodvibes'));
  await expect(acquireDiscordInboxIdentity(f.owner, input())).rejects.toThrow('unavailable');
  expect(existsSync(join(outside, 'tui'))).toBe(false);
});

test.each(['symlink', 'hardlink'] as const)('registry %s cannot be admitted as the selected original file', async kind => {
  const f = fixture(); await acquireDiscordInboxIdentity(f.owner, input());
  const retained = `${f.path}.retained`; renameSync(f.path, retained);
  if (kind === 'symlink') symlinkSync(retained, f.path); else linkSync(retained, f.path);
  await expect(acquireDiscordInboxIdentity(f.owner, input())).rejects.toThrow('unavailable');
  expect(readFileSync(retained)).toEqual(readFileSync(f.path));
});

test('invalid UTF-8 registry bytes are rejected without rewriting the selected evidence', async () => {
  const f = fixture(); await acquireDiscordInboxIdentity(f.owner, input());
  const bytes = readFileSync(f.path), insertion = bytes.indexOf(Buffer.from('fixture-registry'));
  expect(insertion).toBeGreaterThan(0);
  const damaged = Buffer.concat([bytes.subarray(0, insertion), Buffer.from([0xff]), bytes.subarray(insertion)]);
  unlinkSync(f.path); writeFileSync(f.path, damaged, { mode: 0o600 });
  await expect(acquireDiscordInboxIdentity(f.owner, input())).rejects.toThrow('unavailable');
  expect(readFileSync(f.path)).toEqual(damaged);
});


test('simultaneous different scopes retain both admitted immutable selectors across registry appends', async () => {
  const f = fixture(), first = input(), second = input(['100000000000000003']);
  const [a, b] = await Promise.all([acquireDiscordInboxIdentity(f.owner, first), acquireDiscordInboxIdentity(f.owner, second)]);
  const original = resolveDiscordInboxIdentity(a, first), other = resolveDiscordInboxIdentity(b, second);
  expect(original.scopeId).not.toBe(other.scopeId);
  expect(resolveDiscordInboxIdentity(a, first)).toEqual(original);
});

test('simultaneous acquisitions of the same scope return one stable persisted selector', async () => {
  const f = fixture(), source = input();
  const [a, b] = await Promise.all([acquireDiscordInboxIdentity(f.owner, source), acquireDiscordInboxIdentity(f.owner, source)]);
  expect(resolveDiscordInboxIdentity(a, source)).toEqual(resolveDiscordInboxIdentity(b, source));
});


test('native Discord published bot/DM election key is shared across nodes and computed once per genuine selection', async () => {
  const a = fixture(), b = fixture(), source = input([channelId, '100000000000000003']);
  const first = await acquireDiscordInboxIdentity(a.owner, source, { configuredRegistry: true });
  const otherSource = { ...source, channels: { ...source.channels, channelIds: [...source.channels.channelIds].reverse(), revision: 'another-node-local-revision' } };
  const second = await acquireDiscordInboxIdentity(b.owner, otherSource, { configuredRegistry: true });
  expect(resolveDiscordInboxIdentity(first, source).scopeId).not.toBe(resolveDiscordInboxIdentity(second, otherSource).scopeId);
  // Independent deployed v3.1.1 codec, used by the actual wire comparison below.
  const expected = historicalScope(source, true), hash = spyOn(crypto, 'createHash');
  try {
    for (let repeat = 0; repeat < 5; repeat++) expect(resolveDiscordInboxElectionScope(first)).toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
    expect(resolveDiscordInboxElectionScope(second)).toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(4);
    expect(() => resolveDiscordInboxElectionScope({ ...first } as DiscordInboxIdentity)).toThrow();
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(4);
    const changed = input(['100000000000000099']);
    expect(resolveDiscordInboxElectionScope(await acquireDiscordInboxIdentity(a.owner, changed, { configuredRegistry: true }))).not.toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(6);
  } finally { hash.mockRestore(); }
});

test('an unrelated actual old Discord mirror lookup shares both deployed wire computations with the native clustered selection', async () => {
  const f = fixture(), source = input(), expected = historicalScope(source, true), name = `inbox-discord-${'a'.repeat(64)}.sqlite`;
  const mirror = new InboxCursorStore(f.root, name, { sweepIntervalMs: 0 }); await mirror.init(); await mirror.close();
  const original = readFileSync(join(f.directory, name)), hash = spyOn(crypto, 'createHash');
  try {
    const identity = await acquireDiscordInboxIdentity(f.owner, source, { configuredRegistry: true });
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
    expect(resolveDiscordInboxElectionScope(identity)).toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
    expect(resolveDiscordInboxIdentity(identity, source).scopeId).not.toBe('a'.repeat(64));
    expect(readFileSync(join(f.directory, name))).toEqual(original);
  } finally { hash.mockRestore(); }
});
