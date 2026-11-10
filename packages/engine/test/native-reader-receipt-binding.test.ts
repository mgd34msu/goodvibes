import { expect, test } from 'bun:test';
import { parseDaemonInstallationReceipt, resolveDaemonInstallationReaders, nativeReaderCapabilities,
  type DaemonInstallationReceipt } from '../platform/src/platform/runtime/self-update.ts';
import { nativeDescriptorFixture } from './_helpers/daemon-native-cohort.ts';

function fixture() {
  const previous = nativeDescriptorFixture({ version: '3.1.2' });
  const current = nativeDescriptorFixture({ version: '3.1.3', readers: nativeReaderCapabilities('3.1.3') });
  const readers = nativeReaderCapabilities('3.1.2');
  const candidate = parseDaemonInstallationReceipt(JSON.parse(previous.receipt.toString()), 'linux-x64');
  const companion = parseDaemonInstallationReceipt({ ...JSON.parse(current.receipt.toString()),
    previousReader: { version: '3.1.2', artifact: { ...previous.artifact, schema: 2, readers } },
  }, 'linux-x64');
  return { candidate, companion, readers };
}

test('an original four-key receipt remains unknown without retained evidence from its running program', () => {
  const f = fixture();
  expect(f.candidate.artifact.schema).toBe(1);
  expect(resolveDaemonInstallationReaders(f.candidate, null)).toBeUndefined();
  const withoutEvidence: DaemonInstallationReceipt = { schema: f.companion.schema, packageName: f.companion.packageName,
    version: f.companion.version, artifact: f.companion.artifact };
  expect(resolveDaemonInstallationReaders(f.candidate, withoutEvidence)).toBeUndefined();
  expect(resolveDaemonInstallationReaders(f.candidate, f.companion)).toEqual(f.readers);
  expect(Object.keys(f.candidate)).toEqual(['schema', 'packageName', 'version', 'artifact']);
});

for (const change of ['version', 'sourceCommit', 'sourceTree', 'headCommit', 'target', 'path', 'sha256', 'mode', 'size'] as const) {
  test(`previous-reader evidence cannot migrate to another cohort with different ${change}`, () => {
    const f = fixture(), original = f.candidate.artifact;
    const candidate = change === 'version' ? { ...f.candidate, version: '3.1.4' } : {
      ...f.candidate, artifact: {
        ...original,
        ...(change === 'sourceCommit' || change === 'sourceTree' || change === 'headCommit' ? { [change]: 'f'.repeat(40) } : {}),
        ...(change === 'target' ? { target: 'linux-arm64' as const } : {}),
        files: original.files.map((file, index) => index !== 0 ? file : {
          ...file, ...(change === 'path' ? { path: 'foreign' } : {}), ...(change === 'sha256' ? { sha256: 'f'.repeat(64) } : {}),
          ...(change === 'mode' ? { mode: 0o644 } : {}), ...(change === 'size' ? { size: file.size + 1 } : {}),
        }),
      },
    };
    expect(resolveDaemonInstallationReaders(candidate, f.companion)).toBeUndefined();
  });
}

test('receipt admission rejects malformed and version-mismatched previous-reader evidence', () => {
  const f = fixture(), evidence = f.companion.previousReader;
  if (!evidence) throw new Error('Fixture evidence missing');
  for (const previousReader of [undefined, {}, { ...evidence, extra: true }, { ...evidence, version: '3.1.9' },
    { ...evidence, artifact: f.candidate.artifact },
    { ...evidence, artifact: { ...evidence.artifact, readers: { ...evidence.artifact.readers, formats: ['x', 'x'] } } }]) {
    expect(() => parseDaemonInstallationReceipt({ ...f.companion, previousReader }, 'linux-x64')).toThrow();
  }
  for (const artifact of [f.candidate.artifact, { ...f.companion.artifact, readers: { schema: 1, version: '3.1.3', formats: ['payment-retained-holds-v2'] } }]) {
    expect(() => parseDaemonInstallationReceipt({ ...f.companion, artifact }, 'linux-x64')).toThrow('does not confirm support');
  }
});
