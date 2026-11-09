/** Fixed companion paths/provenance source. Runtime execution deferred. */
import { expect, test } from 'bun:test';
import { clientReaderPayloadPaths, clientReaderMemberPath, clientReaderMemberAsset, parseClientReaderArtifact,
  nativeReaderCapabilities } from '../sdk/src/platform/runtime/self-update.js';
for (const arch of ['x64', 'arm64'] as const) test(`Darwin ${arch} daemon readers bind exactly their binary, vector and compiled SQLite companions`, () => {
  const target = `darwin-${arch}` as const, packageName = '@goodvibes-jev/daemon' as const, root = '/fixture/native', execPath = root + '/goodvibes-daemon';
  const paths = clientReaderPayloadPaths(packageName, target);
  const raw = { schema: 1, packageName, target, version: '3.1.2', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40),
    readers: nativeReaderCapabilities('3.1.2'), files: paths.map((path, index) => ({ path, sha256: 'c'.repeat(64), size: 64, mode: index === 0 ? 0o755 : 0o644 })) };
  const artifact = parseClientReaderArtifact(raw);
  expect(artifact.files).toHaveLength(4);
  expect(clientReaderMemberPath(execPath, artifact, paths[1]!, '.previous')).toBe(`${root}/lib/sqlite-vec-${target}/vec0.dylib.previous`);
  expect(clientReaderMemberAsset(artifact, paths[1]!)).toBe(`sqlite-vec-${target}.dylib`);
  expect(clientReaderMemberPath(execPath, artifact, paths[3]!, '.update-download')).toBe(`${root}/lib/sqlite-${target}/libsqlite3.dylib.json.update-download`);
  expect(clientReaderMemberAsset(artifact, paths[3]!)).toBe(`sqlite-${target}.dylib.json`);
  expect(() => clientReaderMemberPath(execPath, artifact, '../foreign')).toThrow();
  expect(() => clientReaderMemberPath(execPath, artifact, paths[1]!, '/../foreign' as never)).toThrow();
  expect(() => parseClientReaderArtifact({ ...raw, files: raw.files.map((file, index) => index === 1 ? { ...file, path: `lib/sqlite-vec-${target}/../foreign` } : file) })).toThrow();
  expect(() => parseClientReaderArtifact({ ...raw, files: raw.files.map((file, index) => index === 1 ? { ...file, mode: 0o777 } : file) })).toThrow();
  expect(parseClientReaderArtifact({ ...raw, files: raw.files.slice(0, 1) }).files).toHaveLength(1);
});
