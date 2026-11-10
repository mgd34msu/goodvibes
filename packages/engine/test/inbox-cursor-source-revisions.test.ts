/** Original mirror schema migration and the actual native async image publisher. */
import { expect, spyOn, test } from 'bun:test';
import * as promises from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { InboxCursorStore, captureInboxTriageSource } from '../platform/src/platform/intake/cursor-store.js';
import { HandlerSqliteStore } from '../platform/src/platform/state/daemon-handler-sqlite-store.js';
import { loadSqlJsEngine } from '../platform/src/platform/state/sqlite-store.js';
import { captureTriageInputs } from '../platform/src/platform/intake/triage/evidence.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const item = { id: 'synthetic:one', surface: 'synthetic', subject: 'Protected subject', snippet: 'Protected preview', conversationKind: 'direct' as const, unread: true };
const scope = { providerId: 'synthetic', accountScopeId: 'native-account' };
const row = { id: item.id, provider: item.surface, kind: 'dm' as const, fromDigest: 'redacted-native-sender', subjectPreview: item.subject, bodyPreview: item.snippet, unread: item.unread, receivedAt: Date.now() };
const oldSchema = [`CREATE TABLE items (id TEXT PRIMARY KEY, provider TEXT NOT NULL, kind TEXT NOT NULL, fromDigest TEXT NOT NULL,
  subjectPreview TEXT NOT NULL, bodyPreview TEXT NOT NULL, routeId TEXT, receivedAt INTEGER NOT NULL, unread INTEGER NOT NULL)`];

async function legacyMirror() {
  const directory = makeProjectTempDir('inbox-original-source-schema-');
  const original = new HandlerSqliteStore({ workingDirectory: directory, fileName: 'mirror.sqlite', schema: oldSchema });
  try {
    await original.init(); original.run('INSERT INTO items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.surface, 'dm', 'redacted-native-sender', item.subject, item.snippet, null, Date.now(), 1]);
    await original.save(); return { directory, path: original.dbPath, bytes: readFileSync(original.dbPath) };
  } finally { original.close(); }
}

test('empty in-memory startup and close publish no mirror or native reader floor; first actual source write is fenced', async () => {
  const directory = makeProjectTempDir('inbox-empty-source-floor-'); let declarations = 0;
  const current = new InboxCursorStore(directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope,
    beforeSourceRevisionWrite() { declarations++; throw new Error('Original native installation cannot publish source revisions'); } });
  await current.init();
  expect(declarations).toBe(0); expect(existsSync(current.dbPath)).toBe(false);
  await current.flush(); expect(declarations).toBe(0);
  await current.close(); expect(declarations).toBe(0); expect(existsSync(current.dbPath)).toBe(false);
  const writer = new InboxCursorStore(directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope,
    beforeSourceRevisionWrite() { declarations++; throw new Error('Original native installation cannot publish source revisions'); } });
  await writer.init(); writer.upsertItems([row]);
  await expect(writer.flush()).rejects.toThrow('cannot publish source revisions');
  expect(declarations).toBeGreaterThan(0); expect(existsSync(writer.dbPath)).toBe(false);
  await expect(writer.close()).rejects.toThrow('cannot publish source revisions');
  expect(existsSync(writer.dbPath)).toBe(false);
});

test('a refused source floor leaves the genuine old mirror bytes untouched; an acknowledged migration retains original rows', async () => {
  const old = await legacyMirror();
  const refused = new InboxCursorStore(old.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope,
    beforeSourceRevisionWrite() { throw new Error('Native reader cannot retain source revisions'); } });
  await refused.init();
  expect(readFileSync(old.path)).toEqual(old.bytes);
  await expect(refused.flush()).rejects.toThrow('cannot retain source revisions');
  await expect(refused.close()).rejects.toThrow('cannot retain source revisions');
  expect(readFileSync(old.path)).toEqual(old.bytes);
  let declarations = 0;
  const current = new InboxCursorStore(old.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope, beforeSourceRevisionWrite() { declarations++; } });
  try {
    await current.init(); const binding = captureInboxTriageSource(current, captureTriageInputs([item]), scope).bindingFor(item.id);
    expect(binding).toMatchObject(scope); expect(binding?.sourceRevision).toMatch(/^ir-[0-9a-f]{32}$/);
    await current.flush(); expect(declarations).toBeGreaterThan(0);
    const SQL = await loadSqlJsEngine(), disk = new SQL.Database(readFileSync(old.path));
    try {
      expect(disk.exec('SELECT subjectPreview, bodyPreview FROM items')[0]?.values).toEqual([[item.subject, item.snippet]]);
      expect(disk.exec('SELECT version FROM inbox_source_revision_policy')[0]?.values).toEqual([[1]]);
      expect(disk.exec('SELECT triage_revision FROM items')[0]?.values).toEqual([[binding!.sourceRevision]]);
    } finally { disk.close(); }
  } finally { await current.close(); }
});

test('an existing source revision column without its writer policy cannot lend stale revisions', async () => {
  const old = await legacyMirror(), SQL = await loadSqlJsEngine(), disk = new SQL.Database(readFileSync(old.path));
  const unproven = 'ir-00000000000000000000000000000000';
  try {
    disk.run('ALTER TABLE items ADD COLUMN triage_revision TEXT');
    disk.run('UPDATE items SET triage_revision = ?', [unproven]);
    await promises.writeFile(old.path, disk.export());
  } finally { disk.close(); }
  const current = new InboxCursorStore(old.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope });
  try {
    await current.init();
    const binding = captureInboxTriageSource(current, captureTriageInputs([item]), scope).bindingFor(item.id);
    expect(binding?.sourceRevision).toMatch(/^ir-[0-9a-f]{32}$/); expect(binding?.sourceRevision).not.toBe(unproven);
    await current.flush(); const reopened = new SQL.Database(readFileSync(old.path));
    try {
      expect(reopened.exec('SELECT subjectPreview, bodyPreview FROM items')[0]?.values).toEqual([[item.subject, item.snippet]]);
      expect(reopened.exec('SELECT triage_revision FROM items')[0]?.values).toEqual([[binding!.sourceRevision]]);
    } finally { reopened.close(); }
  } finally { await current.close(); }
});

test('an unsupported source revision policy refuses every mutation and preserves its original bytes', async () => {
  const old = await legacyMirror(), SQL = await loadSqlJsEngine(), disk = new SQL.Database(readFileSync(old.path));
  try {
    disk.run('CREATE TABLE inbox_source_revision_policy (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL)');
    disk.run('INSERT INTO inbox_source_revision_policy VALUES (1, 2)');
    await promises.writeFile(old.path, disk.export());
  } finally { disk.close(); }
  const bytes = readFileSync(old.path), current = new InboxCursorStore(old.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope });
  await expect(current.init()).rejects.toThrow('source revisions are unsupported');
  expect(() => current.upsertItems([row])).toThrow('source revisions are unavailable');
  await current.close(); expect(readFileSync(old.path)).toEqual(bytes);
});

for (const mode of ['returned', 'thrown'] as const) test(`a ${mode} rejected native format callback is drained without changing the mirror`, async () => {
  const old = await legacyMirror();
  const current = new InboxCursorStore(old.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope,
    beforeSourceRevisionWrite() { const failed = Promise.reject(new Error('Synthetic async format refusal')); if (mode === 'thrown') throw failed; return failed as never; } });
  await current.init();
  expect(readFileSync(old.path)).toEqual(old.bytes);
  await expect(current.flush()).rejects.toBeDefined();
  await expect(current.close()).rejects.toBeDefined(); await Promise.resolve();
  expect(readFileSync(old.path)).toEqual(old.bytes);
});

test('format retirement after actual staged bytes are written prevents native rename and drains original handles', async () => {
  const directory = makeProjectTempDir('inbox-source-stage-floor-'); let written = false, refuse = false;
  const current = new InboxCursorStore(directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: scope,
    beforeSourceRevisionWrite() { if (refuse && written) throw new Error('Native source floor retired after write'); } });
  await current.init(); current.upsertItems([row]); await current.flush(); const before = readFileSync(current.dbPath);
  const originalOpen = promises.open, restores: Array<() => void> = [];
  const opened = spyOn(promises, 'open').mockImplementation(async (...args: Parameters<typeof promises.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).startsWith(current.dbPath + '.')) {
      const originalWrite = handle.writeFile.bind(handle);
      const write = spyOn(handle, 'writeFile').mockImplementation(async (...parts: Parameters<typeof handle.writeFile>) => { await originalWrite(...parts); written = true; });
      restores.push(() => write.mockRestore());
    }
    return handle;
  });
  try {
    current.upsertItems([{ ...row, bodyPreview: 'Changed protected preview' }]); refuse = true;
    await expect(current.flush()).rejects.toThrow('retired after write'); expect(written).toBe(true);
    expect(readFileSync(current.dbPath)).toEqual(before);
    await expect(current.close()).rejects.toThrow('retired after write');
    expect(readFileSync(current.dbPath)).toEqual(before);
  } finally { opened.mockRestore(); for (const restore of restores) restore(); }
});
