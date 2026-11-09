/** Fixed daemon payloads and receipt admission. Update publication stays in self-update.ts. */
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { parseSemanticVersion } from './semantic-version.js';
import type { UpdateTarget } from './self-update.js';
import { hasNativeUpdateObservations, type UpdateFileIo } from './update-file-io.js';
import { captureIdentity, sameIdentity, retainNativeUpdateSources } from './native-file-sources.js';
import { NATIVE_PREVIOUS_READER_RECEIPT_FORMAT, parseNativeReaderCapabilities, type NativeReaderCapabilities } from './native-reader-compatibility.js';

export const DAEMON_NATIVE_TARGETS = ['linux-x64', 'linux-arm64'] as const;
export type DaemonNativeTarget = typeof DAEMON_NATIVE_TARGETS[number];
export const DAEMON_INSTALLATION_RECEIPT = 'daemon-installation.json';
export interface DaemonNativePayload { readonly relativePath: string; readonly assetName: string; readonly executable: boolean; }
export interface DaemonArtifactSource { sourceCommit: string; sourceTree: string; headCommit: string; target?: DaemonNativeTarget; }
interface DaemonCiArtifactBase extends DaemonArtifactSource {
  target: DaemonNativeTarget;
  files: Array<{ path: string; sha256: string; mode: number; size: number }>;
}
export type DaemonCiArtifact = DaemonCiArtifactBase & (
  { schema: 1; readers?: never } | { schema: 2; readers: NativeReaderCapabilities }
);
export interface DaemonInstallationReceipt {
  schema: 1;
  packageName: '@goodvibes-jev/daemon';
  version: string;
  artifact: DaemonCiArtifact;
  /** Evidence issued by the outgoing running program, bound to its entire
   * verified cohort. Older updaters can leave that program a v1 receipt. */
  previousReader?: DaemonPreviousReader;
}
export interface DaemonPreviousReader {
  version: string;
  artifact: Extract<DaemonCiArtifact, { schema: 2 }>;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
export function resolveDaemonNativePayloads(platform: string, arch: string): readonly DaemonNativePayload[] | null {
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) return null;
  const binary = `goodvibes-daemon-linux-${arch}`;
  return Object.freeze([
    { relativePath: binary, assetName: binary, executable: true },
    { relativePath: `${binary}.bun`, assetName: `${binary}.bun`, executable: true },
    { relativePath: `${binary}.bun.LICENSE.md`, assetName: `${binary}.bun.LICENSE.md`, executable: false },
    { relativePath: `${binary}.bun.json`, assetName: `${binary}.bun.json`, executable: false },
    { relativePath: `lib/sqlite-vec-linux-${arch}/vec0.so`, assetName: `sqlite-vec-linux-${arch}.so`, executable: false },
  ].map(value => Object.freeze(value)));
}
export function resolveDaemonNativeTargets(execPath: string, platform: string, arch: string): readonly UpdateTarget[] | null {
  const payloads = resolveDaemonNativePayloads(platform, arch);
  if (!payloads) return null;
  const root = dirname(execPath), binary = payloads[0];
  if (!binary) throw new Error('Native daemon payload contract is empty');
  if (basename(execPath) !== 'goodvibes-daemon' && basename(execPath) !== binary.relativePath) throw new Error('Native daemon executable path has the wrong product identity');
  const targets = payloads.map((payload, index) => ({ label: payload.relativePath,
    path: index === 0 ? execPath : index < 4 ? execPath + payload.relativePath.slice(binary.relativePath.length) : join(root, payload.relativePath),
    assetName: payload.assetName, executable: payload.executable }));
  return Object.freeze([...targets.map(value => Object.freeze(value)), Object.freeze({ label: DAEMON_INSTALLATION_RECEIPT,
    path: join(root, DAEMON_INSTALLATION_RECEIPT), assetName: `${binary.assetName}.ci-artifact.json`, executable: false })]);
}
export function parseDaemonCiArtifact(value: unknown, target: DaemonNativeTarget): DaemonCiArtifact {
  const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length));
  if (!payloads || !record(value) || (value.schema !== 1 && value.schema !== 2)
    || !exact(value, value.schema === 1 ? ['schema', 'sourceCommit', 'sourceTree', 'headCommit', 'target', 'files']
      : ['schema', 'sourceCommit', 'sourceTree', 'headCommit', 'target', 'files', 'readers'])
    || value.target !== target || !Array.isArray(value.files) || value.files.length !== payloads.length) throw new Error('Native daemon artifact identity is invalid');
  const { sourceCommit, sourceTree, headCommit } = value;
  if (typeof sourceCommit !== 'string' || typeof sourceTree !== 'string' || typeof headCommit !== 'string'
    || ![sourceCommit, sourceTree, headCommit].every(sha => /^[a-f0-9]{40}$/.test(sha))) throw new Error('Native daemon artifact requires exact source identities');
  const files = value.files.map((file: unknown, index) => {
    const payload = payloads[index];
    if (!payload || !record(file) || !exact(file, ['path', 'sha256', 'mode', 'size']) || typeof file.path !== 'string' || file.path !== payload.relativePath
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.mode !== 'number' || file.mode !== (payload.executable ? 0o755 : 0o644)
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('Native daemon artifact has an incomplete or invalid payload');
    return { path: file.path, sha256: file.sha256, mode: file.mode, size: file.size };
  });
  const base = { sourceCommit, sourceTree, headCommit, target, files };
  return value.schema === 1 ? { schema: 1, ...base } : { schema: 2, ...base, readers: parseNativeReaderCapabilities(value.readers) };
}
export function parseDaemonInstallationReceipt(value: unknown, target: DaemonNativeTarget): DaemonInstallationReceipt {
  if (!record(value) || !exact(value, Object.hasOwn(value, 'previousReader') ? ['schema', 'packageName', 'version', 'artifact', 'previousReader']
    : ['schema', 'packageName', 'version', 'artifact']) || value.schema !== 1 || value.packageName !== '@goodvibes-jev/daemon'
    || typeof value.version !== 'string' || !parseSemanticVersion(value.version)) throw new Error('Native daemon installation receipt is invalid');
  const artifact = parseDaemonCiArtifact(value.artifact, target);
  if (artifact.schema === 2 && artifact.readers.version !== value.version) throw new Error('Native daemon reader version differs from its installed product');
  let previousReader: DaemonPreviousReader | undefined;
  if (Object.hasOwn(value, 'previousReader')) {
    if (artifact.schema !== 2 || !artifact.readers.formats.includes(NATIVE_PREVIOUS_READER_RECEIPT_FORMAT)) throw new Error('Native daemon does not confirm support for previous-reader receipts');
    const previous = value.previousReader;
    if (!record(previous) || !exact(previous, ['version', 'artifact']) || typeof previous.version !== 'string'
      || !parseSemanticVersion(previous.version)) throw new Error('Previous native reader evidence is invalid');
    const previousArtifact = parseDaemonCiArtifact(previous.artifact, target);
    if (previousArtifact.schema !== 2 || previousArtifact.readers.version !== previous.version) throw new Error('Previous native reader evidence is invalid');
    previousReader = { version: previous.version, artifact: previousArtifact };
  }
  return { schema: 1, packageName: '@goodvibes-jev/daemon', version: value.version, artifact,
    ...(previousReader === undefined ? {} : { previousReader }) };
}
/** Both receipts must already belong to the retained native transaction. A
 * matching version alone never transfers reader support to another build. */
export function resolveDaemonInstallationReaders(candidate: DaemonInstallationReceipt, companion: DaemonInstallationReceipt | null): NativeReaderCapabilities | undefined {
  if (candidate.artifact.schema === 2) return candidate.artifact.readers;
  const evidence = companion?.previousReader;
  if (!evidence || evidence.version !== candidate.version) return undefined;
  const actual = candidate.artifact, expected = evidence.artifact;
  if (actual.sourceCommit !== expected.sourceCommit || actual.sourceTree !== expected.sourceTree || actual.headCommit !== expected.headCommit
    || actual.target !== expected.target || actual.files.length !== expected.files.length || actual.files.some((file, index) => {
      const other = expected.files[index];
      return !other || file.path !== other.path || file.sha256 !== other.sha256 || file.mode !== other.mode || file.size !== other.size;
    })) return undefined;
  return evidence.artifact.readers;
}
export function assertDaemonNativePayloadBytes(artifact: DaemonCiArtifact, buffers: readonly Buffer[]): void {
  if (buffers.length !== artifact.files.length) throw new Error('Native daemon payload set is incomplete');
  let bunDigest: string | undefined;
  for (const [index, file] of artifact.files.entries()) {
    const bytes = buffers[index];
    if (!bytes || bytes.length !== file.size) throw new Error(`Native daemon payload differs from its source manifest: ${file.path}`);
    const actual = digest(bytes);
    if (actual !== file.sha256) throw new Error(`Native daemon payload differs from its source manifest: ${file.path}`);
    if (index === 1) bunDigest = actual;
  }
  assertCapturedBunMetadata(artifact, bunDigest, buffers[3]);
}
/** Download verification already computed these exact pins. Comparing the
 * source descriptor against them must not hash the same payloads again. */
export function assertDaemonNativePayloadPins(artifact: DaemonCiArtifact, members: readonly {
  readonly sha256: string; readonly size: number; readonly mode: number;
}[], metadata: Buffer | undefined): void {
  if (members.length !== artifact.files.length || members.some((member, index) => {
    const file = artifact.files[index];
    return !file || file.sha256 !== member.sha256 || file.size !== member.size || file.mode !== member.mode;
  })) throw new Error('Native daemon payload differs from its source manifest');
  assertCapturedBunMetadata(artifact, members[1]?.sha256, metadata);
}
function assertCapturedBunMetadata(artifact: DaemonCiArtifact, bunDigest: string | undefined, metadata: Buffer | undefined): void {
  if (!bunDigest || !metadata) throw new Error('Native daemon runtime is incomplete');
  const value: unknown = JSON.parse(metadata.toString('utf8'));
  if (!record(value) || value.version !== '1.3.14' || value.target !== artifact.target || value.sha256 !== bunDigest
    || value.upstreamSource !== 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' || typeof value.source !== 'string'
    || !(value.source === 'build-interpreter' || value.source.startsWith('installed:@oven/bun-linux-') || value.source.startsWith('npm:@oven/bun-linux-'))) throw new Error('Native daemon Bun runtime provenance is invalid');
}
/** Resolve the fixed paths ourselves; receipt JSON never supplies filesystem paths. */
export function inspectDaemonNativeInstallation(execPath: string, platform: string, arch: string, suffix: '' | '.previous', io: UpdateFileIo,
  options: { readonly integrity?: boolean } = {}): DaemonInstallationReceipt | null {
  const targets = resolveDaemonNativeTargets(execPath, platform, arch);
  if (!targets) throw new Error('Native daemon target is unsupported');
  if (!io.readFile || !io.observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  for (const other of DAEMON_NATIVE_TARGETS.filter(target => target !== `linux-${arch}`)) {
    const payloads = resolveDaemonNativePayloads('linux', other.slice('linux-'.length));
    for (const payload of payloads ?? []) if (io.observe(join(dirname(execPath), payload.relativePath) + suffix) !== null) throw new Error('Native daemon installation contains a different target');
  }
  if (targets.every(target => io.observe!(target.path + suffix) === null)) return null;
  const target: DaemonNativeTarget = arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  const receiptTarget = targets[targets.length - 1];
  if (!receiptTarget) throw new Error('Native daemon receipt contract is empty');
  const observation = io.observe(receiptTarget.path + suffix);
  if (!observation || observation.mode !== 0o644) throw new Error('Native daemon receipt is missing or invalid');
  const receipt = parseDaemonInstallationReceipt(JSON.parse(io.readFile(receiptTarget.path + suffix).toString('utf8')), target);
  if (options.integrity !== false) {
    const buffers = targets.slice(0, -1).map(member => {
      const observation = io.observe!(member.path + suffix);
      if (!observation || observation.mode !== (member.executable ? 0o755 : 0o644)) throw new Error(`Native daemon payload is missing or has the wrong mode: ${member.label}`);
      return io.readFile!(member.path + suffix);
    });
    assertDaemonNativePayloadBytes(receipt.artifact, buffers);
  }
  return receipt;
}
type FileIdentity = NonNullable<ReturnType<NonNullable<UpdateFileIo['observe']>>>;
/** Actual native I/O certifies physical revisions after initial payload pin
 * verification. Borrowed adapters must also retain and compare exact bytes. */
export function retainDaemonNativeFiles(targets: readonly UpdateTarget[], io: UpdateFileIo): () => void {
  return retainNativeUpdateSources(targets.flatMap(target => [target.path, target.path + '.previous']), io);
}
export interface DaemonNativeRenameGuard {
  assertCurrent(): void;
  beforeRemove(path: string): void;
  afterRemove(path: string): void;
  beforeRename(from: string, to: string, recovering: boolean): void;
  afterRename(from: string, to: string, recovering: boolean): void;
}
/** Advance only the exact native renames recorded by the existing transaction. */
export function createDaemonNativeRenameGuard(targets: readonly UpdateTarget[], io: UpdateFileIo): DaemonNativeRenameGuard {
  const readFile = io.readFile, observe = io.observe;
  if (!readFile || !observe) throw new Error('Native daemon I/O requires retained file observations and reads');
  const native = hasNativeUpdateObservations(io, readFile, observe);
  interface Snapshot { readonly stat: FileIdentity; readonly bytes: Buffer }
  const snapshot = (path: string, previous?: Snapshot | null): Snapshot | null => {
    const stat = captureIdentity(observe, path);
    if (stat !== null && !stat.ownerIdentity) throw new Error('Native daemon physical file ownership is unavailable');
    if (stat === null) return null;
    if (native && previous && sameIdentity(stat, previous.stat)) return previous;
    const bytes = Buffer.from(readFile(path));
    if (!sameIdentity(stat, observe(path))) throw new Error('Native daemon replacement changed during observation');
    return { stat, bytes };
  };
  const states = new Map(targets.flatMap(target => ['', '.previous', '.update-download', '.update-previous', '.rollback-exchange'].map(suffix => {
    const path = target.path + suffix; return [path, snapshot(path)] as const;
  })));
  const check = (path: string) => {
    if (!states.has(path)) throw new Error('Native daemon replacement is not the retained transaction owner');
    const expected = states.get(path), actual = snapshot(path, expected);
    if (actual === null || expected === null ? actual !== expected
      : expected === undefined || !sameIdentity(actual.stat, expected.stat) || !actual.bytes.equals(expected.bytes)) {
      throw new Error('Native daemon replacement is not the retained transaction owner');
    }
  };
  return {
    assertCurrent() { for (const path of states.keys()) check(path); },
    beforeRemove(path) { check(path); },
    afterRemove(path) { if (snapshot(path) !== null) throw new Error('Native update removal is unknown'); states.set(path, null); },
    beforeRename(from, to, recovering) {
      if (recovering) { check(from); check(to); }
      else for (const path of states.keys()) check(path);
      if (states.get(from) === null || states.get(to) !== null) throw new Error('Native daemon rename ownership is invalid');
    },
    afterRename(from, to, recovering) {
      const expected = states.get(from), actual = snapshot(to);
      if (!expected || !actual || actual.stat.ownerIdentity !== expected.stat.ownerIdentity || !actual.bytes.equals(expected.bytes)
        || actual.stat.mode !== expected.stat.mode || snapshot(from) !== null) throw new Error('Native daemon rename result is unknown');
      states.set(from, null); states.set(to, actual);
      if (!recovering) for (const path of states.keys()) check(path);
    },
  };
}
