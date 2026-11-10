/** Real native row generations, scoped mirrors and receipt images; synthetic model answers only. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { InboxCursorStore, captureInboxTriageSource } from '../platform/src/platform/intake/cursor-store.js';
import { captureTriageInputs, checkTriageReceipt } from '../platform/src/platform/intake/triage/evidence.js';
import { readTriageMetadataBatch, runInboxTriage } from '../platform/src/platform/intake/triage/pipeline.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import { triageSource } from './_helpers/triage-source.ts';
import type { TriageInput } from '../platform/src/platform/intake/triage/types.js';

const item = (): TriageInput => ({ id: 'synthetic:one', surface: 'synthetic', subject: 'Protected original subject', snippet: 'Protected original preview', conversationKind: 'direct', unread: true });
const model = () => fakePort(name => noulAnswer(name.endsWith('spam') ? .01 : .99));
const receipts: SqliteTriageStore[] = [];
afterEach(async () => { for (const store of receipts.splice(0)) await store.close(); });
function receiptStore(directory: string) { const store = new SqliteTriageStore(directory); receipts.push(store); return store; }

test('settled native receipts match unchanged and unrelated polls without a SHA or duplicate preview', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory), fake = model();
  const hashes = spyOn(crypto, 'createHash');
  try {
    const [receipt] = await runInboxTriage([original], { ...source.options, store, port: fake.port });
    expect(receipt).toMatchObject({ receiptVersion: 4, status: 'settled', source: { ...source.scope } });
    if (receipt?.status !== 'settled' || receipt.receiptVersion !== 4 || !receipt.source) throw new Error('Missing original native source binding');
    expect(receipt.source.sourceRevision).toMatch(/^ir-[0-9a-f]{32}$/);
    expect(Object.hasOwn(receipt, 'inputHash')).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(original.subject!); expect(JSON.stringify(receipt)).not.toContain(original.snippet!);
    source.update([original]); source.update([{ ...original, id: 'synthetic:unrelated', subject: 'Other current message' }]);
    expect((await readTriageMetadataBatch([original], store, source.scope, source.mirror)).get(original.id)).toEqual(receipt);
    expect(fake.requests).toHaveLength(1); expect(hashes).not.toHaveBeenCalled();
    const fields = readFileSync(store.dbPath); expect(fields.includes(Buffer.from(original.subject!))).toBe(false);
    expect(fields.includes(Buffer.from(original.snippet!))).toBe(false); expect(fields.includes(Buffer.from('inputHash'))).toBe(false);
  } finally { hashes.mockRestore(); }
});

for (const change of [{ subject: 'Changed subject' }, { snippet: 'Changed preview' }, { unread: false },
  { surface: 'other' }, { conversationKind: 'thread' as const }]) test(`native mutation of ${Object.keys(change)[0]} retires the old label`, async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory);
  await runInboxTriage([original], { ...source.options, store, port: model().port });
  const before = captureInboxTriageSource(source.mirror, captureTriageInputs([original]), source.scope).bindingFor(original.id);
  const changed = { ...original, ...change }; source.update([changed]);
  expect((await readTriageMetadataBatch([changed], store, source.scope, source.mirror)).size).toBe(0);
  const after = captureInboxTriageSource(source.mirror, captureTriageInputs([changed]), source.scope).bindingFor(original.id);
  expect(after?.sourceRevision).not.toBe(before?.sourceRevision);
});

test('native row revisions survive actual mirror restart, while another account cannot borrow them', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory);
  const [receipt] = await runInboxTriage([original], { ...source.options, store, port: model().port });
  if (receipt?.status !== 'settled' || receipt.receiptVersion !== 4 || !receipt.source) throw new Error('Restart fixture requires genuine settled native evidence');
  await source.mirror.flush(); await source.mirror.close();
  const restarted = new InboxCursorStore(source.directory, 'mirror.sqlite', { sweepIntervalMs: 0, triageScope: source.scope });
  try {
    await restarted.init();
    expect((await readTriageMetadataBatch([original], store, source.scope, restarted)).get(original.id)).toEqual(receipt);
    await expect(readTriageMetadataBatch([original], store, { ...source.scope, accountScopeId: 'another-account' }, restarted)).rejects.toThrow('original native mirror account');
  } finally { await restarted.close(); }
});

test('a changed then restored preview during judgment cannot publish an original receipt', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory), fake = model();
  await runInboxTriage([original], { ...source.options, store, port: fake.port }); const before = readFileSync(store.dbPath);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const port: JudgmentPort = { ...fake.port, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } };
  const work = runInboxTriage([original], { ...source.options, store, port });
  try {
    await Promise.race([entered.promise, work.then(() => { throw new Error('Scoring settled before held native input'); })]);
    source.update([{ ...original, snippet: 'Intervening protected preview' }]); source.update([original]); release.resolve();
    await expect(work).rejects.toThrow('native source changed');
    expect(readFileSync(store.dbPath)).toEqual(before);
    expect((await readTriageMetadataBatch([original], store, source.scope, source.mirror)).size).toBe(0);
  } finally { release.resolve(); await work.catch(() => undefined); }
});

test('copied or executable mirror-shaped objects cannot supply source provenance', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory), fake = model();
  let invoked = 0;
  for (const receiptSource of [{ ...source.mirror }, new Proxy({}, { get() { invoked++; throw new Error('Not a native source'); } })]) {
    await expect(runInboxTriage([original], { ...source.options, receiptSource, store, port: fake.port })).rejects.toThrow('original native mirror account');
  }
  expect(invoked).toBe(0); expect(fake.requests).toHaveLength(0); expect(existsSync(store.dbPath)).toBe(false);
});

test('strict v4 cannot carry an old hash, malformed source revision, held status or executable source fields', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory);
  const [receipt] = await runInboxTriage([original], { ...source.options, store, port: model().port });
  if (receipt?.status !== 'settled' || receipt.receiptVersion !== 4 || !receipt.source) throw new Error('Missing source-bound receipt');
  for (const invalid of [{ ...receipt, inputHash: undefined }, { ...receipt, status: 'held' },
    { ...receipt, source: { ...receipt.source, sourceRevision: 'not-a-native-row' } },
    { ...receipt, source: { ...receipt.source, sourceRevision: `${receipt.source.sourceRevision}\n` } },
    { ...receipt, source: { ...receipt.source, sourceRevision: `${receipt.source.sourceRevision}\r\n` } },
    { ...receipt, source: { ...receipt.source, extra: true } }]) {
    expect(() => checkTriageReceipt(invalid)).toThrow();
  }
  let invoked = 0;
  const sourceField = { ...receipt.source }; Object.defineProperty(sourceField, 'sourceRevision', { get() { invoked++; return receipt.source?.sourceRevision; } });
  expect(() => checkTriageReceipt({ ...receipt, source: sourceField })).toThrow(); expect(invoked).toBe(0);
});


test('a released native mirror cannot lend source provenance to a later matching read', async () => {
  const original = item(), source = await triageSource([original]), store = receiptStore(source.directory);
  await runInboxTriage([original], { ...source.options, store, port: model().port });
  const observed = captureInboxTriageSource(source.mirror, captureTriageInputs([original]), source.scope);
  await source.mirror.close();
  expect(() => observed.assertCurrent()).toThrow('native source is unavailable');
  await expect(readTriageMetadataBatch([original], store, source.scope, source.mirror)).rejects.toThrow('native source is unavailable');
});
