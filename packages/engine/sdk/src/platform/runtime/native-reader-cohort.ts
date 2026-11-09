/** Installation reader admission for the first publication of a new format.
 * Program names select fixed local slots, never capabilities. Actual peer
 * profiles are bound to their installed release bytes once; later assertions
 * use retained physical revisions rather than hashing programs again. */
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileObservation } from '../utils/file-observation.js';
import { assertClientReaderPayload, clientReaderAsset, parseClientReaderArtifact, type ClientReaderPackage, type ClientReaderTarget } from './client-reader-artifact.js';
import { inspectDaemonNativeInstallation, resolveDaemonNativeTargets } from './daemon-native-cohort.js';
import { NativeDataCompatibilityError, nativeReaderCapabilities, type NativeDataFormat } from './native-reader-compatibility.js';
import { captureUpdateFileIo, realUpdateFileIo, type UpdateFileIo } from './update-file-io.js';

interface PeerEvidence { readonly target: ClientReaderTarget; readonly version: string; readonly formats: readonly string[]; readonly assertCurrent: () => void }
const peerEvidence = new Map<string, PeerEvidence>();
const MAX_CACHED_PEERS = 32;
const PROGRAMS = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon'] as const;
function same(left: ReturnType<NonNullable<UpdateFileIo['observe']>>, right: ReturnType<NonNullable<UpdateFileIo['observe']>>): boolean {
  return left === null || right === null ? left === right : left.identity === right.identity && left.ownerIdentity === right.ownerIdentity && left.mode === right.mode;
}
function retainFiles(paths: readonly string[], io: UpdateFileIo): () => void {
  const observe = io.observe;
  if (!observe) throw new NativeDataCompatibilityError('unavailable');
  const selected = paths.map(path => ({ path, value: observe(path) }));
  return () => { for (const file of selected) if (!same(observe(file.path), file.value)) throw new NativeDataCompatibilityError('mixed-readers'); };
}
function boundedProfile(path: string): void {
  const value = lstatSync(path);
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > 128 * 1024) throw new NativeDataCompatibilityError('unconfirmed-reader');
}
function readPeer(program: typeof PROGRAMS[number], path: string, target: ClientReaderTarget, io: UpdateFileIo): PeerEvidence {
  const cached = peerEvidence.get(path);
  if (cached) { try { if (cached.target !== target) throw new Error(); cached.assertCurrent(); return cached; } catch { peerEvidence.delete(path); } }
  let evidence: PeerEvidence;
  if (program === 'goodvibes-daemon' && target.startsWith('linux-')) {
    const arch = target.slice('linux-'.length), targets = resolveDaemonNativeTargets(path, 'linux', arch);
    if (!targets) throw new NativeDataCompatibilityError('unconfirmed-reader');
    boundedProfile(join(dirname(path), 'daemon-installation.json'));
    const assertCurrent = retainFiles(targets.map(member => member.path), io);
    const receipt = inspectDaemonNativeInstallation(path, 'linux', arch, '', io);
    assertCurrent();
    if (!receipt || receipt.artifact.schema !== 2) throw new NativeDataCompatibilityError('unconfirmed-reader');
    evidence = { target, version: receipt.version, formats: receipt.artifact.readers.formats, assertCurrent };
  } else {
    const profilePath = path + '.readers.json'; boundedProfile(profilePath);
    const originalProfile = readFileObservation(profilePath);
    const artifact = parseClientReaderArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(originalProfile.bytes)));
    const expectedPackage: ClientReaderPackage = program === 'goodvibes' ? '@goodvibes-jev/tui' : program === 'goodvibes-agent' ? '@goodvibes-jev/agent' : '@goodvibes-jev/daemon';
    if (artifact.packageName !== expectedPackage || artifact.target !== target) throw new NativeDataCompatibilityError('mixed-readers');
    if (target.startsWith('linux-') && artifact.files.length !== 4) throw new NativeDataCompatibilityError('unconfirmed-reader');
    const asset = clientReaderAsset(artifact.packageName, target);
    const members = artifact.files.map(member => ({ member, path: path + member.path.slice(asset.length) }));
    const assertCurrent = retainFiles([profilePath, path, ...['.bun', '.bun.json', '.bun.LICENSE.md'].map(suffix => path + suffix)], io);
    for (const item of members) {
      if (io.observe?.(item.path)?.mode !== item.member.mode || !io.readFile) throw new NativeDataCompatibilityError('unconfirmed-reader');
      // Initial admission of a separately installed peer's release pin. There
      // is no live SDK download/staging receipt here; this runs once per native
      // physical revision and never in a repeated data-publication assertion.
      assertClientReaderPayload(artifact, item.member.path, io.readFile(item.path));
    }
    if (readFileObservation(profilePath).physical !== originalProfile.physical) throw new NativeDataCompatibilityError('mixed-readers');
    assertCurrent(); evidence = { target, version: artifact.version, formats: artifact.readers.formats, assertCurrent };
  }
  if (peerEvidence.size >= MAX_CACHED_PEERS) { const oldest = peerEvidence.keys().next().value; if (oldest !== undefined) peerEvidence.delete(oldest); }
  peerEvidence.set(path, evidence); return evidence;
}

/** Called only by a real executable root after its own native image admission.
 * The returned function captures peers for one new floor publication; it grants
 * no read/execution authority. Existing-floor accounting does not call it. */
export function createInstalledReaderCohort(input: { readonly execPath: string; readonly version: string; readonly platform: string; readonly arch: string }): (formats: readonly NativeDataFormat[]) => () => void {
  const execPath = input.execPath, version = input.version, platform = input.platform, arch = input.arch;
  const root = dirname(execPath), io = captureUpdateFileIo(realUpdateFileIo), ownFormats = nativeReaderCapabilities(version).formats;
  return inputFormats => {
    const requiredFormats = Object.freeze([...inputFormats]);
    const target = `${platform}-${arch}`;
    if (target !== 'linux-x64' && target !== 'linux-arm64' && target !== 'darwin-x64' && target !== 'darwin-arm64') throw new NativeDataCompatibilityError('unconfirmed-reader');
    const assertIdle = () => { for (const program of PROGRAMS) if (io.exists(join(root, program) + '.update-transaction')) throw new NativeDataCompatibilityError('busy'); };
    assertIdle();
    const programs = PROGRAMS.map(program => ({ program, path: join(root, program) }));
    const assertSlots = retainFiles(programs.map(program => program.path), io);
    const assertions: Array<() => void> = [assertSlots];
    for (const item of programs) {
      if (io.observe?.(item.path) === null) continue;
      const evidence = item.path === execPath ? { version, formats: ownFormats, assertCurrent: () => {} } : readPeer(item.program, item.path, target, io);
      if (evidence.version !== version || requiredFormats.some(format => !evidence.formats.includes(format))) throw new NativeDataCompatibilityError('mixed-readers');
      assertions.push(evidence.assertCurrent);
    }
    if (requiredFormats.some(format => !ownFormats.includes(format))) throw new NativeDataCompatibilityError('unconfirmed-reader');
    const assertCurrent = () => { assertIdle(); for (const assertion of assertions) assertion(); assertIdle(); };
    assertCurrent(); return assertCurrent;
  };
}
