import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { assertDaemonNativePayloadBytes, nativeReaderCapabilities, parseChecksumFile } from '../platform/src/platform/runtime/self-update.js';
import { nativeCohortFixture } from './_helpers/daemon-native-cohort.js';

for (const readers of [undefined, nativeReaderCapabilities('3.1.2')]) {
  test(`native fixture publishes each original member pin once with schema ${readers ? 2 : 1}`, () => {
    const hash = spyOn(crypto, 'createHash');
    let cohort: ReturnType<typeof nativeCohortFixture>;
    try {
      cohort = nativeCohortFixture({ version: '3.1.2', daemonBytes: 'Original daemon fixture', ...(readers ? { readers } : {}) });
      // Five physical payloads plus each separately serialized descriptor.
      // Bun metadata and SHA256SUMS reuse the already computed member pins.
      expect(hash.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(readers ? 7 : 6);
      const checksums = parseChecksumFile(cohort.checksumManifest);
      for (const [index, member] of cohort.members.entries()) {
        expect(Object.hasOwn(member, 'pin')).toBe(false);
        expect(checksums.get(member.assetName)).toBe(cohort.artifact.files[index]!.sha256);
      }
      expect(JSON.parse(cohort.members[3]!.bytes.toString('utf8')).sha256).toBe(cohort.artifact.files[1]!.sha256);
    } finally { hash.mockRestore(); }
    // The independent real consumer still verifies every published byte pin.
    expect(() => assertDaemonNativePayloadBytes(cohort.artifact, cohort.members.map(member => member.bytes))).not.toThrow();
    const changed = cohort.members.map(member => member.bytes);
    const tampered = Buffer.from(cohort.members[0]!.bytes);
    tampered[0] = tampered[0]! ^ 1; changed[0] = tampered;
    expect(() => assertDaemonNativePayloadBytes(cohort.artifact, changed)).toThrow('differs');
  });
}
