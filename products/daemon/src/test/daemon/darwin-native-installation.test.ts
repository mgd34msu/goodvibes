/** Source-only regressions; real Darwin execution remains a native CI-lane check. */
import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureOriginalDarwinDaemonInstallation, createOriginalDarwinDaemonDataWriter, resolveInstalledDaemonUpdateArtifact } from '../../config/native-installation.js';
import { originalDarwinProof } from '../../config/original-darwin-installation.js';
import { inspectDarwinDaemonInstallation, parseClientReaderArtifact, realUpdateFileIo, resolveDarwinDaemonTargets } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { darwinInstallationFixture } from '../helpers/darwin-installation.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
const homes = { isOverridden: false };
for (const arch of ['x64', 'arm64'] as const) test(`early ${arch} source token admits a complete Darwin daemon and actual data publisher`, () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-source'), arch);
  const artifact = resolveInstalledDaemonUpdateArtifact(homes, f.options);
  expect(artifact?.suite).toBe(true); expect(artifact?.version).toBe(f.version); expect(artifact?.currentReader?.readers).toEqual(f.artifact.readers);
  const writer = createOriginalDarwinDaemonDataWriter(f.original)!;
  writer.declare('device-capture-observations-v2'); writer.declare('payment-operation-reconciliation-v2');
  const floor = JSON.parse(readFileSync(join(f.root, '.goodvibes-reader-requirements.json'), 'utf8')) as { formats: string[] };
  expect(floor.formats).toContain('device-capture-observations-v2'); expect(floor.formats).toContain('payment-operation-reconciliation-v2');
  expect(() => artifact?.assertCurrent?.()).not.toThrow();
});
test('Darwin requires the actual early token; matching late pathname/version/shape is insufficient', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-token'));
  const { darwinInstallation: original, ...late } = f.options;
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, late)).toThrow('Original compiled Darwin');
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, { ...f.options, darwinInstallation: { ...original } })).toThrow('Original compiled Darwin');
  expect(resolveInstalledDaemonUpdateArtifact(homes, { ...f.options, bundled: false })).toBeUndefined();
  expect(resolveInstalledDaemonUpdateArtifact({ isOverridden: true }, f.options)).toBeUndefined();
});
test('the shared early source record cannot supply or replace late verified installation cache entries', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-private-cache'));
  const original = originalDarwinProof(f.original)!;
  expect(Object.isFrozen(original)).toBe(true);
  expect(Reflect.set(original, 'installation', { version: f.version, compiledSqliteVerified: true, assertCurrent() {} })).toBe(false);
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, f.options)).not.toThrow();
  expect(Object.hasOwn(original, 'installation')).toBe(false);
});
test('same-byte image replacement after early capture is refused and never adopted as the running image', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-image'));
  copyFileSync(f.execPath, f.execPath + '.foreign'); renameSync(f.execPath + '.foreign', f.execPath);
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, f.options)).toThrow('changed');
});
for (const member of [1, 2, 3] as const) test(`original native companion ${member} replacement retires the actual publisher`, () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-member'));
  const admitted = resolveInstalledDaemonUpdateArtifact(homes, f.options)!;
  const path = f.installed[member]!; copyFileSync(path, path + '.foreign'); renameSync(path + '.foreign', path);
  expect(() => admitted.assertCurrent?.()).toThrow();
  expect(() => createOriginalDarwinDaemonDataWriter(f.original)?.declare('device-capture-observations-v2')).toThrow();
});
test('updater claims block ordinary startup/publication while the retained actual running reader remains usable', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-claims')), artifact = resolveInstalledDaemonUpdateArtifact(homes, f.options)!;
  const claim = f.execPath + '.update-transaction'; writeFileSync(claim, 'Owned transaction fixture');
  expect(() => artifact.assertCurrent?.()).toThrow('unfinished'); expect(() => artifact.currentReader?.assertCurrent()).not.toThrow(); unlinkSync(claim);
});
test('published previous four-member evidence verifies all companions without executing a historical program', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-previous'));
  const targets = resolveDarwinDaemonTargets(f.execPath, f.arch)!;
  for (const target of targets) copyFileSync(target.path, target.path + '.previous');
  const previous = inspectDarwinDaemonInstallation(f.execPath, f.arch, '.previous', realUpdateFileIo);
  expect(previous?.version).toBe(f.version); expect(previous?.compiledSqliteVerified).toBe(false);
  const vector = f.installed[1]! + '.previous'; writeFileSync(vector, 'altered previous vector');
  expect(() => inspectDarwinDaemonInstallation(f.execPath, f.arch, '.previous', realUpdateFileIo)).toThrow('payload');
});
test('historical program-only readers remain parseable but cannot certify complete Darwin rollback', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-old-profile'));
  const historical = { ...f.artifact, files: f.artifact.files.slice(0, 1) };
  expect(parseClientReaderArtifact(historical).files).toHaveLength(1);
  writeFileSync(f.execPath + '.readers.json', JSON.stringify(historical));
  expect(() => inspectDarwinDaemonInstallation(f.execPath, f.arch, '', realUpdateFileIo)).toThrow('reader artifact');
});
test('removing a companion cannot quietly disable native update eligibility or data floors', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-missing'));
  unlinkSync(f.installed[1]!);
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, f.options)).toThrow(); expect(existsSync(f.execPath)).toBe(true);
});
test('an early absent reader sidecar is retained as absent, not adopted if it appears after awaiting', () => {
  const f = darwinInstallationFixture(makeOwnedTempDir('darwin-native-late-profile'));
  unlinkSync(f.execPath + '.readers.json');
  const original = captureOriginalDarwinDaemonInstallation(f.sqlite, { platform: 'darwin', arch: f.arch, execPath: f.execPath, version: f.version, bundled: true })!;
  writeFileSync(f.execPath + '.readers.json', JSON.stringify(f.artifact));
  expect(() => resolveInstalledDaemonUpdateArtifact(homes, { ...f.options, darwinInstallation: original })).toThrow('changed');
});
