/** Regression source intentionally UNRUN during the coding-first pass. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyVerifiedUpdate, assertStagedClientReaderCompatible, nativeReaderCapabilities, sha256, realUpdateFileIo, createNativeDataWriteOwner,
  verifiedUpdateStageMembers, type VerifiedUpdateStage } from '../sdk/src/platform/runtime/self-update.js';
import { clientReaderAsset, type ClientReaderArtifact } from '../sdk/src/platform/runtime/client-reader-artifact.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

function fixture() {
  const root = makeProjectTempDir('verified-reader-pins'), execPath = join(root, 'goodvibes'), asset = clientReaderAsset('@goodvibes-jev/tui', 'darwin-x64');
  const binary = Buffer.from('Known downloaded terminal bytes');
  writeFileSync(execPath, 'Current image', { mode: 0o755 });
  const artifact: ClientReaderArtifact = { schema: 1, packageName: '@goodvibes-jev/tui', version: '3.1.2', target: 'darwin-x64',
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), readers: nativeReaderCapabilities('3.1.2'),
    files: [{ path: asset, sha256: sha256(binary), mode: 0o755, size: binary.length }] };
  const metadata = Buffer.from(JSON.stringify(artifact)), readerAsset = asset + '.reader-ci-artifact.json';
  const assets = new Map([[asset, binary], [readerAsset, metadata]]);
  const manifest = Buffer.from([...assets].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''));
  const owner = createNativeDataWriteOwner({ execPath, version: '3.1.2', assertCurrent() {} }); owner.declare('knowledge-schema-v12');
  const fetchImpl = async (url: string) => new Response(url.endsWith('/SHA256SUMS.txt') ? manifest : assets.get(url.slice(url.lastIndexOf('/') + 1)), { status: 200 });
  return { root, execPath, asset, readerAsset, binary, fetchImpl, targets: [
    { label: 'terminal', path: execPath, assetName: asset, executable: true },
    { label: 'reader descriptor', path: execPath + '.readers.json', assetName: readerAsset, executable: false },
  ] };
}

test('forward reader admission reuses the SDK verified pins instead of hashing payloads a second time', async () => {
  const f = fixture(), hash = spyOn(crypto, 'createHash'); let retained: VerifiedUpdateStage | undefined;
  try {
    await applyVerifiedUpdate({ fetchImpl: f.fetchImpl, downloadBaseUrl: 'https://fixture.invalid/release', targets: f.targets, io: realUpdateFileIo, platform: 'darwin', native: true,
      beforeCommit(stage) {
        retained = stage;
        expect(verifiedUpdateStageMembers(stage)?.length).toBe(2);
        assertStagedClientReaderCompatible(f.execPath, f.execPath + '.update-download', realUpdateFileIo, '3.1.2', f.asset, stage);
      } });
    expect(hash).toHaveBeenCalledTimes(2); expect(readFileSync(f.execPath)).toEqual(f.binary);
    expect(retained).toBeDefined(); expect(() => verifiedUpdateStageMembers(retained!)).toThrow('unavailable');
  } finally { hash.mockRestore(); }
});

test('a fabricated stage token cannot substitute an alleged verified pin', () => {
  expect(() => verifiedUpdateStageMembers({} as VerifiedUpdateStage)).toThrow('unavailable');
});

test('a same-inode staged edit after reader admission still prevents every live replacement', async () => {
  const f = fixture(), original = readFileSync(f.execPath);
  await expect(applyVerifiedUpdate({ fetchImpl: f.fetchImpl, downloadBaseUrl: 'https://fixture.invalid/release', targets: f.targets, io: realUpdateFileIo, platform: 'darwin', native: true,
    beforeCommit(stage) {
      assertStagedClientReaderCompatible(f.execPath, f.execPath + '.update-download', realUpdateFileIo, '3.1.2', f.asset, stage);
      writeFileSync(f.execPath + '.update-download', 'Mutated staged terminal bytes');
    } })).rejects.toThrow();
  expect(readFileSync(f.execPath)).toEqual(original);
});
