/** The old exact descriptor protocol must survive adding candidate capabilities. */
import { expect, test } from 'bun:test';
import { daemonReleaseArtifactDescriptors } from '../../../.github/scripts/stage-native-release-assets.mjs';
import { nativeReaderCapabilities, parseDaemonCiArtifact } from '../platform/src/platform/runtime/self-update.js';
import { nativeDescriptorFixture } from './_helpers/daemon-native-cohort.js';

test('public native descriptors preserve the released six-key v1 protocol and the exact richer CI evidence', () => {
  const f = nativeDescriptorFixture({ version: '3.1.2', readers: nativeReaderCapabilities('3.1.2') });
  const bytes = Buffer.from(JSON.stringify(f.artifact)); const pair = daemonReleaseArtifactDescriptors(f.artifact, bytes);
  const compatible = JSON.parse(pair.compatible.toString('utf8'));
  // This fixed key set is the exact v3.1.1 parser contract, inspected from its tag.
  expect(Object.keys(compatible).sort()).toEqual(['files', 'headCommit', 'schema', 'sourceCommit', 'sourceTree', 'target']);
  expect(compatible.schema).toBe(1); expect(compatible.files).toEqual(f.artifact.files);
  expect(parseDaemonCiArtifact(compatible, 'linux-x64').schema).toBe(1);
  expect(pair.capable).toEqual(bytes); expect(parseDaemonCiArtifact(JSON.parse(pair.capable.toString('utf8')), 'linux-x64')).toEqual(f.artifact);
});

test('a profile from another source cannot be published beside an unrelated compatible descriptor', () => {
  const f = nativeDescriptorFixture({ version: '3.1.2', readers: nativeReaderCapabilities('3.1.2') });
  const foreign = { ...f.artifact, sourceTree: 'f'.repeat(40) };
  expect(() => daemonReleaseArtifactDescriptors(f.artifact, Buffer.from(JSON.stringify(foreign)))).toThrow('reader evidence changed');
});
