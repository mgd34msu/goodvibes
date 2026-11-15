import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireAccountInboxIdentity, acquireOwnedTriageIdentity, resolveAccountInboxIdentity, resolveAccountInboxElectionScope,
  type AccountInboxIdentity, type AccountInboxIdentityInput } from '../platform/src/platform/intake/providers/account-identity.js';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.js';
import { inboxTriage, TRIAGE_MODEL } from '../platform/src/platform/intake/triage/battery.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { seedInboxRows } from './_helpers/inbox-seed.ts';
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const slack = { provider: 'slack', account: { workspaceId: 'T-PRIVATE-WORKSPACE', userId: 'U-PRIVATE-USER' } } as const;
const email = { provider: 'email', account: { host: 'private-mail.example.invalid', port: 993, username: 'private-user@example.invalid', mailbox: 'INBOX', security: 'tls' } } as const;
function fixture() {
  const root = makeProjectTempDir('account-inbox-identity'), directory = join(root, '.goodvibes', 'tui', 'operator');
  return { root, directory, path: join(directory, 'account-inbox-identities.json'), owner: { workingDirectory: root, assertCurrent() {} } };
}
const historicalDigest = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function oldScope(input: AccountInboxIdentityInput) {
  return input.provider === 'slack' ? historicalDigest(['slack-inbox', 1, input.account.workspaceId, input.account.userId])
    : historicalDigest(['email-inbox', 1, { host: input.account.host, username: input.account.username, mailbox: input.account.mailbox, port: input.account.port, security: input.account.security }]);
}

test.each([slack, email])('fresh $provider account selection is stable across reacquisition, private and SHA-free', async input => {
  const f = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    const first = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, input), input);
    const reopened = resolveAccountInboxIdentity(await acquireAccountInboxIdentity({ ...f.owner }, input), input);
    expect(reopened).toEqual(first);
    expect(first.scopeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.mirrorFileName).toBe(`inbox-${input.provider}-${first.scopeId}.sqlite`);
    expect(first.triageFileName).toMatch(/^inbox-triage-(slack|email)-[0-9a-f-]{36}\.sqlite$/);
    expect(JSON.stringify(first)).not.toContain(Object.values(input.account)[0]);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
});

test('a saved receipt selector cannot point at a preview mirror and is preserved for repair', async () => {
  const f = fixture();
  await acquireAccountInboxIdentity(f.owner, slack);
  const registry = JSON.parse(readFileSync(f.path, 'utf8')) as { scopes: { mirrorFileName: string; triageFileName: string }[] };
  const entry = registry.scopes[0]; if (!entry) throw new Error('Missing original account selector');
  entry.triageFileName = entry.mirrorFileName;
  writeFileSync(f.path, JSON.stringify(registry), { mode: 0o600 });
  const original = readFileSync(f.path);
  await expect(acquireAccountInboxIdentity(f.owner, slack)).rejects.toThrow('unavailable');
  expect(readFileSync(f.path)).toEqual(original);
});

test('first account initialization under restrictive umask publishes private managed directories and preserves actual data/selectors', async () => {
  const f = fixture(); let pending!: ReturnType<typeof acquireAccountInboxIdentity>;
  const mask = process.umask(0o777);
  try { pending = acquireAccountInboxIdentity(f.owner, slack); } finally { process.umask(mask); }
  const selected = resolveAccountInboxIdentity(await pending, slack);
  for (const path of [join(f.root, '.goodvibes'), join(f.root, '.goodvibes', 'tui'), f.directory]) expect(statSync(path).mode & 0o777).toBe(0o700);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  const mirror = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await mirror.init(); await seedInboxRows(mirror, [{ id: 'slack:umask', provider: 'slack', kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original protected preview', receivedAt: Date.now(), unread: true }]);
  await mirror.close();
  expect(resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack)).toEqual(selected);
  const read = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await read.init(); try { expect(read.listItems({ limit: 1 })[0]?.bodyPreview).toBe('Original protected preview'); } finally { await read.close(); }
});

test('owned triage cannot replace orphaned historical SQLite companions with an empty namespace', async () => {
  const f = fixture(), scope = historicalDigest(['owned-inbox-triage-v1', 'fixture', 'original-account']);
  mkdirSync(f.directory, { recursive: true, mode: 0o700 });
  const path = join(f.directory, `inbox-owned-${scope}.sqlite-wal`);
  writeFileSync(path, 'original owned-triage WAL', { mode: 0o600 });
  await expect(acquireOwnedTriageIdentity(f.owner, 'fixture', 'original-account')).rejects.toThrow('unavailable');
  expect(readFileSync(path, 'utf8')).toBe('original owned-triage WAL'); expect(existsSync(f.path)).toBe(false);
});

test.each([slack, email])('an existing $provider mapping refuses selected orphaned SQLite companions before returning its selector', async input => {
  const f = fixture(), selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, input), input);
  const registry = readFileSync(f.path), path = join(f.directory, `${selected.mirrorFileName}-shm`);
  writeFileSync(path, 'original selected-account SHM', { mode: 0o600 });
  await expect(acquireAccountInboxIdentity(f.owner, input)).rejects.toThrow('unavailable');
  expect(readFileSync(f.path)).toEqual(registry); expect(readFileSync(path, 'utf8')).toBe('original selected-account SHM');
  expect(existsSync(join(f.directory, selected.mirrorFileName))).toBe(false);
});

test('default triage reuses an already-owned native account without creating another namespace or hashing', async () => {
  const f = fixture();
  const selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack);
  const before = readFileSync(f.path), hash = spyOn(crypto, 'createHash');
  try {
    expect(await acquireOwnedTriageIdentity(f.owner, 'slack', selected.scopeId)).toEqual(selected);
    expect(readFileSync(f.path)).toEqual(before);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
});

test('an orphan opaque mirror cannot mint a replacement mapping after registry loss', async () => {
  const f = fixture();
  const selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack);
  const mirror = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await mirror.init();
  await seedInboxRows(mirror, [{ id: 'slack:orphan-original', provider: 'slack', kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original orphan preview', receivedAt: Date.now(), unread: true }]);
  await mirror.close();
  const mirrorPath = join(f.directory, selected.mirrorFileName), originalBytes = readFileSync(mirrorPath);
  unlinkSync(f.path);
  await expect(acquireAccountInboxIdentity(f.owner, slack)).rejects.toThrow('unavailable');
  expect(existsSync(f.path)).toBe(false);
  expect(readFileSync(mirrorPath)).toEqual(originalBytes);
});

test('physical registry replacement during before-write declaration is refused even for identical bytes', async () => {
  const f = fixture(); await acquireAccountInboxIdentity(f.owner, slack);
  const original = readFileSync(f.path);
  const owner = { ...f.owner, beforeWrite() { const path = `${f.path}.replacement`; writeFileSync(path, original, { mode: 0o600 }); renameSync(path, f.path); } };
  await expect(acquireAccountInboxIdentity(owner, email)).rejects.toThrow('unavailable');
  expect(readFileSync(f.path)).toEqual(original);
});

test('existing ancestor aliases are rejected before registry creation', async () => {
  const f = fixture(), outside = makeProjectTempDir('account-inbox-aliased');
  mkdirSync(join(f.root, '.goodvibes'), { mode: 0o700 });
  symlinkSync(outside, join(f.root, '.goodvibes', 'tui'));
  await expect(acquireAccountInboxIdentity(f.owner, slack)).rejects.toThrow('unavailable');
  expect(existsSync(join(outside, 'operator'))).toBe(false);
});

test.each(['account-inbox-identities-v1', 'inbox-triage-identities-v1'] as const)('native %s floor is published before selector data and blocks a same-version unsupported reader', async format => {
  const f = fixture(), execPath = join(f.root, 'goodvibes');
  const writer = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  const owner = { ...f.owner, beforeWrite() { expect(existsSync(f.path)).toBe(false); writer.declare(format); } };
  if (format === 'account-inbox-identities-v1') await acquireAccountInboxIdentity(owner, slack);
  else await acquireOwnedTriageIdentity(owner, 'fixture', 'account');
  const capabilities = nativeReaderCapabilities('3.1.2');
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, { ...capabilities, formats: capabilities.formats.filter(item => item !== format) })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
});


test.each([slack, email])('clustered $provider selection preserves the published distributed key once while mirror UUIDs stay node-local', async input => {
  const a = fixture(), b = fixture();
  const first = await acquireAccountInboxIdentity(a.owner, input), second = await acquireAccountInboxIdentity(b.owner, input);
  expect(resolveAccountInboxIdentity(first, input).scopeId).not.toBe(resolveAccountInboxIdentity(second, input).scopeId);
  const expected = input.provider === 'slack'
    ? 'abe9b1d8991935d465112e493d71d4c547c4049ae98550d7743b87e0c5ffc3bd'
    : 'dfd0dd989833e15eed31e450c1a0e766c0a03bc5f9701b922bc305c80c6ebfd8';
  const hash = spyOn(crypto, 'createHash');
  try {
    for (let repeat = 0; repeat < 5; repeat++) expect(resolveAccountInboxElectionScope(first)).toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    expect(resolveAccountInboxElectionScope(second)).toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
    expect(() => resolveAccountInboxElectionScope({ ...first } as AccountInboxIdentity)).toThrow();
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
    const changed: AccountInboxIdentityInput = input.provider === 'slack'
      ? { provider: 'slack', account: { ...input.account, userId: 'U-DIFFERENT-ACCOUNT' } }
      : { provider: 'email', account: { ...input.account, mailbox: 'Archive' } };
    expect(resolveAccountInboxElectionScope(await acquireAccountInboxIdentity(a.owner, changed))).not.toBe(expected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(3);
  } finally { hash.mockRestore(); }
});

test('an unrelated actual old mirror lookup shares its computed account codec with subsequent clustered selection', async () => {
  const f = fixture(), name = `inbox-slack-${'a'.repeat(64)}.sqlite`;
  const mirror = new InboxCursorStore(f.root, name, { sweepIntervalMs: 0 }); await mirror.init();
  await seedInboxRows(mirror, [{ id: 'slack:historical-other', provider: 'slack', kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original unrelated historical candidate', receivedAt: Date.now(), unread: true }]);
  await mirror.close();
  const original = readFileSync(join(f.directory, name)), hash = spyOn(crypto, 'createHash');
  try {
    const identity = await acquireAccountInboxIdentity(f.owner, slack);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    expect(resolveAccountInboxElectionScope(identity)).toBe('abe9b1d8991935d465112e493d71d4c547c4049ae98550d7743b87e0c5ffc3bd');
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    expect(resolveAccountInboxIdentity(identity, slack).mirrorFileName).not.toBe(name);
    expect(readFileSync(join(f.directory, name))).toEqual(original);
  } finally { hash.mockRestore(); }
});
