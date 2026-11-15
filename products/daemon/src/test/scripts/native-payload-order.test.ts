import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, mock, test } from 'bun:test';
import * as selfUpdate from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import * as toolchain from '@goodvibes-jev/engine/toolchain';
import { makeOwnedTempDir } from '../helpers/owned-temp.ts';

// The engine declares the cohort; this runs the daemon scripts against a declaration whose order
// differs from today's, so a position assumption (first two executable, fourth is metadata) fails.
const real = selfUpdate.resolveDaemonNativePayloads('linux', 'x64')!;
const reordered = [...real].reverse();
const metadataPath = reordered.find((payload) => payload.relativePath.endsWith('.bun.json'))!.relativePath;
expect(reordered.findIndex((payload) => payload.relativePath === metadataPath)).not.toBe(3);

let pinArgs: { files: unknown; metadata: Buffer | undefined } | undefined;
class PinsReached extends Error {}
mock.module('@goodvibes-jev/engine/platform/platform/runtime/self-update', () => ({
  ...selfUpdate,
  resolveDaemonNativePayloads: (platform: string, arch: string) => (platform === 'linux' && arch === 'x64' ? reordered : selfUpdate.resolveDaemonNativePayloads(platform, arch)),
  parseDaemonCiArtifact: (value: unknown) => value,
  assertDaemonNativePayloadPins: (_artifact: unknown, files: unknown, metadata: Buffer | undefined) => { pinArgs = { files, metadata }; throw new PinsReached(); },
}));
mock.module('@goodvibes-jev/engine/toolchain', () => ({ ...toolchain, nativeArtifactPins: () => ({}) }));

const { stageDaemonCiArchive } = await import('../../../scripts/acquire-native.ts');
const { installDaemonNative } = await import('../../../scripts/install-native.ts');
const { targetPaths } = await import('../../cli/native-installation.ts');
const { daemonCiMetadataPath } = await import('../../cli/native-artifact.ts');

const owner = { target: 'linux-x64', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), version: '1.2.3' } as const;

function writeCohort(root: string): void {
  for (const payload of reordered) {
    const full = join(root, 'native', payload.relativePath); mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, payload.relativePath === metadataPath ? 'metadata-bytes' : `bytes-of-${payload.relativePath}`);
    chmodSync(full, payload.executable ? 0o755 : 0o644);
  }
  const files = reordered.map((payload) => { const full = join(root, 'native', payload.relativePath);
    return { path: payload.relativePath, sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), mode: statSync(full).mode & 0o777, size: statSync(full).size }; });
  writeFileSync(join(root, 'native/ci-artifact.json'), JSON.stringify({ schema: 1, ...owner, files }));
}

test('staging an archive checks each member against the declared mode, whatever the declaration order', () => {
  const root = makeOwnedTempDir('daemon-payload-order');
  const source = join(root, 'src/products/daemon'); writeCohort(source);
  const members = [...reordered.map((payload) => payload.relativePath), 'ci-artifact.json'].map((path) => `products/daemon/native/${path}`);
  execFileSync('tar', ['-czf', join(root, 'a.tgz'), '-C', join(root, 'src'), ...members]);
  const staged = stageDaemonCiArchive(readFileSync(join(root, 'a.tgz')), join(root, 'staged'));
  for (const payload of reordered) {
    expect(statSync(join(staged, 'native', payload.relativePath)).mode & 0o777).toBe(payload.executable ? 0o755 : 0o644);
  }
  // A member with the wrong mode for its declared position is refused.
  const wrong = reordered.find((payload) => payload.executable)!;
  chmodSync(join(source, 'native', wrong.relativePath), 0o644);
  execFileSync('tar', ['-czf', join(root, 'b.tgz'), '-C', join(root, 'src'), ...members]);
  expect(() => stageDaemonCiArchive(readFileSync(join(root, 'b.tgz')), join(root, 'staged-wrong'))).toThrow('mode');
  expect(existsSync(join(root, 'staged-wrong'))).toBe(false);
});

test('installed targets take their executable flag from the declaration, not the position', () => {
  const installed = targetPaths(makeOwnedTempDir('daemon-payload-order'), 'linux-x64');
  expect(installed.map((entry) => entry.executable)).toEqual([...reordered.map((payload) => payload.executable), false]);
  expect(daemonCiMetadataPath('linux-x64')).toBe(metadataPath);
});

test('the install checks the runtime pins against the declared metadata file, not the fourth payload', async () => {
  const root = makeOwnedTempDir('daemon-payload-order');
  const artifactRoot = join(root, 'artifact'); writeCohort(artifactRoot);
  await expect(installDaemonNative({ artifactRoot, prefix: join(root, 'prefix'), owner })).rejects.toBeInstanceOf(PinsReached);
  expect(pinArgs?.metadata?.toString()).toBe('metadata-bytes');
});
