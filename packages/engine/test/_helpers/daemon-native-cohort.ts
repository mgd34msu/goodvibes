import { dirname, join } from 'node:path';
import { resolveDaemonNativePayloads, sha256, type DaemonCiArtifact, type NativeReaderCapabilities } from '../../platform/src/platform/runtime/self-update.ts';

interface NativeCohortOptions {
  readonly version: string;
  readonly daemonBytes: string;
  readonly bunBytes?: string;
  readonly addonBytes?: string;
  readonly arch?: 'x64' | 'arm64';
  readonly readers?: NativeReaderCapabilities;
  /** Deliberately invalid provenance controls are serialized before pinning. */
  readonly runtimeProvenanceTarget?: 'linux-x64' | 'linux-arm64';
  readonly sourceCommit?: string;
  readonly readerSourceTree?: string;
}
function fixtureArtifact(arch: 'x64' | 'arm64', files: DaemonCiArtifact['files'], readers: NativeReaderCapabilities | undefined, sourceCommit: string): DaemonCiArtifact {
  const base = { schema: 1, sourceCommit, sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), target: `linux-${arch}`, files } satisfies DaemonCiArtifact;
  return readers === undefined ? base : { ...base, schema: 2, readers };
}
function fixtureReceipt(version: string, artifact: DaemonCiArtifact): Buffer {
  return Buffer.from(JSON.stringify({ schema: 1, packageName: '@goodvibes/daemon', version, artifact }));
}

/** Actual installed bytes/receipt. Five member pins; no release manifest. */
export function nativeCohortFixture(options: NativeCohortOptions) {
  const { version, daemonBytes, bunBytes, addonBytes, arch = 'x64', readers,
    runtimeProvenanceTarget, sourceCommit = 'a'.repeat(40), readerSourceTree } = options;
  const payloads = resolveDaemonNativePayloads('linux', arch);
  if (!payloads) throw new Error('Native fixture requires a supported Linux target');
  const daemonAsset = `goodvibes-daemon-linux-${arch}`;
  const bun = Buffer.from(bunBytes ?? `bun-${version}`), bunPin = sha256(bun);
  const bodies = [Buffer.from(daemonBytes), bun, Buffer.from(`Bun license ${version}\n`),
    Buffer.from(JSON.stringify({ version: '1.3.14', target: runtimeProvenanceTarget ?? `linux-${arch}`, source: 'build-interpreter',
      sha256: bunPin, upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' })),
    Buffer.from(addonBytes ?? `addon-${version}`)];
  const members = payloads.map((payload, index) => {
    const bytes = bodies[index]; if (!bytes) throw new Error('Native fixture payload count changed');
    return { ...payload, bytes, mode: payload.executable ? 0o755 : 0o644 };
  });
  const files = members.map(member => ({ path: member.relativePath, sha256: member.bytes === bun ? bunPin : sha256(member.bytes), mode: member.mode, size: member.bytes.length }));
  const compatible = fixtureArtifact(arch, files, undefined, sourceCommit);
  const artifact: DaemonCiArtifact = readers === undefined ? compatible : { ...compatible, schema: 2, readers };
  const receipt = fixtureReceipt(version, artifact);
  const assets = Object.fromEntries(members.map(member => [member.assetName, member.bytes]));
  assets[`${daemonAsset}.ci-artifact.json`] = Buffer.from(JSON.stringify(compatible));
  if (artifact.schema === 2) assets[`${daemonAsset}.reader-ci-artifact.json`] = Buffer.from(JSON.stringify(
    readerSourceTree === undefined ? artifact : { ...artifact, sourceTree: readerSourceTree }));
  return { members, artifact, receipt, assets,
    installation(execPath: string, suffix = ''): Record<string, Buffer> {
      return Object.fromEntries([...members.map((member, index) => {
        const path = index === 0 ? execPath : member.relativePath.startsWith(`${daemonAsset}.`)
          ? execPath + member.relativePath.slice(daemonAsset.length) : join(dirname(execPath), member.relativePath);
        return [path + suffix, member.bytes];
      }), [join(dirname(execPath), 'daemon-installation.json') + suffix, receipt]]);
    },
  };
}

export function fixtureStrings(files: Record<string, Buffer>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, bytes.toString('utf8')]));
}
