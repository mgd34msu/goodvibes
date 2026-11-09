/** Failure receipt migration regression source; executed only during qualification. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { checkTriageReceipt } from '../platform/src/platform/intake/triage/evidence.js';
import { readTriageMetadataBatch } from '../platform/src/platform/intake/triage/pipeline.js';
import { scoreInboxTriage } from '../platform/src/platform/intake/triage/scorer.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import type { TriageEvidence, TriageFailureReceipt, TriageReceipt } from '../platform/src/platform/intake/triage/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const item = (id = 'message-one') => ({ id, surface: 'synthetic', subject: 'Synthetic routine message', unread: true });
const answered = () => fakePort(name => noulAnswer(name.endsWith('urgency') ? .99 : .01));
const directories: string[] = [];
const stores: SqliteTriageStore[] = [];
function directory(): string { const value = makeProjectTempDir('triage-failed-bindings'); directories.push(value); return value; }
function store(root: string, beforeWrite?: (version?: 3) => void): SqliteTriageStore {
  const value = new SqliteTriageStore(root, undefined, beforeWrite); stores.push(value); return value;
}
async function settled(): Promise<TriageEvidence> {
  const receipt = (await scoreInboxTriage([item()], answered().port))[0];
  if (receipt?.status !== 'settled') throw new Error('The actual answered fixture must settle.');
  return receipt;
}
async function failed(): Promise<TriageFailureReceipt> {
  const receipt = (await scoreInboxTriage([item()]))[0];
  if (receipt?.receiptVersion !== 3) throw new Error('The actual unanswered fixture must produce a v3 failure.');
  return receipt;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(value => value.close()));
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('missing, cancelled, invalid, failed and held triage perform no input hashing; mixed settled items hash once', async () => {
  const hash = spyOn(crypto, 'createHash');
  try {
    const unavailable = await scoreInboxTriage([item()]);
    expect(unavailable[0]).toMatchObject({ receiptVersion: 3, status: 'unavailable' });
    expect(Object.hasOwn(unavailable[0]!, 'inputHash')).toBe(false);
    const controller = new AbortController(); controller.abort();
    const skipped = answered();
    expect((await scoreInboxTriage([item()], skipped.port, controller.signal))[0]?.status).toBe('unavailable');
    expect(skipped.requests).toHaveLength(0);
    const throws: JudgmentPort = { model: 'jev-latest', async ask() { throw new Error('Synthetic provider failure'); } };
    expect((await scoreInboxTriage([item()], throws))[0]?.status).toBe('unavailable');
    const malformed: JudgmentPort = { model: 'jev-latest', async ask() { return {} as never; } };
    expect((await scoreInboxTriage([item()], malformed))[0]?.status).toBe('unavailable');
    const held = fakePort(() => noulAnswer(.5));
    const [receipt] = await scoreInboxTriage([item()], held.port);
    expect(receipt).toMatchObject({ receiptVersion: 3, status: 'held' });
    expect(Object.hasOwn(receipt!, 'inputHash')).toBe(false);
    expect(checkTriageReceipt(receipt)).toEqual(receipt);
    const late = new AbortController(), lateAnswer = answered();
    const cancelDuring: JudgmentPort = { model: 'jev-latest', async ask(request) { late.abort(); return lateAnswer.port.ask(request); } };
    expect((await scoreInboxTriage([item()], cancelDuring, late.signal))[0]?.status).toBe('unavailable');
    expect(hash).not.toHaveBeenCalled();
    const mixed = fakePort(name => noulAnswer(name.startsWith('item0__') ? .5 : name.endsWith('urgency') ? .99 : .01));
    const receipts = await scoreInboxTriage([item('held'), item('settled')], mixed.port);
    expect(receipts.map(value => value.status)).toEqual(['held', 'settled']);
    expect(receipts.map(value => value.receiptVersion)).toEqual([3, 2]);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(mixed.requests).toHaveLength(1);
  } finally { hash.mockRestore(); }
});

test('strict v3 failures reject hashes, settled evidence and invented model/executable fields', async () => {
  const unavailable = await failed();
  const held = (await scoreInboxTriage([item()], fakePort(() => noulAnswer(.5)).port))[0]!;
  for (const invalid of [
    { ...unavailable, inputHash: undefined }, { ...unavailable, inputHash: '0'.repeat(64) },
    { ...unavailable, status: 'settled' }, { ...unavailable, model: 'jev-latest' },
    { ...unavailable, targetModel: 'jev-latest' }, { ...unavailable, extra: true },
    { ...held, actualModel: undefined }, { ...held, label: 'priority' }, { ...held, receiptVersion: 4 },
  ]) expect(() => checkTriageReceipt(invalid)).toThrow();
  expect(checkTriageReceipt(unavailable)).toEqual(unavailable);
  expect(checkTriageReceipt(held)).toEqual(held);
});

test('v3 failure publication withdraws current labels, preserves settled history and declares only its actual format', async () => {
  const root = directory(), versions: Array<3 | undefined> = [], owner = store(root, version => { versions.push(version); });
  const evidence = await settled(), failure = await failed();
  await owner.commit([evidence]);
  expect(versions).toEqual([undefined]);
  expect((await readTriageMetadataBatch([item()], owner)).get(item().id)?.label).toBe('priority');
  await owner.commit([failure]);
  expect(versions).toEqual([undefined, 3]);
  const bytes = readFileSync(owner.dbPath), reopened = store(root);
  expect((await reopened.readBatch([item().id])).get(item().id)).toEqual({ latest: failure, settled: evidence });
  const hash = spyOn(crypto, 'createHash');
  try { expect((await readTriageMetadataBatch([item()], reopened)).size).toBe(0); expect(hash).not.toHaveBeenCalled(); }
  finally { hash.mockRestore(); }
  expect(readFileSync(owner.dbPath)).toEqual(bytes);
});

test('actual saved v1/v2 failure bindings remain readable unchanged without a migration or format declaration', async () => {
  const evidence = await settled();
  const { id, inputHash, battery, batteryVersion, model, actualModel, targetModel } = evidence;
  if (!model || !actualModel || !targetModel) throw new Error('The actual v2 settled fixture must carry all model attribution.');
  const oldV1 = { id, inputHash, battery, batteryVersion, model: 'jev-latest', status: 'unavailable' as const };
  const oldV2 = { id, inputHash, battery, batteryVersion, model, actualModel, targetModel, receiptVersion: 2 as const, status: 'held' as const };
  const root = directory(), calls: Array<3 | undefined> = [], owner = store(root, version => { calls.push(version); });
  for (const original of [oldV1, oldV2]) {
    expect(checkTriageReceipt(original)).toEqual(original);
    await owner.commit([evidence, original]);
    const bytes = readFileSync(owner.dbPath);
    const opened = store(root, () => { throw new Error('A read must not publish a format.'); });
    expect((await opened.readBatch([id])).get(id)).toEqual({ latest: original, settled: evidence });
    expect((await readTriageMetadataBatch([item()], opened)).size).toBe(0);
    expect(readFileSync(owner.dbPath)).toEqual(bytes);
  }
  expect(calls).toEqual([undefined, undefined]);
});

test('a refused v3 floor leaves the previous DB and current settled label intact', async () => {
  const root = directory(), existing = store(root), evidence = await settled(), failure = await failed();
  await existing.commit([evidence]);
  const bytes = readFileSync(existing.dbPath), calls: Array<3 | undefined> = [];
  const refusing = store(root, version => { calls.push(version); throw new Error('Older native reader cannot read v3 failures'); });
  await expect(refusing.commit([failure])).rejects.toThrow('Older native reader');
  expect(calls).toEqual([3]);
  expect(readFileSync(existing.dbPath)).toEqual(bytes);
  expect((await readTriageMetadataBatch([item()], existing)).get(item().id)?.label).toBe('priority');
  expect(readdirSync(dirname(existing.dbPath))).toEqual(['inbox-triage.sqlite']);
});

for (const kind of ['fence', 'declaration'] as const) for (const mode of ['returned', 'thrown'] as const) {
  test(`a ${mode} rejected promise from the ${kind} is drained and cannot publish a v3 failure`, async () => {
    const root = directory(), existing = store(root), evidence = await settled(), failure = await failed();
    await existing.commit([evidence]);
    const bytes = readFileSync(existing.dbPath);
    let rejected: Promise<never> | undefined;
    const restriction = (): void => {
      rejected = Promise.reject(new Error('Synthetic invalid async restriction'));
      if (mode === 'thrown') throw rejected;
      return rejected as never;
    };
    const guarded = store(root, kind === 'declaration' ? restriction : undefined);
    const result = guarded.commit([failure], undefined, kind === 'fence' ? restriction : undefined);
    if (mode === 'thrown') await expect(result).rejects.toBeInstanceOf(Promise);
    else await expect(result).rejects.toThrow('must be synchronous');
    expect(rejected).toBeDefined();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(readFileSync(existing.dbPath)).toEqual(bytes);
    expect(readdirSync(dirname(existing.dbPath))).toEqual(['inbox-triage.sqlite']);
    expect((await existing.readBatch([item().id])).get(item().id)?.latest).toEqual(evidence);
  });
}

test('a rejected first v3 declaration creates no database receipt', async () => {
  const owner = store(directory(), () => { throw new Error('Unsupported reader'); });
  await expect(owner.commit([await failed()])).rejects.toThrow('Unsupported reader');
  expect(existsSync(owner.dbPath)).toBe(false);
  const rows: readonly TriageReceipt[] = [];
  await owner.commit(rows);
});
