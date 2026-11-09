/** Regression source intentionally UNRUN during the coding-first pass. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { makeProjectTempDir } from '../_helpers/project-temp.js';
import { takeBaseline } from '../../sdk/src/platform/contract/group-runner.js';
import { baselineChangedPaths, baselinePathUnchanged, selectBaselineExecutionRoot, partitionBaselinePaths, releaseTreeBaselineBytes, retainOriginalTreeBaselines } from '../../sdk/src/platform/contract/tree-baseline.js';
import { ContractStore, contractPath, deserializeContract, deserializeOwnedContractCheckpoint, serializeContract } from '../../sdk/src/platform/contract/store.js';
import { readOwnedContractCheckpoint } from '../../sdk/src/platform/contract/owned-checkpoint-read.js';
import { snapshotDirtyTree, excludeUntouchedLaunchResidue, listDirtyTreePaths } from '../../sdk/src/platform/orchestration/dirty-guard.js';
import { captureDirtyFile, captureDirtyTreeRoot } from '../../sdk/src/platform/orchestration/dirty-file-observation.js';
import { makeContract, makeUnit } from './fixtures.js';
import type { TreeBaseline } from '../../sdk/src/platform/contract/types.js';
import { assertNativeReaderCompatible, createNativeDataWriteOwner, nativeReaderCapabilities } from '../../sdk/src/platform/runtime/native-reader-compatibility.js';
import { realUpdateFileIo } from '../../sdk/src/platform/runtime/update-file-io.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function fixture() {
  const root = makeProjectTempDir('owned-tree-baseline'); roots.push(root);
  git(root, 'init'); writeFileSync(join(root, 'tracked'), 'Committed original\n'); git(root, 'add', 'tracked');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed');
  const path = join(root, 'owner-dirty'); writeFileSync(path, 'Potentially-secret owner bytes\n');
  const baseline = takeBaseline(root)!;
  const contract = makeContract({ projectRoot: root, baseline, units: [makeUnit({ baseline })] });
  const store = new ContractStore({ projectRoot: root, sweepIntervalMs: 0 });
  store.hold(contract);
  return { root, path, baseline, contract, store };
}
function stored(f: ReturnType<typeof fixture>) {
  expect(f.store.write(f.contract.id)).toBe(true);
  return new ContractStore({ projectRoot: f.root, sweepIntervalMs: 0 }).load(f.contract.id)!;
}

test('ephemeral launch snapshots and path enumeration issue no SHA and expose no original bytes', () => {
  const f = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    const snapshot = snapshotDirtyTree(f.root);
    expect(JSON.stringify([...snapshot])).not.toContain('Potentially-secret');
    expect(listDirtyTreePaths(f.root)).toContain('owner-dirty');
    expect(excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], snapshot).excluded).toEqual(['owner-dirty']);
    copyFileSync(f.path, f.path + '.replacement'); renameSync(f.path + '.replacement', f.path);
    expect(excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], snapshot).excluded).toEqual(['owner-dirty']);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(() => excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], new Map(snapshot))).toThrow('snapshot is unavailable');
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('fresh baseline checks use original exact bytes and same-byte source replacement semantics without repeated SHA', () => {
  const f = fixture(), hash = spyOn(crypto, 'createHash');
  try {
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    copyFileSync(f.path, f.path + '.replacement'); renameSync(f.path + '.replacement', f.path);
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    writeFileSync(f.path, 'Actual unit work\n'); expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(false);
    writeFileSync(f.path, 'Potentially-secret owner bytes\n'); expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    const text = serializeContract(f.contract, 1)!; expect(text).not.toContain('Potentially-secret owner bytes');
    expect(text).toContain('file:');
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('actual owned checkpoint restore verifies the saved commitment once, then uses retained exact bytes', () => {
  const f = fixture(), restored = stored(f), hash = spyOn(crypto, 'createHash');
  try {
    const baseline = restored.baseline!;
    expect(baselinePathUnchanged(f.root, baseline, 'owner-dirty')).toBe(true);
    for (let index = 0; index < 4; index++) expect(baselinePathUnchanged(f.root, baseline, 'owner-dirty')).toBe(true);
    copyFileSync(f.path, f.path + '.replacement'); renameSync(f.path + '.replacement', f.path);
    expect(baselinePathUnchanged(f.root, baseline, 'owner-dirty')).toBe(true);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    expect(partitionBaselinePaths(f.root, ['owner-dirty', 'new-work'], baseline).included).toEqual(['new-work']);
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('a mismatching saved commitment is metered once per actual new physical version', () => {
  const f = fixture(), restored = stored(f); writeFileSync(f.path, 'Different unit version\n');
  const hash = spyOn(crypto, 'createHash');
  try {
    const baseline = restored.baseline!;
    for (let index = 0; index < 4; index++) expect(baselinePathUnchanged(f.root, baseline, 'owner-dirty')).toBe(false);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    writeFileSync(f.path, 'Another actual version\n'); expect(baselinePathUnchanged(f.root, baseline, 'owner-dirty')).toBe(false);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('public import and its later owned save cannot manufacture original baseline provenance', () => {
  const f = fixture(), imported = deserializeContract(serializeContract(f.contract, 1)!)!;
  expect(baselinePathUnchanged(f.root, imported.baseline!, 'owner-dirty')).toBeUndefined();
  expect(() => baselineChangedPaths(f.root, ['owner-dirty'], imported.baseline)).toThrow('cannot be verified');
  const replacement = new ContractStore({ projectRoot: f.root, sweepIntervalMs: 0 });
  replacement.hold(imported); expect(replacement.write(imported.id)).toBe(true);
  const reloaded = replacement.load(imported.id)!;
  expect(baselinePathUnchanged(f.root, reloaded.baseline!, 'owner-dirty')).toBeUndefined();
  expect(JSON.parse(readFileSync(contractPath(f.root, imported.id), 'utf8')).treeBaselineOrigins.entries[0].origin).toBe('unverified-import');
  replacement.dispose(); f.store.dispose();
});

test('actual durable-admission checkpoint reads retain provenance while public parsing does not', () => {
  const f = fixture(), text = serializeContract(f.contract, 1)!, path = join(f.root, 'durable-receipt.json');
  writeFileSync(path, JSON.stringify({ checkpoint: text }));
  const restored = deserializeOwnedContractCheckpoint(readOwnedContractCheckpoint(path, 'durable-admission'))!;
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-dirty')).toBe(true);
  const copy = deserializeContract(text)!; retainOriginalTreeBaselines(f.contract, copy);
  expect(copy.baseline).not.toBe(f.baseline); expect(baselinePathUnchanged(f.root, copy.baseline!, 'owner-dirty')).toBe(true);
  f.store.dispose();
});

test('saved symlink state compares link text without reading or exposing external target bytes', () => {
  const f = fixture(), outside = makeProjectTempDir('external-baseline-source'), external = join(outside, 'external-target'), link = join(f.root, 'owner-link'); roots.push(outside);
  writeFileSync(external, 'Never include this external target secret in the baseline'); symlinkSync(external, link);
  const baseline = takeBaseline(f.root)!; f.contract.baseline = baseline;
  const restored = stored(f);
  writeFileSync(external, 'Changed target bytes do not change the symbolic link');
  expect(baselinePathUnchanged(f.root, baseline, 'owner-link')).toBe(true);
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-link')).toBe(true);
  unlinkSync(link); symlinkSync('different-target', link);
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-link')).toBe(false);
  expect(readFileSync(contractPath(f.root, f.contract.id), 'utf8')).not.toContain('Never include this external target secret');
  f.store.dispose();
});

test('confirmed v2 deletion survives restart while unsupported directory reads never become deletion', () => {
  const f = fixture(); unlinkSync(join(f.root, 'tracked')); f.contract.baseline = takeBaseline(f.root)!;
  const restored = stored(f), baseline = restored.baseline!;
  expect(baseline.dirty['tracked']).toBeNull(); expect(baselinePathUnchanged(f.root, baseline, 'tracked')).toBe(true);
  mkdirSync(join(f.root, 'tracked'));
  expect(captureDirtyFile(f.root, 'tracked').kind).toBe('unavailable');
  expect(baselinePathUnchanged(f.root, baseline, 'tracked')).toBeUndefined();
  expect(partitionBaselinePaths(f.root, ['tracked'], baseline).uncertain).toEqual(['tracked']);
  expect(() => baselineChangedPaths(f.root, ['tracked'], baseline)).toThrow('cannot be verified');
  f.store.dispose();
});

test('owned historical ordinary-file commitments remain compatible; old ambiguous null and symlink records remain uncertain', () => {
  const f = fixture(), digest = crypto.createHash('sha256').update(readFileSync(f.path)).digest('hex');
  symlinkSync('owner-dirty', join(f.root, 'old-link'));
  const legacy: TreeBaseline = { head: f.baseline.head, dirty: {
    'owner-dirty': digest, 'old-link': digest, deleted: null,
  } };
  f.contract.baseline = legacy;
  const path = contractPath(f.root, f.contract.id); mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 6, writtenAt: 1, contract: f.contract }));
  const restored = f.store.load(f.contract.id)!;
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-dirty')).toBe(true);
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'deleted')).toBeUndefined();
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'old-link')).toBeUndefined();
  unlinkSync(f.path); symlinkSync('missing-external-target', f.path);
  expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-dirty')).toBe(false);
  f.store.dispose();
});


test('failed Git state and non-UTF-8 paths cannot become a clean launch that authorizes owner commits', () => {
  const f = fixture();
  renameSync(join(f.root, '.git'), join(f.root, '.git.saved')); writeFileSync(join(f.root, '.git'), 'not a Git repository marker');
  const unavailable = snapshotDirtyTree(f.root);
  expect(() => excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], unavailable)).toThrow('snapshot is unavailable');
  unlinkSync(join(f.root, '.git')); renameSync(join(f.root, '.git.saved'), join(f.root, '.git'));
  const ambiguous = Buffer.concat([Buffer.from(f.root + '/owner-'), Buffer.from([255])]); writeFileSync(ambiguous, 'Private ambiguous path');
  expect(() => listDirtyTreePaths(f.root)).toThrow();
  expect(() => excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], snapshotDirtyTree(f.root))).toThrow('snapshot is unavailable');
  f.store.dispose();
});

test('a symlinked parent is unavailable rather than following it into another tree', () => {
  const f = fixture(), outside = makeProjectTempDir('baseline-parent-target'); roots.push(outside);
  writeFileSync(join(outside, 'secret'), 'Outside source contents'); symlinkSync(outside, join(f.root, 'alias'));
  expect(captureDirtyFile(f.root, 'alias/secret').kind).toBe('unavailable'); f.store.dispose();
});

test('mutating the public snapshot map cannot erase a privately retained owner baseline', () => {
  const f = fixture(), snapshot = snapshotDirtyTree(f.root);
  (snapshot as Map<string, unknown>).clear();
  expect(excludeUntouchedLaunchResidue(f.root, ['owner-dirty'], snapshot).excluded).toEqual(['owner-dirty']); f.store.dispose();
});


test('Git executable-bit changes on existing dirty content are real v2 work, without repeat hashing', () => {
  const f = fixture(), restored = stored(f), hash = spyOn(crypto, 'createHash');
  try {
    expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-dirty')).toBe(true);
    const before = hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256').length;
    chmodSync(f.path, 0o755);
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(false);
    expect(baselinePathUnchanged(f.root, restored.baseline!, 'owner-dirty')).toBe(false);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(before);
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('nested attempt baselines restore their actual captured item root rather than the contract branch', () => {
  const f = fixture(), item = join(f.root, '.goodvibes', 'member'); mkdirSync(item, { recursive: true }); git(item, 'init');
  writeFileSync(join(item, 'attempt-dirty'), 'Attempt owner state');
  const attempt = makeUnit({ id: 'u1.a1', baseline: takeBaseline(item)! }); f.contract.units[0]!.attemptUnits = [attempt];
  const restored = stored(f), baseline = restored.units[0]!.attemptUnits![0]!.baseline!;
  expect(baselinePathUnchanged(item, baseline, 'attempt-dirty')).toBe(true);
  expect(baselinePathUnchanged(f.root, baseline, 'attempt-dirty')).toBeUndefined();
  const copied = deserializeContract(serializeContract(f.contract, 1)!)!;
  retainOriginalTreeBaselines(f.contract, copied);
  expect(copied.units[0]!.attemptUnits![0]!.baseline).not.toBe(attempt.baseline);
  expect(baselinePathUnchanged(item, copied.units[0]!.attemptUnits![0]!.baseline!, 'attempt-dirty')).toBe(true);
  f.store.dispose();
});

test('only an owned historical unit can bind its previously unrecorded root through executor restoration', () => {
  const f = fixture(), item = join(f.root, '.goodvibes', 'historical-item'); mkdirSync(item, { recursive: true });
  writeFileSync(join(item, 'attempt-dirty'), 'Historical original bytes');
  const baseline: TreeBaseline = { head: null, dirty: { 'attempt-dirty': crypto.createHash('sha256').update('Historical original bytes').digest('hex') } };
  f.contract.units[0]!.baseline = baseline;
  const text = JSON.stringify({ schemaVersion: 6, writtenAt: 1, contract: f.contract }), path = contractPath(f.root, f.contract.id);
  mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text);
  const restored = f.store.load(f.contract.id)!, owned = restored.units[0]!.baseline!;
  expect(baselinePathUnchanged(item, owned, 'attempt-dirty')).toBeUndefined();
  // An owned save before engine restore must preserve pending historical
  // context without converting that missing root into a guessed branch.
  f.store.hold(restored); expect(f.store.write(restored.id)).toBe(true);
  const pending = f.store.load(restored.id)!.units[0]!.baseline!;
  selectBaselineExecutionRoot(pending, item);
  expect(baselinePathUnchanged(item, pending, 'attempt-dirty')).toBe(true);
  const imported = deserializeContract(text)!.units[0]!.baseline!;
  selectBaselineExecutionRoot(imported, item);
  expect(baselinePathUnchanged(item, imported, 'attempt-dirty')).toBeUndefined();
  f.store.dispose();
});


test('the same version without the actual baseline-v2 reader capability is withheld', () => {
  const f = fixture(), execPath = join(f.root, 'goodvibes'); writeFileSync(execPath, 'Inert admitted reader fixture', { mode: 0o755 });
  const writer = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} });
  writer.declare('contract-tree-baselines-v2');
  const capabilities = nativeReaderCapabilities('3.1.2');
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo, capabilities)).not.toThrow();
  expect(() => assertNativeReaderCompatible(execPath, '3.1.2', realUpdateFileIo,
    { ...capabilities, formats: capabilities.formats.filter(format => format !== 'contract-tree-baselines-v2') })).toThrow('does not confirm');
  f.store.dispose();
});


test('actual lifecycle comparison-tree transfers retain original bytes and invalidate only current observations', () => {
  const f = fixture(), accepted = makeProjectTempDir('accepted-contract-comparison'); roots.push(accepted);
  writeFileSync(join(accepted, 'owner-dirty'), 'Integrated unit work');
  const hash = spyOn(crypto, 'createHash');
  try {
    const disposal = deserializeContract(serializeContract(f.contract, 1)!)!; retainOriginalTreeBaselines(f.contract, disposal);
    selectBaselineExecutionRoot(f.baseline, accepted);
    expect(baselinePathUnchanged(f.root, disposal.baseline!, 'owner-dirty')).toBe(true);
    expect(baselinePathUnchanged(accepted, f.baseline, 'owner-dirty')).toBe(false);
    writeFileSync(join(accepted, 'owner-dirty'), 'Potentially-secret owner bytes\n');
    expect(baselinePathUnchanged(accepted, f.baseline, 'owner-dirty')).toBe(true);
    // Moving back must compare the actual original tree, rather than a cached
    // assertion that still points at the accepted comparison copy.
    selectBaselineExecutionRoot(f.baseline, f.root); writeFileSync(f.path, 'Different original-tree work');
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(false);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
  } finally { hash.mockRestore(); f.store.dispose(); }
});

test('a retired project directory is unavailable rather than a new deletion of every original file', () => {
  const f = fixture(), retired = f.root + '.retired'; renameSync(f.root, retired); roots.push(retired);
  expect(captureDirtyFile(f.root, 'owner-dirty').kind).toBe('unavailable');
  expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBeUndefined(); f.store.dispose();
});


test('original root aliases such as Darwin tmp parents are supported, while later retargets retire the owner', () => {
  const f = fixture(), aliases = makeProjectTempDir('baseline-lexical-parents'), foreign = makeProjectTempDir('baseline-foreign-parents'); roots.push(aliases, foreign);
  const alias = join(aliases, 'tmp-like-parent'); symlinkSync(dirname(f.root), alias, 'dir');
  const selected = join(alias, basename(f.root)), snapshot = snapshotDirtyTree(selected), baseline = takeBaseline(selected)!;
  expect(snapshot.get('owner-dirty')).toEqual({ kind: 'file' });
  expect(excludeUntouchedLaunchResidue(selected, ['owner-dirty'], snapshot).excluded).toEqual(['owner-dirty']);
  expect(baselinePathUnchanged(selected, baseline, 'owner-dirty')).toBe(true);
  const rootProof = captureDirtyTreeRoot(selected);
  expect(captureDirtyFile(selected, 'owner-dirty', rootProof).kind).toBe('file');
  expect(captureDirtyFile(selected, 'owner-dirty', { ...rootProof }).kind).toBe('unavailable');
  const replacement = join(foreign, basename(f.root)); mkdirSync(replacement); writeFileSync(join(replacement, 'owner-dirty'), 'Potentially-secret owner bytes\n');
  unlinkSync(alias); symlinkSync(foreign, alias, 'dir');
  expect(() => rootProof.assertCurrent()).toThrow();
  expect(() => excludeUntouchedLaunchResidue(selected, ['owner-dirty'], snapshot)).toThrow();
  expect(baselinePathUnchanged(selected, baseline, 'owner-dirty')).toBeUndefined();
  expect(() => selectBaselineExecutionRoot(baseline, selected)).toThrow(); f.store.dispose();
});

test('a direct project-root alias is retained without following dirty descendant symlinks', () => {
  const f = fixture(), aliases = makeProjectTempDir('baseline-direct-alias'); roots.push(aliases);
  const selected = join(aliases, 'project'); symlinkSync(f.root, selected, 'dir');
  const snapshot = snapshotDirtyTree(selected);
  expect(excludeUntouchedLaunchResidue(selected, ['owner-dirty'], snapshot).excluded).toEqual(['owner-dirty']);
  symlinkSync(aliases, join(f.root, 'outside-parent'), 'dir'); writeFileSync(join(aliases, 'private-value'), 'Never follow this dirty descendant');
  expect(captureDirtyFile(selected, 'outside-parent/private-value').kind).toBe('unavailable'); f.store.dispose();
});

test('an unverified empty dirty map cannot certify new work or a committed HEAD difference', () => {
  const f = fixture(); git(f.root, 'add', 'owner-dirty'); git(f.root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'clean baseline');
  f.contract.baseline = takeBaseline(f.root)!;
  const imported = deserializeContract(serializeContract(f.contract, 1)!)!, baseline = imported.baseline!;
  expect(Object.keys(baseline.dirty)).toEqual([]);
  expect(baselinePathUnchanged(f.root, baseline, 'unlisted-owner-edit')).toBeUndefined();
  expect(partitionBaselinePaths(f.root, ['unlisted-owner-edit'], baseline)).toEqual({ included: [], excluded: ['unlisted-owner-edit'], uncertain: ['unlisted-owner-edit'] });
  expect(() => baselineChangedPaths(f.root, [], baseline)).toThrow('cannot be verified'); f.store.dispose();
});


test('settled terminal history releases private buffers while preserving serializable native commitments', () => {
  const f = fixture(), disposal = deserializeContract(serializeContract(f.contract, 1)!)!;
  retainOriginalTreeBaselines(f.contract, disposal);
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    releaseTreeBaselineBytes(f.contract); releaseTreeBaselineBytes(disposal);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    const text = serializeContract(f.contract, 2)!;
    expect(text).not.toContain('Potentially-secret owner bytes');
    expect(JSON.parse(text).treeBaselineOrigins.entries[0].origin).toBe('native-snapshot');
    // Only this explicit later comparison re-adopts current bytes against the
    // already recorded durable original; cleanup creates no additional SHA.
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    expect(baselinePathUnchanged(f.root, disposal.baseline!, 'owner-dirty')).toBe(true);
    expect(baselinePathUnchanged(f.root, f.baseline, 'owner-dirty')).toBe(true);
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(2);
  } finally { hash.mockRestore(); f.store.dispose(); }
});
