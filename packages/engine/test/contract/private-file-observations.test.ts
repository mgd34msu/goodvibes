/** Regression source intentionally unrun during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../_helpers/project-temp.js';
import { toJson } from '@goodvibes-jev/judgment';
import { contractWorkReceipts, workReceiptIdentity } from '../../platform/src/platform/contract/work-receipts.js';
import { currentFileObservations, currentFileMatchesText, isCurrentNativeFileObservation } from '../../platform/src/platform/contract/current-file-observations.js';
import { reviewedFileFromObservation, reviewedFileVersionState } from '../../platform/src/platform/contract/review-file-observations.js';
import { ContractStore, contractPath, contractsDir, serializeContract, deserializeContract } from '../../platform/src/platform/contract/store.js';
import { snapshotJudgmentInput } from '../../platform/src/platform/gate/judgment-input.js';
import { createNativeDataWriteOwner, assertNativeReaderCompatible, nativeReaderCapabilities } from '../../platform/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../../platform/src/platform/runtime/self-update.js';
import type { UnitCheck } from '../../platform/src/platform/contract/types.js';
import { makeContract, makeUnit } from './fixtures.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = makeProjectTempDir('private-contract-observation'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'report.md'); writeFileSync(path, 'Ready.\n');
  const file = currentFileObservations(root, ['report.md'], { includeText: true })[0]!;
  const descriptor = reviewedFileFromObservation(file); if (!descriptor) throw new Error('Native fixture read was not captured');
  const check: UnitCheck = { id: 'u1.k1', at: 1, trigger: 'completion', result: 'pass', quality: {}, decisionIds: ['native-unit-check'],
    goal: { verdict: 'met', probabilityUnmet: 0.1, outcome: 'act' }, evidenceDigest: 'checked-evidence', reviewedFiles: [descriptor] };
  const contract = makeContract({ projectRoot: root, reviewInventory: { paths: ['report.md'], source: 'filesystem', errors: [] },
    units: [makeUnit({ role: 'research', status: 'passed', files: ['report.md'], checks: [check] })] });
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 }); cleanup.push(() => store.dispose());
  return { root, path, file, descriptor, check, contract, store };
}

test('fresh reads and exact native text comparisons use no content SHA; copied labels cannot stand in for original bytes', () => {
  const root = makeProjectTempDir('sha-free-native-read'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'report.md'), 'Original bytes\n');
  const hash = spyOn(crypto, 'createHash');
  try {
    const file = currentFileObservations(root, ['report.md'])[0]!;
    expect(currentFileMatchesText(file, 'Original bytes\n')).toBe(true);
    expect(currentFileMatchesText(file, 'Different bytes\n')).toBe(false);
    expect(isCurrentNativeFileObservation(JSON.parse(JSON.stringify(file)))).toBe(false);
    expect(currentFileMatchesText(JSON.parse(JSON.stringify(file)), 'Original bytes\n')).toBe(false);
    expect(reviewedFileFromObservation(JSON.parse(JSON.stringify(file)))).toBeUndefined();
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
});

test('unchanged reads retain an owner-scoped label while observed A-to-B-to-A file versions never revive an earlier label', () => {
  const root = makeProjectTempDir('stable-native-read-label'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'report.md'), owner = {};
  const read = () => {
    const file = currentFileObservations(root, ['report.md'], { owner })[0];
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Missing native file observation');
    return file;
  };
  writeFileSync(path, 'A'); const first = read(), same = read();
  expect(first['observationId']).toBe(same['observationId']);
  writeFileSync(path, 'B'); const second = read();
  expect(currentFileMatchesText(first, 'A')).toBe(false);
  writeFileSync(path, 'A'); const third = read();
  expect(new Set([first['observationId'], second['observationId'], third['observationId']]).size).toBe(3);
  expect(currentFileMatchesText(first, 'A')).toBe(false);
  expect(currentFileMatchesText(third, 'A')).toBe(true);
});

test('actual owned checkpoint restart preserves unchanged refusal and repair source bindings without restoring byte proof from labels', () => {
  const f = fixture(), jsonPath = join(f.root, 'reference.json'), text = '{"files":[]}';
  writeFileSync(jsonPath, text);
  f.contract.units[0]!.readEvidence = [{ path: 'reference.json', contentKind: 'declared-reference', returnedContent: '1 | ' + text,
    returnedRanges: ['1-1'], returnedLines: 1 }];
  const observe = (contract: typeof f.contract) => currentFileObservations(f.root, ['report.md'], { owner: contract });
  const originalFiles = observe(f.contract);
  // Compare the actual native projections across owned restart. These local
  // values are not independently recorded completion/repair commitments.
  const expectedFiles = structuredClone(originalFiles);
  const repairIdentity = (contract: typeof f.contract) => {
    const value = toJson(workReceiptIdentity(contractWorkReceipts(contract, { readObservations: true })));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing native work receipt object');
    return value;
  };
  const expectedRepair = repairIdentity(f.contract);
  f.store.hold(f.contract); expect(f.store.write(f.contract.id)).toBe(true);
  const envelope = JSON.parse(readFileSync(contractPath(f.root, f.contract.id), 'utf8'));
  expect(envelope.nativeFileLabels.entries).toHaveLength(2);
  const restored = f.store.load(f.contract.id)!;
  expect(JSON.stringify(restored)).not.toContain('nativeFileLabels');
  expect(JSON.stringify(restored)).not.toContain('nativeFileObservation');
  const restoredFiles = observe(restored);
  expect(restoredFiles).toEqual(expectedFiles);
  expect(repairIdentity(restored)).toEqual(expectedRepair);
  expect(currentFileMatchesText(restoredFiles[0]!, 'Ready.\n')).toBe(true);
  expect(currentFileMatchesText(structuredClone(restoredFiles[0]!), 'Ready.\n')).toBe(false);
  // Public import cannot seed those labels, even from the same saved bytes.
  const imported = deserializeContract(JSON.stringify(envelope))!;
  expect(observe(imported)).not.toEqual(expectedFiles);
  // An identical-byte replacement cannot adopt the saved old observation label.
  const stage = join(f.root, 'replacement.md'); writeFileSync(stage, 'Ready.\n'); renameSync(stage, f.path);
  expect(observe(restored)).not.toEqual(expectedFiles);
});

test('changing source bytes with the same observation pointer and restored mtime cannot adopt replacement evidence', () => {
  const f = fixture(), before = statSync(f.path);
  writeFileSync(f.path, 'ALTERED'); utimesSync(f.path, before.atime, before.mtime);
  expect(isCurrentNativeFileObservation(f.file)).toBe(false);
  expect(currentFileMatchesText(f.file, 'ALTERED')).toBe(false);
  expect(currentFileMatchesText(f.file, 'Ready.\n')).toBe(false);
});

test('same-byte pathname replacement invalidates the original read and the earlier native review version', () => {
  const f = fixture(), stage = join(f.root, 'replacement.md'); writeFileSync(stage, 'Ready.\n'); renameSync(stage, f.path);
  expect(currentFileMatchesText(f.file, 'Ready.\n')).toBe(false);
  expect(reviewedFileVersionState(currentFileObservations(f.root, ['report.md'])[0]!, f.descriptor)).toBe('changed');
});

test('schema six persists private facts but keeps all runtime, latest-check and model projections descriptor-only across restart', () => {
  const f = fixture(); f.store.hold(f.contract); expect(f.store.write(f.contract.id)).toBe(true);
  const stored = JSON.parse(readFileSync(contractPath(f.root, f.contract.id), 'utf8'));
  expect(stored.schemaVersion).toBe(6);
  expect(stored.contract.units[0].checks[0].reviewedFiles[0]).toMatchObject({ nativeFileObservation: { version: 1, origin: 'native-host-filesystem' } });
  const reopened = new ContractStore({ projectRoot: f.root, sweepIntervalMs: 0 }); cleanup.push(() => reopened.dispose());
  const contract = reopened.load(f.contract.id)!;
  const restored = contract.units[0]!.checks[0]!.reviewedFiles![0]!;
  expect(Object.keys(restored).sort()).toEqual(['observationId', 'path']);
  expect(JSON.stringify(contract)).not.toContain('nativeFileObservation');
  expect(JSON.stringify(structuredClone(contract))).not.toContain('directories');
  expect(() => snapshotJudgmentInput({ latestCheck: contract.units[0]!.checks[0] })).not.toThrow();
  expect(reviewedFileVersionState(currentFileObservations(f.root, ['report.md'])[0]!, restored)).toBe('current');
  expect(reviewedFileVersionState(currentFileObservations(f.root, ['report.md'])[0]!, structuredClone(restored))).toBe('unverified');
  reopened.hold(contract); expect(reopened.write(contract.id)).toBe(true);
  expect(JSON.parse(readFileSync(contractPath(f.root, f.contract.id), 'utf8')).contract.units[0].checks[0].reviewedFiles[0].nativeFileObservation.origin).toBe('native-host-filesystem');
});

test('public JSON deserialization/import cannot mint native review provenance from a shaped saved record', () => {
  const f = fixture(), json = serializeContract(f.contract, 1)!;
  const foreign = deserializeContract(json)!;
  const reference = foreign.units[0]!.checks[0]!.reviewedFiles![0]!;
  expect(reviewedFileVersionState(f.file, reference)).toBe('unverified');
  expect(JSON.stringify(foreign)).not.toContain('nativeFileObservation');
  f.store.hold(foreign); expect(f.store.write(foreign.id)).toBe(true);
  const restored = f.store.load(foreign.id)!;
  expect(reviewedFileVersionState(f.file, restored.units[0]!.checks[0]!.reviewedFiles![0]!)).toBe('unverified');
  expect(JSON.parse(readFileSync(contractPath(f.root, f.contract.id), 'utf8')).contract.units[0].checks[0].reviewedFiles[0].nativeFileObservation.origin).toBe('unverified-import');
});

test('importing an old SHA review cannot launder it into an owned historical review after save and restart', () => {
  const f = fixture(), sha256 = 'a'.repeat(64);
  const old = { ...f.contract, schemaVersion: 5, units: [{ ...f.contract.units[0]!, checks: [{ ...f.check, reviewedFiles: [{ path: 'report.md', sha256 }] }] }] };
  const text = JSON.stringify({ schemaVersion: 5, writtenAt: 1, contract: old });
  expect(f.store.importContract(text)).toBe(true);
  const stored = JSON.parse(readFileSync(contractPath(f.root, old.id), 'utf8'));
  expect(stored.contract.units[0].checks[0].reviewedFiles[0].historicalReviewOrigin).toBe('unverified-import');
  const reloaded = f.store.load(old.id)!;
  expect(reviewedFileVersionState(f.file, reloaded.units[0]!.checks[0]!.reviewedFiles![0]!)).toBe('unverified');
});

test('a copied runtime descriptor cannot silently lose its required saved private bookkeeping', () => {
  const f = fixture();
  f.contract.units[0]!.checks[0] = { ...f.check, reviewedFiles: [structuredClone(f.descriptor)] };
  expect(serializeContract(f.contract, 1)).toBeNull();
});

test('checkpoint projection touches only actual unit/check slots and cannot dump private facts into unrelated model data', () => {
  const f = fixture();
  Reflect.set(f.contract, 'unrelatedRawModelData', { reviewedFiles: [f.descriptor] });
  const disk = JSON.parse(serializeContract(f.contract, 1)!);
  expect(disk.contract.units[0].checks[0].reviewedFiles[0]).toHaveProperty('nativeFileObservation');
  expect(disk.contract.unrelatedRawModelData.reviewedFiles[0]).not.toHaveProperty('nativeFileObservation');
  expect(JSON.stringify(f.contract)).not.toContain('nativeFileObservation');
});

test('actual schema-five SHA review records remain readable without rewriting their earlier check and require a fresh native observation instead of hashing', () => {
  const f = fixture(), sha256 = 'a'.repeat(64);
  const check = { ...f.check, reviewedFiles: [{ path: 'report.md', sha256 }] };
  const old = { ...f.contract, schemaVersion: 5, units: [{ ...f.contract.units[0]!, checks: [check] }] };
  mkdirSync(contractsDir(f.root), { recursive: true });
  const oldPath = join(contractsDir(f.root), `${old.id}.json`);
  const text = JSON.stringify({ schemaVersion: 5, writtenAt: 1, contract: old }); writeFileSync(oldPath, text);
  const loaded = f.store.load(old.id)!;
  expect(loaded.units[0]!.checks[0]).toEqual(check);
  expect(readFileSync(oldPath, 'utf8')).toBe(text);
  const reference = loaded.units[0]!.checks[0]!.reviewedFiles![0]!, current = currentFileObservations(f.root, ['report.md'])[0]!;
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(reviewedFileVersionState(current, reference)).toBe('unverified');
    expect(reviewedFileVersionState(current, reference)).toBe('unverified');
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); }
  f.store.hold(loaded); expect(f.store.write(loaded.id)).toBe(true);
  expect(readFileSync(oldPath, 'utf8')).toBe(text);
  const reloaded = f.store.load(loaded.id)!;
  expect(reviewedFileVersionState(current, reloaded.units[0]!.checks[0]!.reviewedFiles![0]!)).toBe('unverified');
});

test('the native checkpoint writer declares its format before creating any contract checkpoint file', () => {
  const f = fixture(); let declared = 0;
  const execPath = join(f.root, 'goodvibes'), writer = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  const store = new ContractStore({ projectRoot: f.root, sweepIntervalMs: 0, beforeWrite() {
    declared++; expect(() => readFileSync(contractPath(f.root, f.contract.id))).toThrow();
    writer.declare('contract-review-observations-v1');
  } }); cleanup.push(() => store.dispose());
  store.hold(f.contract); expect(store.write(f.contract.id)).toBe(true); expect(declared).toBe(1);
  const capabilities = nativeReaderCapabilities('3.1.2');
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { ...capabilities, formats: capabilities.formats.filter(format => format !== 'contract-review-observations-v1') })).toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
});
