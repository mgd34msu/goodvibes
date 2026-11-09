/** Inert Darwin-shaped release sources. Actual Mach-O execution/dlopen is not claimed. */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { clientReaderPayloadPaths, nativeReaderCapabilities, sha256, type ClientReaderArtifact } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { daemonSqliteRuntime, initializeDaemonNativeSqlite, type DaemonSqliteOwner } from '../../cli/native-sqlite-runtime.js';
import { captureOriginalDarwinDaemonInstallation } from '../../config/native-installation.js';
export function darwinInstallationFixture(root: string, arch: 'x64' | 'arm64' = 'x64', version = '3.1.2') {
  const runtime = daemonSqliteRuntime('darwin', arch)!;
  const execPath = join(root, 'goodvibes-daemon'), binary = Buffer.from(`Inert Darwin daemon ${version}`), vector = Buffer.from(`Inert vector ${version}`);
  const library = Buffer.alloc(64, 7); library.writeUInt32LE(0xfeedfacf, 0); library.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4); library.writeUInt32LE(6, 12);
  const owner: DaemonSqliteOwner = { schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: version, target: runtime.target,
    sqliteVersion: runtime.sqliteVersion, sourceUrl: runtime.sourceUrl, sourceSha3: runtime.sourceSha3, sha256: sha256(library), size: library.length };
  const paths = clientReaderPayloadPaths('@goodvibes-jev/daemon', runtime.target), values = [binary, vector, library, Buffer.from(JSON.stringify(owner))];
  const artifact: ClientReaderArtifact = { schema: 1, packageName: '@goodvibes-jev/daemon', version, target: runtime.target,
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40), readers: nativeReaderCapabilities(version),
    files: paths.map((path, index) => ({ path, sha256: sha256(values[index]!), mode: index === 0 ? 0o755 : 0o644, size: values[index]!.length })) };
  const installed = paths.map((path, index) => index === 0 ? execPath : join(root, path));
  installed.forEach((path, index) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, values[index]!); chmodSync(path, index === 0 ? 0o755 : 0o644); });
  writeFileSync(execPath + '.readers.json', JSON.stringify(artifact)); chmodSync(execPath + '.readers.json', 0o644);
  const sqlite = initializeDaemonNativeSqlite({ platform: 'darwin', arch, execPath, version, bundled: true, capturedOwner: owner, setCustomSQLite: () => true })!;
  const original = captureOriginalDarwinDaemonInstallation(sqlite, { platform: 'darwin', arch, execPath, version, bundled: true })!;
  return { root, arch, version, execPath, artifact, owner, values, installed, sqlite, original,
    options: { platform: 'darwin', arch, execPath, version, bundled: true, darwinInstallation: original } };
}
