/** UNRUN: actual ContractStore reads, original source retention and native archives. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractStore, ContractStoreVersionError, contractPath, contractsDir } from '../../sdk/src/platform/contract/store.js';
import { CURRENT_CONTRACT_SCHEMA_VERSION } from '../../sdk/src/platform/contract/types.js';
import { ownedContractCheckpointText, readOwnedContractCheckpoint, type OwnedContractCheckpointRead } from '../../sdk/src/platform/contract/owned-checkpoint-read.js';
import { captureQuarantineSource, type QuarantineSource } from '../../sdk/src/platform/utils/atomic-json-store.js';
import { makeContract } from './fixtures.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'contract-original-quarantine-')); roots.push(root);
  const contract = makeContract(), path = contractPath(root, contract.id);
  mkdirSync(join(path, '..'), { recursive: true });
  return { root, contract, path, store: new ContractStore({ projectRoot: root, sweepIntervalMs: 0 }),
    archives: () => readdirSync(join(path, '..')).filter(name => name.includes('.corrupt-') && !name.endsWith('.why')) };
}

test('a parser callback cannot quarantine a replacement checkpoint instead of the original read', () => {
  const f = fixture(), original = '{"schemaVersion":1,"contract":null}', replacement = '{"foreign":true}';
  writeFileSync(f.path, original); const prior = `${f.path}.unrecognized`; writeFileSync(prior, 'earlier forensic copy');
  const native = JSON.parse; let changed = false;
  const parse = spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
    const result: unknown = native(text, reviver);
    if (!changed && text === original) { changed = true; renameSync(f.path, `${f.path}.retained`); writeFileSync(f.path, replacement); }
    return result;
  });
  try { expect(() => f.store.load(f.contract.id)).toThrow(); } finally { parse.mockRestore(); }
  expect(changed).toBe(true); expect(readFileSync(f.path, 'utf8')).toBe(replacement);
  expect(readFileSync(`${f.path}.retained`, 'utf8')).toBe(original);
  expect(readFileSync(prior, 'utf8')).toBe('earlier forensic copy'); expect(f.archives()).toEqual([]);
});

test('invalid UTF-8 is preserved byte-for-byte with a native receipt and private permissions', () => {
  const f = fixture(), bytes = Buffer.from([0xff, 0xfe, 0x00]); writeFileSync(f.path, bytes);
  expect(f.store.load(f.contract.id)).toBeNull(); expect(existsSync(f.path)).toBe(false);
  const names = f.archives(); expect(names).toHaveLength(1);
  const archive = join(f.path, '..', names[0]!);
  expect(readFileSync(archive)).toEqual(bytes);
  expect(lstatSync(archive).mode & 0o777).toBe(0o600);
  expect(lstatSync(`${archive}.why`).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(`${archive}.why`, 'utf8'))).toMatchObject({ schema: 1, source: `${f.contract.id}.json`, archive: names[0], role: 'goodvibes-owned-quarantine' });
});

test('future historical namespace schemas are preserved even when their contract shape is unfamiliar', () => {
  const f = fixture(), path = join(contractsDir(f.root), `${f.contract.id}.json`);
  const text = JSON.stringify({ schemaVersion: CURRENT_CONTRACT_SCHEMA_VERSION, contract: { unfamiliar: true } });
  writeFileSync(path, text);
  expect(() => f.store.load(f.contract.id)).toThrow(ContractStoreVersionError);
  expect(readFileSync(path, 'utf8')).toBe(text); expect(readdirSync(contractsDir(f.root)).some(name => name.includes('.corrupt-'))).toBe(false);
});

test('native checkpoint receipts survive source descriptor close and retain actual alias / original file checks', () => {
  const f = fixture(), target = join(f.root, 'actual'), alias = join(f.root, 'alias');
  mkdirSync(target); symlinkSync(target, alias);
  const path = join(alias, 'checkpoint.json'), text = '{"original":true}'; writeFileSync(path, text);
  const source = captureQuarantineSource(path); if (!source) throw Error('Missing original source');
  const receipt = readOwnedContractCheckpoint(path, 'contract', source); source.close();
  // Reuse a native descriptor while the read receipt is retained: it must not
  // accidentally assert that newly opened descriptor as the old file.
  writeFileSync(join(target, 'other.json'), '{}');
  expect(ownedContractCheckpointText(receipt)).toBe(text);
  renameSync(alias, `${alias}.retained`); mkdirSync(alias); writeFileSync(join(alias, 'checkpoint.json'), text);
  expect(() => ownedContractCheckpointText(receipt)).toThrow();
});

test('a public borrowed source object and late WeakMap override cannot manufacture native checkpoint provenance', () => {
  const f = fixture(); writeFileSync(f.path, '{}'); let calls = 0;
  const fake = Object.freeze({ read() { calls++; return '{}'; }, assertCurrent() { calls++; }, close() {} }) as QuarantineSource;
  expect(() => readOwnedContractCheckpoint(f.path, 'contract', fake)).toThrow(); expect(calls).toBe(0);
  const fakeReceipt = Object.freeze({}) as OwnedContractCheckpointRead;
  const get = spyOn(WeakMap.prototype, 'get').mockImplementation(() => ({ text: 'forged', assertCurrent() {} }));
  let refused = false;
  try { ownedContractCheckpointText(fakeReceipt); } catch { refused = true; } finally { get.mockRestore(); }
  expect(refused).toBe(true);
});
