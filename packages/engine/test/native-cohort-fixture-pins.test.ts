import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { assertDaemonNativePayloadBytes, nativeReaderCapabilities, parseChecksumFile, parseDaemonInstallationReceipt } from '../platform/src/platform/runtime/self-update.js';
import { nativeCohortFixture, nativeCohortReleaseFixture, nativeDescriptorFixture } from './_helpers/daemon-native-cohort.js';

function verifyActualBytes(cohort: ReturnType<typeof nativeCohortFixture>) {
  // Real independent byte verification, not a comparison of fixture metadata.
  expect(() => assertDaemonNativePayloadBytes(cohort.artifact, cohort.members.map(member => member.bytes))).not.toThrow();
  const changed = cohort.members.map(member => member.bytes);
  const tampered = Buffer.from(cohort.members[0]!.bytes);
  tampered[0] = tampered[0]! ^ 1; changed[0] = tampered;
  expect(() => assertDaemonNativePayloadBytes(cohort.artifact, changed)).toThrow('differs');
}

for (const readers of [undefined, nativeReaderCapabilities('3.1.2')]) {
  test(`installed fixture pins five actual members without a release manifest, schema ${readers ? 2 : 1}`, () => {
    const hash = spyOn(crypto, 'createHash');
    let cohort: ReturnType<typeof nativeCohortFixture>;
    try {
      cohort = nativeCohortFixture({ version: '3.1.2', daemonBytes: 'Original daemon fixture', ...(readers ? { readers } : {}) });
      expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(5);
      expect(cohort).not.toHaveProperty('checksumManifest');
      expect(JSON.parse(cohort.members[3]!.bytes.toString('utf8')).sha256).toBe(cohort.artifact.files[1]!.sha256);
    } finally { hash.mockRestore(); }
    verifyActualBytes(cohort);
  });

  test(`explicit release pins each new descriptor once and reuses original members, schema ${readers ? 2 : 1}`, () => {
    const hash = spyOn(crypto, 'createHash');
    let cohort: ReturnType<typeof nativeCohortReleaseFixture>;
    try {
      cohort = nativeCohortReleaseFixture({ version: '3.1.2', daemonBytes: 'Original daemon fixture', ...(readers ? { readers } : {}) });
      expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(readers ? 7 : 6);
      const descriptor = Object.getOwnPropertyDescriptor(cohort, 'checksumManifest');
      expect(descriptor?.value).toBe(cohort.checksumManifest); expect(descriptor?.get).toBeUndefined();
      const checksums = parseChecksumFile(cohort.checksumManifest);
      for (const [index, member] of cohort.members.entries()) {
        expect(Object.hasOwn(member, 'pin')).toBe(false);
        expect(checksums.get(member.assetName)).toBe(cohort.artifact.files[index]!.sha256);
      }
      expect(JSON.parse(cohort.members[3]!.bytes.toString('utf8')).sha256).toBe(cohort.artifact.files[1]!.sha256);
    } finally { hash.mockRestore(); }
    verifyActualBytes(cohort);
  });
}

test('malformed reader checksum does not first construct a discarded valid reader pin', () => {
  const hash = spyOn(crypto, 'createHash');
  let cohort: ReturnType<typeof nativeCohortReleaseFixture>;
  try {
    cohort = nativeCohortReleaseFixture({ version: '3.1.2', daemonBytes: 'Original daemon fixture',
      readers: nativeReaderCapabilities('3.1.2'), readerChecksum: 'not-a-digest' });
    expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(6);
    expect(cohort.checksumManifest).toContain('not-a-digest  goodvibes-daemon-linux-x64.reader-ci-artifact.json');
    expect(parseChecksumFile(cohort.checksumManifest).has('goodvibes-daemon-linux-x64.reader-ci-artifact.json')).toBe(false);
  } finally { hash.mockRestore(); }
  verifyActualBytes(cohort);
});

test('metadata-only fixture has zero body-pin work and cannot provide a native installation', () => {
  const hash = spyOn(crypto, 'createHash');
  try {
    const declared = nativeDescriptorFixture({ version: '3.1.2', readers: nativeReaderCapabilities('3.1.2') });
    expect(Object.keys(declared)).toEqual(['artifact', 'receipt']);
    expect(parseDaemonInstallationReceipt(JSON.parse(declared.receipt.toString()), 'linux-x64').artifact).toEqual(declared.artifact);
    expect(() => parseDaemonInstallationReceipt({ ...JSON.parse(declared.receipt.toString()),
      artifact: { ...declared.artifact, sourceCommit: 'main' } }, 'linux-x64')).toThrow();
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});
