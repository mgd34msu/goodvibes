/** A retained candidate must carry checksum-bound affirmative reader evidence.
 * Never execute historical programs to discover support: an unknown command
 * might otherwise launch their ordinary chat/configuration runtime. */
import { dirname, join } from 'node:path';
import { assertNativeReaderCompatible, NATIVE_READER_REQUIREMENT_FILE, NativeDataCompatibilityError } from './native-reader-compatibility.js';
import { assertClientReaderPayload, clientReaderAsset, parseClientReaderArtifact, type ClientReaderArtifact } from './client-reader-artifact.js';
import type { UpdateFileIo } from './update-file-io.js';

export function assertStagedClientReaderCompatible(execPath: string, candidatePath: string, io: UpdateFileIo, expectedVersion?: string, expectedAsset?: string): void {
  const observe = io.observe, readFile = io.readFile;
  if (!observe || !readFile) {
    if (io.exists(join(dirname(execPath), NATIVE_READER_REQUIREMENT_FILE))) throw new NativeDataCompatibilityError('unavailable');
    return;
  }
  if (observe(join(dirname(execPath), NATIVE_READER_REQUIREMENT_FILE)) === null) return;
  const suffix = candidatePath.slice(execPath.length);
  if (!candidatePath.startsWith(execPath) || (suffix !== '.previous' && suffix !== '.update-download')) throw new NativeDataCompatibilityError('unavailable');
  const companion = execPath + '.readers.json' + suffix;
  const original = observe(companion);
  if (!original || original.mode !== 0o644) throw new NativeDataCompatibilityError('unconfirmed-reader');
  const bytes = readFile(companion);
  if (bytes.byteLength > 128 * 1024) throw new NativeDataCompatibilityError('unconfirmed-reader');
  let artifact: ClientReaderArtifact;
  try { artifact = parseClientReaderArtifact(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
  catch { throw new NativeDataCompatibilityError('unconfirmed-reader'); }
  if (expectedVersion !== undefined && artifact.version !== expectedVersion.replace(/^v/i, '')) throw new NativeDataCompatibilityError('unconfirmed-reader');
  const asset = clientReaderAsset(artifact.packageName, artifact.target);
  if (expectedAsset !== undefined && asset !== expectedAsset) throw new NativeDataCompatibilityError('unconfirmed-reader');
  const basename = execPath.slice(execPath.lastIndexOf('/') + 1);
  const product = artifact.packageName === '@goodvibes-jev/tui' ? 'goodvibes' : 'goodvibes-agent';
  if (basename !== product && basename !== asset) throw new NativeDataCompatibilityError('unconfirmed-reader');
  for (const member of artifact.files) {
    const selected = execPath + member.path.slice(asset.length) + suffix, before = observe(selected);
    if (!before || before.mode !== member.mode) throw new NativeDataCompatibilityError('unavailable');
    assertClientReaderPayload(artifact, member.path, readFile(selected));
    const after = observe(selected);
    if (!after || before.identity !== after.identity || before.ownerIdentity !== after.ownerIdentity || before.mode !== after.mode) throw new NativeDataCompatibilityError('unavailable');
  }
  const after = observe(companion);
  if (!after || original.identity !== after.identity || original.ownerIdentity !== after.ownerIdentity || original.mode !== after.mode) throw new NativeDataCompatibilityError('unavailable');
  assertNativeReaderCompatible(execPath, artifact.version, io, artifact.readers);
}
