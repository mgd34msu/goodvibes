/** Darwin daemon release inspection. Reader metadata proves its declared image
 * pins; only the actual compiled entry can additionally supply SQLite's baked
 * producer owner. Historical metadata is never executed to discover readers. */
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { lstatSync } from 'node:fs';
import { assertClientReaderPayload, clientReaderMemberPath, parseClientReaderArtifact, type ClientReaderArtifact } from './client-reader-artifact.js';
import { retainDaemonNativeFiles } from './daemon-native-cohort.js';
import { hasNativeUpdateObservations, type UpdateFileIo } from './update-file-io.js';
import type { UpdateTarget } from './self-update.js';
import type { NativeReaderCapabilities } from './native-reader-compatibility.js';
export interface DarwinDaemonSqliteOwner {
  readonly schema: 1; readonly packageName: '@goodvibes-jev/daemon'; readonly daemonVersion: string;
  readonly target: 'darwin-x64' | 'darwin-arm64'; readonly sqliteVersion: string;
  readonly sourceUrl: string; readonly sourceSha3: string; readonly sha256: string; readonly size: number;
}
export interface DarwinDaemonInstallation {
  readonly version: string;
  readonly readers: NativeReaderCapabilities;
  readonly artifact: ClientReaderArtifact;
  readonly targets: readonly UpdateTarget[];
  readonly sqliteOwner: DarwinDaemonSqliteOwner;
  /** Only true when the caller supplied an actual compiled producer owner. */
  readonly compiledSqliteVerified: boolean;
  assertCurrent(): void;
}
export { resolveDarwinDaemonTargets } from './darwin-daemon-paths.js';
import { resolveDarwinDaemonTargets } from './darwin-daemon-paths.js';

function sqliteOwner(value: unknown, target: string, version: string): DarwinDaemonSqliteOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Darwin SQLite producer is invalid');
  const row = value as Record<string, unknown>, keys = ['schema', 'packageName', 'daemonVersion', 'target', 'sqliteVersion', 'sourceUrl', 'sourceSha3', 'sha256', 'size'];
  if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key)) || row['schema'] !== 1 || row['packageName'] !== '@goodvibes-jev/daemon'
    || row['daemonVersion'] !== version || row['target'] !== target || typeof row['sqliteVersion'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(row['sqliteVersion'])
    || typeof row['sourceUrl'] !== 'string' || !/^https:\/\/www\.sqlite\.org\/\d{4}\/sqlite-autoconf-\d+\.tar\.gz$/.test(row['sourceUrl'])
    || typeof row['sourceSha3'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['sourceSha3']) || typeof row['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['sha256'])
    || typeof row['size'] !== 'number' || !Number.isSafeInteger(row['size']) || row['size'] < 32 || row['size'] > 128 * 1024 * 1024) throw new Error('Darwin SQLite producer is invalid');
  return Object.freeze({ ...row }) as unknown as DarwinDaemonSqliteOwner;
}
export function inspectDarwinDaemonInstallation(execPath: string, arch: string, suffix: '' | '.previous', io: UpdateFileIo,
  options: { readonly integrity?: boolean; readonly expectedSqliteOwner?: DarwinDaemonSqliteOwner | undefined; readonly assertCompiledSqliteCurrent?: (() => void) | undefined } = {}): DarwinDaemonInstallation | null {
  const targets = resolveDarwinDaemonTargets(execPath, arch), read = io.readFile, observe = io.observe;
  if (!targets || !read || !observe) throw new Error('Darwin daemon installation observations are unavailable');
  const selected = targets.map(target => ({ ...target, path: target.path + suffix }));
  if (selected.every(target => observe(target.path) === null)) return null;
  const original = retainDaemonNativeFiles(selected, io);
  const compiledCurrent = options.assertCompiledSqliteCurrent;
  if (compiledCurrent && !options.expectedSqliteOwner) throw new Error('Compiled SQLite provenance requires its actual owner');
  const current = () => {
    original(); const result: unknown = compiledCurrent?.();
    if (result !== undefined) { drainOwned(result); throw new Error('Compiled SQLite source guard must be synchronous'); } original();
  };
  for (const target of selected) if (observe(target.path)?.mode !== (target.executable ? 0o755 : 0o644)) throw new Error('Darwin daemon installation is incomplete or has invalid modes');
  const bounded = (path: string, limit: number): Buffer => {
    current();
    if (hasNativeUpdateObservations(io, read, observe) && lstatSync(path).size > limit) throw new Error('Darwin daemon metadata exceeds its bound');
    const bytes = read(path); current(); if (bytes.byteLength > limit) throw new Error('Darwin daemon metadata exceeds its bound'); return bytes;
  };
  const artifact = parseClientReaderArtifact(JSON.parse(bounded(selected[1]!.path, 128 * 1024).toString('utf8')));
  const target = `darwin-${arch}`;
  if (artifact.packageName !== '@goodvibes-jev/daemon' || artifact.target !== target || artifact.files.length !== 4) throw new Error('Darwin daemon reader artifact identifies another installation');
  const ownerBytes = bounded(selected[4]!.path, 16 * 1024), owner = sqliteOwner(JSON.parse(ownerBytes.toString('utf8')), target, artifact.version);
  const expected = options.expectedSqliteOwner === undefined ? undefined : sqliteOwner(options.expectedSqliteOwner, target, artifact.version);
  if (expected && Object.entries(expected).some(([key, value]) => Reflect.get(owner, key) !== value)) throw new Error('Darwin SQLite producer differs from the actual compiled owner');
  const libraryPin = artifact.files.find(file => file.path === `lib/sqlite-${target}/libsqlite3.dylib`);
  if (!libraryPin || libraryPin.sha256 !== owner.sha256 || libraryPin.size !== owner.size) throw new Error('Darwin SQLite producer differs from its published cohort');
  if (options.integrity !== false) {
    // Each real published cohort pin is verified once. The actual startup
    // loader already verified a retained compiled-owned SQLite library, so its
    // identical pin can be reused without hashing that library a second time.
    let library: Buffer | undefined;
    for (const member of artifact.files) {
      current();
      if (expected && compiledCurrent && member === libraryPin) continue;
      const bytes = member === libraryPin ? bounded(selected[3]!.path, owner.size) : member.path.endsWith("libsqlite3.dylib.json") ? ownerBytes : read(clientReaderMemberPath(execPath, artifact, member.path, suffix));
      assertClientReaderPayload(artifact, member.path, bytes); if (member === libraryPin) library = bytes; current();
    }
    const cpu = arch === 'x64' ? 0x01000007 : 0x0100000c;
    if (library && (library.length !== owner.size || library.readUInt32LE(0) !== 0xfeedfacf || library.readUInt32LE(4) !== cpu || library.readUInt32LE(12) !== 6)) throw new Error('Darwin SQLite library has the wrong architecture');
  }
  current(); return Object.freeze({ version: artifact.version, readers: artifact.readers, artifact, targets,
    sqliteOwner: owner, compiledSqliteVerified: expected !== undefined && compiledCurrent !== undefined, assertCurrent: current });
}
