/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireAccountInboxIdentity, acquireOwnedTriageIdentity, resolveAccountInboxIdentity,
  type AccountInboxIdentity, type AccountInboxIdentityInput } from '../platform/src/platform/intake/providers/account-identity.js';
import { InboxCursorStore } from '../platform/src/platform/intake/cursor-store.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import { inboxTriage, TRIAGE_MODEL } from '../platform/src/platform/intake/triage/battery.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../platform/src/platform/runtime/self-update.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
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
  await mirror.init(); mirror.upsertItems([{ id: 'slack:umask', provider: 'slack', kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original protected preview', receivedAt: Date.now(), unread: true }]);
  await mirror.flush(); await mirror.close();
  expect(resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack)).toEqual(selected);
  const read = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await read.init(); try { expect(read.listItems({ limit: 1 })[0]?.bodyPreview).toBe('Original protected preview'); } finally { await read.close(); }
});

test('identity capability cannot be forged or borrowed across different account facts', async () => {
  const f = fixture(), identity = await acquireAccountInboxIdentity(f.owner, slack);
  expect(() => resolveAccountInboxIdentity({} as AccountInboxIdentity, slack)).toThrow();
  expect(() => resolveAccountInboxIdentity(identity, { ...slack, account: { ...slack.account, userId: 'U-ANOTHER' } })).toThrow();
  const another = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, { ...slack, account: { ...slack.account, workspaceId: 'T-ANOTHER' } }),
    { ...slack, account: { ...slack.account, workspaceId: 'T-ANOTHER' } });
  expect(another.scopeId).not.toBe(resolveAccountInboxIdentity(identity, slack).scopeId);
});

test.each([slack, email])('actual $provider historical mirror and triage rows remain reachable without recurring hash derivation', async input => {
  const f = fixture(), scope = oldScope(input), itemId = `${input.provider}:original`;
  expect(scope).toBe(input.provider === 'slack'
    ? 'abe9b1d8991935d465112e493d71d4c547c4049ae98550d7743b87e0c5ffc3bd'
    : 'dfd0dd989833e15eed31e450c1a0e766c0a03bc5f9701b922bc305c80c6ebfd8');
  const mirror = new InboxCursorStore(f.root, `inbox-${input.provider}-${scope}.sqlite`, { sweepIntervalMs: 0 });
  await mirror.init(); mirror.upsertItems([{ id: itemId, provider: input.provider, kind: 'dm', fromDigest: 'cafebabedeadbeef',
    subjectPreview: '', bodyPreview: 'Original protected preview', receivedAt: Date.now(), unread: true }]);
  await mirror.flush(); await mirror.close();
  const triageFileName = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', input.provider, scope])}.sqlite`;
  const oldTriage = new SqliteTriageStore(f.root, triageFileName);
  await oldTriage.commit([{ id: itemId, inputHash: 'a'.repeat(64), battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL, status: 'unavailable' }]);
  await oldTriage.close();
  const selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, input), input);
  expect(selected).toEqual({ scopeId: scope, mirrorFileName: `inbox-${input.provider}-${scope}.sqlite`, triageFileName });
  const reopened = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await reopened.init(); cleanup.push(() => reopened.close());
  expect(reopened.listItems({ limit: 10 })[0]?.bodyPreview).toBe('Original protected preview');
  const receipts = new SqliteTriageStore(f.root, selected.triageFileName); cleanup.push(() => receipts.close());
  expect((await receipts.readBatch([itemId])).get(itemId)?.latest.status).toBe('unavailable');
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, input), input)).toEqual(selected);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
});

test.each([slack, email])('an actual $provider historical receipt store remains discoverable even without its old mirror file', async input => {
  const f = fixture(), scope = oldScope(input);
  const triageFileName = `inbox-triage-${historicalDigest(['owned-inbox-triage-v1', input.provider, scope])}.sqlite`;
  const triage = new SqliteTriageStore(f.root, triageFileName);
  await triage.commit([{ id: `${input.provider}:receipt-only`, inputHash: 'a'.repeat(64), battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL, status: 'unavailable' }]);
  await triage.close();
  const selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, input), input);
  expect(selected.scopeId).toBe(scope); expect(selected.triageFileName).toBe(triageFileName);
});

test('generic triage default preserves actual old mirror/receipt filenames and uses opaque selectors for a fresh account', async () => {
  const f = fixture(), scope = historicalDigest(['owned-inbox-triage-v1', 'fixture', 'old-account']);
  const mirror = new InboxCursorStore(f.root, `inbox-owned-${scope}.sqlite`, { sweepIntervalMs: 0 });
  await mirror.init(); await mirror.flush(); await mirror.close();
  const historical = new SqliteTriageStore(f.root, `inbox-triage-${scope}.sqlite`);
  await historical.commit([{ id: 'fixture:old', inputHash: 'a'.repeat(64), battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL, status: 'unavailable' }]);
  await historical.close();
  const saved = await acquireOwnedTriageIdentity(f.owner, 'fixture', 'old-account');
  expect(saved.mirrorFileName).toBe(`inbox-owned-${scope}.sqlite`); expect(saved.triageFileName).toBe(`inbox-triage-${scope}.sqlite`);
  const clean = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    const fresh = await acquireOwnedTriageIdentity(clean.owner, 'fixture', 'new-account');
    expect(fresh.scopeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await acquireOwnedTriageIdentity(clean.owner, 'fixture', 'new-account')).toEqual(fresh);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
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

test('an actual older generic mirror and native mirror share receipts only for the exact same account', async () => {
  const f = fixture(), scope = oldScope(slack), generic = historicalDigest(['owned-inbox-triage-v1', 'slack', scope]);
  for (const name of [`inbox-slack-${scope}.sqlite`, `inbox-owned-${generic}.sqlite`]) {
    const store = new InboxCursorStore(f.root, name, { sweepIntervalMs: 0 });
    await store.init(); store.upsertItems([{ id: 'slack:old', provider: 'slack', kind: 'dm', fromDigest: 'cafebabedeadbeef',
      subjectPreview: '', bodyPreview: name, receivedAt: Date.now(), unread: true }]);
    await store.flush(); await store.close();
  }
  const triageFileName = `inbox-triage-${generic}.sqlite`, triage = new SqliteTriageStore(f.root, triageFileName);
  await triage.commit([{ id: 'slack:old', inputHash: 'a'.repeat(64), battery: inboxTriage.name, batteryVersion: inboxTriage.version, model: TRIAGE_MODEL, status: 'unavailable' }]);
  await triage.close();
  const native = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack);
  const selected = await acquireOwnedTriageIdentity(f.owner, 'slack', scope);
  expect(native.mirrorFileName).toBe(`inbox-slack-${scope}.sqlite`);
  expect(selected.mirrorFileName).toBe(`inbox-owned-${generic}.sqlite`);
  expect(selected.triageFileName).toBe(native.triageFileName);
  expect(await acquireOwnedTriageIdentity(f.owner, 'slack', scope)).toEqual(selected);
});

test('an orphan opaque mirror cannot mint a replacement mapping after registry loss', async () => {
  const f = fixture();
  const selected = resolveAccountInboxIdentity(await acquireAccountInboxIdentity(f.owner, slack), slack);
  const mirror = new InboxCursorStore(f.root, selected.mirrorFileName, { sweepIntervalMs: 0 });
  await mirror.init(); await mirror.flush(); await mirror.close(); unlinkSync(f.path);
  await expect(acquireAccountInboxIdentity(f.owner, slack)).rejects.toThrow('unavailable');
  expect(existsSync(f.path)).toBe(false);
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
