/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import { InboxCursorStore, INBOX_ITEM_TTL_MS, INBOX_ITEM_CAP } from '../platform/src/platform/intake/cursor-store.js';
import { createInactiveInboxRetentionOwner, type InactiveInboxRetentionOwner, type InactiveInboxSweep } from '../platform/src/platform/intake/inactive-retention.js';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.js';
import { createOwnedInboxSource } from '../platform/src/platform/intake/registration.js';
import { acquireCrossProcessLock } from '../platform/src/platform/state/durable-file-io.js';
import { acquireOwnedTriageIdentity } from '../platform/src/platform/intake/providers/account-identity.js';
import { fileURLToPath } from 'node:url';
import { tryAcquireCrossProcessLock } from '../platform/src/platform/workspace/checkpoint/cross-process-lock.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const clock = Date.parse('2026-11-08T12:00:00Z');

async function archivedDefault(root: string, historical = false) {
  const owner = { workingDirectory: root, assertCurrent() {} };
  // Published owned-inbox-triage-v1 tuple for fixture/default-retention-account.
  const mirrorFileName = historical ? 'inbox-owned-23c3d67ce110d2b3dd64b99e555cbe3fb1fcd05f1877fe83612b3aaee99296d7.sqlite'
    : (await acquireOwnedTriageIdentity(owner, 'fixture', 'default-retention-account')).mirrorFileName;
  const store = new InboxCursorStore(root, mirrorFileName, { now: () => 0, sweepIntervalMs: 0 });
  await store.init(); store.upsertItems([
    { id: 'fixture:old', provider: 'fixture', kind: 'dm', fromDigest: 'cafebabedeadbeef', subjectPreview: '', bodyPreview: 'Archived default preview', receivedAt: clock - INBOX_ITEM_TTL_MS - 1, unread: true },
    { id: 'fixture:recent', provider: 'fixture', kind: 'dm', fromDigest: 'cafebabedeadbeef', subjectPreview: '', bodyPreview: 'Current default preview', receivedAt: clock - 1, unread: true },
  ]);
  await store.flush(); await store.close();
  const selected = await acquireOwnedTriageIdentity(owner, 'fixture', 'default-retention-account');
  return { ...selected, path: store.dbPath, async count() {
    const read = new InboxCursorStore(root, selected.mirrorFileName, { now: () => 0, sweepIntervalMs: 0 });
    await read.init(); try { return read.countItems(); } finally { await read.close(); }
  } };
}

test('new opaque generic mirrors expire offline under their stored original retention policy', async () => {
  const root = makeProjectTempDir('inactive-default-opaque'), row = await archivedDefault(root);
  expect(row.mirrorFileName).toMatch(/^inbox-owned-[0-9a-f-]{36}\.sqlite$/);
  const owner = janitor(root); await owner.ready; await owner.close();
  expect(await row.count()).toBe(1);
});

test.each([false, true])('a separate actual default source owns the exact mirror/compatibility mutex and excludes cleanup (historical=%s)', async historical => {
  const root = makeProjectTempDir('inactive-default-cross-process'), row = await archivedDefault(root, historical);
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./_helpers/intake-default-owner-child.ts', import.meta.url)), root],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let ended = false;
  const finish = async () => { if (!ended) { ended = true; child.stdin.end(); } return child.exited; };
  cleanups.push(async () => { await finish(); });
  const reader = child.stdout.getReader();
  try {
    const message = await reader.read(); expect(new TextDecoder().decode(message.value)).toContain('ready');
    if (historical) {
      const original = tryAcquireCrossProcessLock(join(root, '.goodvibes', 'tui', 'operator', `inbox-triage-${row.scopeId}.sqlite.owner.lock`));
      try { expect(original).toBeNull(); } finally { original?.(); }
    }
    const before = readFileSync(row.path), owner = janitor(root); await owner.ready;
    expect((await owner.sweep()).busy).toBe(1); expect(readFileSync(row.path)).toEqual(before);
    expect(await finish()).toBe(0);
    expect((await owner.sweep()).expired).toBe(1); await owner.close();
    expect(await row.count()).toBe(1);
  } finally { reader.releaseLock(); await finish(); }
});
async function archived(root: string, provider: 'discord' | 'slack' | 'email', ttl = INBOX_ITEM_TTL_MS, cap = INBOX_ITEM_CAP) {
  const name = `inbox-${provider}-${provider === 'discord' ? randomUUID() : (provider === 'slack' ? 'a' : 'b').repeat(64)}.sqlite`;
  const store = new InboxCursorStore(root, name, { now: () => 0, sweepIntervalMs: 0, itemTtlMs: ttl, itemCap: cap });
  await store.init(); cleanups.push(() => store.close());
  store.upsertItems([
    { id: `${provider}:old`, provider, kind: 'dm', fromDigest: 'cafebabedeadbeef', subjectPreview: '', bodyPreview: 'Archived protected preview', receivedAt: clock - INBOX_ITEM_TTL_MS - 1, unread: true },
    { id: `${provider}:recent`, provider, kind: 'dm', fromDigest: 'cafebabedeadbeef', subjectPreview: '', bodyPreview: 'Current protected preview', receivedAt: clock - 1, unread: true },
  ]);
  await store.flush();
  return { store, name, path: store.dbPath, async count() {
    const reader = new InboxCursorStore(root, name, { now: () => 0, sweepIntervalMs: 0, itemTtlMs: ttl, itemCap: cap });
    await reader.init(); try { return reader.countItems(); } finally { await reader.close(); }
  } };
}
function janitor(root: string, report?: (result: InactiveInboxSweep) => void) {
  const owner = createInactiveInboxRetentionOwner({ workingDirectory: root, assertCurrent() {}, now: () => clock,
    historicalNativePolicy: { itemTtlMs: INBOX_ITEM_TTL_MS, itemCap: INBOX_ITEM_CAP }, ...(report ? { onSweep: report } : {}) });
  cleanups.push(() => owner.close()); return owner;
}

test('closed native account mirrors expire locally across all providers without calling a model or provider', async () => {
  const root = makeProjectTempDir('inactive-inbox-expiry');
  const stores = await Promise.all(['discord', 'slack', 'email'].map(provider => archived(root, provider as 'discord' | 'slack' | 'email')));
  await Promise.all(stores.map(row => row.store.close()));
  const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No remote work is authorized'));
  try {
    let result: InactiveInboxSweep | undefined; const owner = janitor(root, row => { result = row; }); await owner.ready;
    expect(result?.expired).toBe(3); expect(fetch).not.toHaveBeenCalled(); await owner.close();
    for (const row of stores) { expect(await row.count()).toBe(1); expect(statSync(row.path).mode & 0o777).toBe(0o600); }
  } finally { fetch.mockRestore(); }
});

test('a live in-process mirror reservation excludes cleanup until its actual close drains', async () => {
  const root = makeProjectTempDir('inactive-inbox-active'), row = await archived(root, 'discord');
  let result: InactiveInboxSweep | undefined; const owner = janitor(root, value => { result = value; }); await owner.ready;
  expect(result?.busy).toBe(1); expect(row.store.countItems()).toBe(2);
  await row.store.close(); const swept = await owner.sweep(); expect(swept.expired).toBe(1); await owner.close();
  expect(await row.count()).toBe(1);
});

test('the actual strict native mirror lock excludes a store even after a local reader has closed', async () => {
  const root = makeProjectTempDir('inactive-inbox-file-lock'), row = await archived(root, 'slack'); await row.store.close();
  const before = readFileSync(row.path), release = await acquireCrossProcessLock(`${row.path}.owner.lock`, { strictOwnership: true });
  try { const owner = janitor(root); await owner.ready; expect((await owner.sweep()).busy).toBe(1); await owner.close(); expect(readFileSync(row.path)).toEqual(before); }
  finally { release(); }
});

test('stored custom retention takes precedence over the native historical default', async () => {
  const root = makeProjectTempDir('inactive-inbox-custom'), row = await archived(root, 'email', INBOX_ITEM_TTL_MS * 3); await row.store.close();
  let result: InactiveInboxSweep | undefined; const owner = janitor(root, value => { result = value; }); await owner.ready; await owner.close();
  expect(result?.expired).toBe(0); expect(await row.count()).toBe(2);
});

test('empty unconfigured inboxes stay memory-only and an empty maintenance owner creates no storage', async () => {
  const root = makeProjectTempDir('inactive-inbox-empty'); const owner = janitor(root); await owner.ready; await owner.close();
  expect(existsSync(join(root, '.goodvibes'))).toBe(false);
  const store = new InboxCursorStore(root, undefined, { sweepIntervalMs: 0 }); await store.init(); await store.close();
  expect(existsSync(store.dbPath)).toBe(false);
});

test('bounded maintenance stops admitting pages as soon as its owner closes', async () => {
  const root = makeProjectTempDir('inactive-inbox-bounded');
  const rows = await Promise.all(['discord', 'slack', 'email'].map(provider => archived(root, provider as 'discord' | 'slack' | 'email')));
  await Promise.all(rows.map(row => row.store.close()));
  let owner: InactiveInboxRetentionOwner; let result: InactiveInboxSweep | undefined;
  owner = createInactiveInboxRetentionOwner({ workingDirectory: root, assertCurrent() {}, now: () => clock, maxFilesPerPass: 1,
    onSweep(value) { result = value; }, historicalNativePolicy: { itemTtlMs: INBOX_ITEM_TTL_MS, itemCap: INBOX_ITEM_CAP } });
  cleanups.push(() => owner.close()); await owner.ready; await owner.close();
  expect(result?.examined).toBe(1); expect(result?.more).toBe(true);
  await expect(owner.sweep()).rejects.toThrow('unavailable');
});


async function editImage(root: string, fileName: string, sql: string) {
  const database = new HandlerSqliteStore({ workingDirectory: root, fileName, schema: [] }); await database.init();
  try { database.run(sql); await database.save(); } finally { database.close(); }
}

test('a historical native mirror is expired only under the explicit native policy owner', async () => {
  const root = makeProjectTempDir('inactive-inbox-historical'), row = await archived(root, 'slack'); await row.store.close();
  await editImage(root, row.name, 'DROP TABLE inbox_retention_policy');
  const unknown = createInactiveInboxRetentionOwner({ workingDirectory: root, assertCurrent() {}, now: () => clock });
  cleanups.push(() => unknown.close()); await unknown.ready;
  expect((await unknown.sweep()).unknownPolicy).toBe(1); await unknown.close();
  const native = janitor(root); await native.ready; await native.close(); expect(await row.count()).toBe(1);
});

test('an unsupported custom policy is preserved and disclosed without resetting it to a default', async () => {
  const root = makeProjectTempDir('inactive-inbox-unsupported-policy'), row = await archived(root, 'email'); await row.store.close();
  await editImage(root, row.name, 'UPDATE inbox_retention_policy SET version = 99'); const before = readFileSync(row.path);
  let result: InactiveInboxSweep | undefined; const owner = janitor(root, value => { result = value; }); await owner.ready; await owner.close();
  expect(result?.unknownPolicy).toBe(1); expect(readFileSync(row.path)).toEqual(before);
  const reopened = new InboxCursorStore(root, row.name, { sweepIntervalMs: 0 }); cleanups.push(() => reopened.close());
  await expect(reopened.init()).rejects.toThrow('unsupported');
});

test('an admitted source read keeps its mirror excluded while source close is still draining', async () => {
  const root = makeProjectTempDir('inactive-inbox-held-read'), row = await archived(root, 'slack'); await row.store.close();
  const clockGuard = spyOn(Date, 'now').mockReturnValue(0);
  const source = createOwnedInboxSource({ workingDirectory: root, logger: { info() {}, warn() {}, error() {} } }, {
    storeFileName: row.name, skipInitialPoll: true, gatePolling() {},
    adapters: new Map([['slack', { id: 'slack', pollIntervalMs: 3_600_000, async poll() { throw new Error('No provider call is authorized'); } }]]),
  });
  cleanups.push(() => source.close());
  try { await source.ready; } finally { clockGuard.mockRestore(); }
  const read = await source.acquireRead(); let drained = false;
  const closing = source.close().then(() => { drained = true; });
  const owner = janitor(root); await owner.ready;
  expect(drained).toBe(false); expect((await owner.sweep()).busy).toBe(1);
  read.release(); await closing;
  expect((await owner.sweep()).expired).toBe(1); await owner.close(); expect(await row.count()).toBe(1);
});
