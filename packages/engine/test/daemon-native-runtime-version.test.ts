import { expect, test } from 'bun:test';
import { assertDaemonNativePayloadPins, sha256 } from '../platform/src/platform/runtime/self-update.js';
import { nativeDescriptorFixture } from './_helpers/daemon-native-cohort.js';

function candidate(metadata: (digest: string, target: string) => Record<string, unknown>) {
  const descriptor = nativeDescriptorFixture({ version: '1.2.3' }).artifact;
  const bun = Buffer.from('bundled bun runtime of the candidate release');
  const digest = sha256(bun);
  const files = descriptor.files.map((file, index) => index === 1 ? { ...file, sha256: digest, size: bun.length } : file);
  return {
    artifact: { ...descriptor, files },
    files,
    metadata: Buffer.from(JSON.stringify(metadata(digest, descriptor.target))),
  };
}

const metadataFor = (version: string, overrides: Record<string, unknown> = {}) => (digest: string, target: string) => ({
  version, target, source: 'build-interpreter', sha256: digest,
  upstreamSource: `https://github.com/oven-sh/bun/tree/bun-v${version}`, ...overrides,
});

test('a candidate release built on a different captured Bun still verifies when its metadata agrees with its own payload', () => {
  const c = candidate(metadataFor('1.4.0'));
  expect(() => assertDaemonNativePayloadPins(c.artifact, c.files, c.metadata)).not.toThrow();
});

test('metadata whose version and upstream source disagree is refused', () => {
  const c = candidate(metadataFor('1.4.0', { upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' }));
  expect(() => assertDaemonNativePayloadPins(c.artifact, c.files, c.metadata)).toThrow('provenance is invalid');
});

test('a different version cannot launder a digest that is not the bundled runtime', () => {
  const c = candidate(metadataFor('1.4.0', { sha256: '0'.repeat(64) }));
  expect(() => assertDaemonNativePayloadPins(c.artifact, c.files, c.metadata)).toThrow('provenance is invalid');
});

test('a version that is not a plain release number is refused', () => {
  const c = candidate(metadataFor('latest'));
  expect(() => assertDaemonNativePayloadPins(c.artifact, c.files, c.metadata)).toThrow('provenance is invalid');
});
