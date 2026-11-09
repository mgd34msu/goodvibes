import { mkdirSync, chmodSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nativeReaderCapabilities, resolveDaemonNativePayloads, resolveDaemonNativeTargets, sha256, type DaemonInstallationReceipt, type DaemonArtifactSource, type DaemonCiArtifact } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import type { DaemonNativeTarget } from '../../cli/native-artifact.ts';
/** Metadata fixture for inert/synthetic interpreters; it does not claim actual ELF execution. */
export function nativeRuntimeProvenance(runtime: string, target: DaemonNativeTarget = 'linux-x64'): string {
  return JSON.stringify({ version: '1.3.14', target, source: 'build-interpreter', sha256: sha256(Buffer.from(runtime)),
    upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' });
}

/** Explicit old-format inert fixture. It certifies no execution or reader
 * capabilities and must never be used as v2 capability evidence. */
export function writeV1NativeArtifactFixture(root: string, source: DaemonArtifactSource): DaemonCiArtifact {
  const target = source.target ?? 'linux-x64'; const payloads = resolveDaemonNativePayloads('linux', target.slice('linux-'.length));
  if (!payloads) throw new Error('Unsupported fixture target');
  const artifact: DaemonCiArtifact = { schema: 1, sourceCommit: source.sourceCommit, sourceTree: source.sourceTree, headCommit: source.headCommit, target,
    files: payloads.map(payload => { const path = join(root, 'native', payload.relativePath); const stat = lstatSync(path);
      return { path: payload.relativePath, sha256: sha256(readFileSync(path)), mode: stat.mode & 0o777, size: stat.size };
    }) };
  writeFileSync(join(root, 'native/ci-artifact.json'), JSON.stringify(artifact)); return artifact;
}

/** Executable shell fixture of the compiled read-only capability protocol. */
export function nativeReaderProbeScript(version: string, fallback = ''): string {
  return `#!/bin/sh\nif [ "$1" = check-install-reader ] && [ "$2" = --describe ]; then\n  printf '%s\\n' '${JSON.stringify(nativeReaderCapabilities(version))}'\n  exit 0\nfi\n${fallback}\n`;
}

/** Complete inert native metadata; no fixture payload is executed. */
export function writeNativeInstallationFixture(prefix: string, version: string, arch: 'x64' | 'arm64' = 'x64') {
  const target = arch === 'x64' ? 'linux-x64' : 'linux-arm64';
  const payloads = resolveDaemonNativePayloads('linux', arch);
  const execPath = join(prefix, `goodvibes-daemon-linux-${arch}`);
  const targets = resolveDaemonNativeTargets(execPath, 'linux', arch);
  if (!payloads || !targets) throw new Error('Fixture requires the native Linux contract');
  const runtime = `synthetic runtime ${version}`;
  const buffers = [Buffer.from(`synthetic daemon ${version}`), Buffer.from(runtime), Buffer.from('synthetic runtime license'),
    Buffer.from(nativeRuntimeProvenance(runtime, target)), Buffer.from(`synthetic addon ${version}`)];
  const artifact = {
    schema: 1, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'c'.repeat(40), target,
    files: payloads.map((payload, index) => {
      const bytes = buffers[index];
      if (!bytes) throw new Error('Fixture payload count changed');
      return { path: payload.relativePath, sha256: sha256(bytes), mode: payload.executable ? 0o755 : 0o644, size: bytes.length };
    }),
  } satisfies DaemonInstallationReceipt['artifact'];
  const receipt = { schema: 1, packageName: '@goodvibes-jev/daemon', version, artifact } satisfies DaemonInstallationReceipt;
  const assets: Record<string, Buffer> = {};
  for (const [index, member] of targets.entries()) {
    const bytes = buffers[index] ?? Buffer.from(JSON.stringify(receipt));
    mkdirSync(dirname(member.path), { recursive: true });
    writeFileSync(member.path, bytes); chmodSync(member.path, member.executable ? 0o755 : 0o644);
    assets[member.assetName] = index === buffers.length ? Buffer.from(JSON.stringify(artifact)) : bytes;
  }
  return { execPath, targets, buffers, receipt, assets,
    options: { bundled: true, execPath, version, platform: 'linux', arch,
      runningExecutableIdentity: () => { const stat = lstatSync(execPath, { bigint: true }); return `${stat.dev}:${stat.ino}`; } },
    checksumManifest: Object.entries(assets).map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''),
  };
}

/** Explicit current-reader variant. These are still inert original fixtures,
 * not compiled capability probes; historical v1 callers remain unchanged. */
export function writeNativeReaderInstallationFixture(prefix: string, version: string, arch: 'x64' | 'arm64' = 'x64') {
  const original = writeNativeInstallationFixture(prefix, version, arch);
  const artifact: Extract<DaemonCiArtifact, { schema: 2 }> = { ...original.receipt.artifact, schema: 2, readers: nativeReaderCapabilities(version) };
  const receipt: DaemonInstallationReceipt = { ...original.receipt, artifact };
  const target = original.targets.at(-1);
  if (!target) throw new Error('Native fixture installation receipt is missing');
  writeFileSync(target.path, JSON.stringify(receipt)); chmodSync(target.path, 0o644);
  return { ...original, receipt };
}
