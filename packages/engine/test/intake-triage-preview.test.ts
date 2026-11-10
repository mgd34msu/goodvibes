/** Nonpersisted preview regressions; qualification runs separately. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { checkTriageReceipt } from '../platform/src/platform/intake/triage/evidence.js';
import { runInboxTriage } from '../platform/src/platform/intake/triage/pipeline.js';
import { SqliteTriageStore } from '../platform/src/platform/intake/triage/store.js';
import type { RunInboxTriageOptions, TriageStore } from '../platform/src/platform/intake/triage/types.js';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

const item = { id: 'preview-one', surface: 'synthetic', subject: 'Synthetic inbox preview' };
const answer = (probability = .01) => fakePort(() => noulAnswer(probability));
const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const release of close.splice(0).reverse()) await release(); });

test('literal and dynamic dry-run previews contain the same decisions without issuing a hash or reading storage', async () => {
  const fake = answer(), hashes = spyOn(crypto, 'createHash'); let storage = 0;
  try {
    const options: RunInboxTriageOptions = { dryRun: true, port: fake.port,
      get store(): TriageStore { storage++; throw new Error('Preview must not inspect a store'); },
      get receiptSource(): object { storage++; throw new Error('Preview must not issue a native receipt binding'); } };
    const [dynamic] = await runInboxTriage([item], options);
    const [literal] = await runInboxTriage([item], { dryRun: true, port: fake.port });
    expect(dynamic).toEqual(literal);
    expect(literal).toMatchObject({ id: item.id, status: 'settled', label: 'normal', score: .99 });
    expect(Object.hasOwn(literal!, 'inputHash')).toBe(false);
    expect(Object.hasOwn(literal!, 'receiptVersion')).toBe(false);
    expect(Object.isFrozen(literal)).toBe(true);
    expect(hashes).not.toHaveBeenCalled(); expect(storage).toBe(0);
    expect(fake.requests).toHaveLength(2);
  } finally { hashes.mockRestore(); }
});

test('preview shares actual settled math with persistent scoring without another preview commitment', async () => {
  let written = 0;
  const store: TriageStore = { async readBatch() { throw new Error('Not read'); }, async commit() { written++; }, async close() {} };
  const [receipt] = await runInboxTriage([item], { port: answer().port, store });
  if (!receipt) throw new Error('Actual settled receipt missing');
  const { inputHash, receiptVersion, ...decision } = receipt;
  expect(inputHash).toBeUndefined(); expect(Object.hasOwn(receipt, 'inputHash')).toBe(false); expect(receiptVersion).toBe(4); expect(written).toBe(1);
  const hashes = spyOn(crypto, 'createHash');
  try {
    const [preview] = await runInboxTriage([item], { dryRun: true, port: answer().port });
    expect(preview).toEqual(decision); expect(hashes).not.toHaveBeenCalled();
    expect(written).toBe(1);
  } finally { hashes.mockRestore(); }
});

test('held, unavailable and cancelled previews omit receipt fields and cannot be mistaken for persisted evidence', async () => {
  const root = makeProjectTempDir('triage-preview');
  const store = new SqliteTriageStore(root);
  close.push(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const stopped = new AbortController(); stopped.abort();
  const skipped = answer(), hashes = spyOn(crypto, 'createHash');
  try {
    const previews = [
      ...(await runInboxTriage([item], { dryRun: true, port: answer(.5).port })),
      ...(await runInboxTriage([item], { dryRun: true })),
      ...(await runInboxTriage([item], { dryRun: true, port: skipped.port, signal: stopped.signal })),
      ...(await runInboxTriage([item], { dryRun: true, port: answer().port })),
    ];
    expect(previews.map(value => value.status)).toEqual(['held', 'unavailable', 'unavailable', 'settled']);
    for (const preview of previews) {
      expect(Object.hasOwn(preview, 'inputHash')).toBe(false);
      expect(Object.hasOwn(preview, 'receiptVersion')).toBe(false);
      expect(() => checkTriageReceipt(preview)).toThrow();
      await expect(store.commit([preview as never])).rejects.toThrow();
    }
    expect(skipped.requests).toHaveLength(0); expect(hashes).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.goodvibes'))).toBe(false);
  } finally { hashes.mockRestore(); }
});
