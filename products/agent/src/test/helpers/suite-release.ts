/** Synthetic complete suite wire for product updater regressions; never a live release. */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { nativeReaderCapabilities, type ClientReaderArtifact, type ClientReaderTarget } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
export const fixtureDigest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function fixtureTarGz(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const data = Buffer.from(text), header = Buffer.alloc(512);
    header.write(path, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export function agentFixturePayload(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) throw new Error('Unsupported native fixture target');
  const target: ClientReaderTarget = `${platform}-${arch}`, asset = `goodvibes-agent-${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  const files = new Map<string, Buffer>([[asset, Buffer.from(source)]]);
  if (platform === 'linux') for (const ending of ['.bun', '.bun.LICENSE.md', '.bun.json']) files.set(asset + ending, Buffer.from(`${version} fixture runtime ${ending}\n`));
  const metadata: ClientReaderArtifact = { schema: 1, packageName: '@goodvibes-jev/agent', version, target,
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40), readers: nativeReaderCapabilities(version),
    files: [...files].map(([path, bytes]) => ({ path, sha256: fixtureDigest(bytes), mode: path === asset || path === asset + '.bun' ? 0o755 : 0o644, size: bytes.length })),
  };
  return { asset, target, files, metadata: Buffer.from(JSON.stringify(metadata)) };
}
export function installAgentFixture(root: string, platform: NodeJS.Platform, arch: string, version: string, source: string) {
  const payload = agentFixturePayload(platform, arch, version, source), appPath = join(root, 'goodvibes-agent');
  for (const [asset, bytes] of payload.files) {
    const path = appPath + asset.slice(payload.asset.length); writeFileSync(path, bytes); chmodSync(path, asset === payload.asset || asset === payload.asset + '.bun' ? 0o755 : 0o644);
  }
  writeFileSync(appPath + '.readers.json', payload.metadata); chmodSync(appPath + '.readers.json', 0o644);
  const extension = platform === 'linux' ? 'so' : 'dylib', addonPath = join(root, 'lib', `sqlite-vec-${payload.target}`, `vec0.${extension}`);
  mkdirSync(dirname(addonPath), { recursive: true }); writeFileSync(addonPath, 'old-addon'); chmodSync(addonPath, 0o644);
  const webui = join(root, 'webui', version), driver = join(root, 'playwright-core');
  for (const path of [webui, driver]) {
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, '.goodvibes-release.json'), JSON.stringify({ schema: 1, version }));
    writeFileSync(join(path, 'index.html'), path === webui ? 'old-webui' : 'old-driver');
  }
  for (const [file, bytes] of [['package.json', '{}'], ['index.js', 'old-driver'], ['cli.js', 'old-cli']]) writeFileSync(join(driver, file!), bytes!);
  return { appPath, addonPath, webui, driver, payload };
}
export function agentFixtureRelease(platform: NodeJS.Platform, arch: string, version: string, source: string) {
  const payload = agentFixturePayload(platform, arch, version, source), assets = new Map(payload.files);
  assets.set(payload.asset + '.reader-ci-artifact.json', payload.metadata);
  assets.set(`sqlite-vec-${payload.target}.${platform === 'linux' ? 'so' : 'dylib'}`, Buffer.from('new-addon'));
  assets.set('browser-driver.tar.gz', fixtureTarGz({ 'playwright-core/package.json': '{}', 'playwright-core/index.js': 'new-driver', 'playwright-core/cli.js': 'new-cli' }));
  assets.set(`goodvibes-webui-bundle-${version}.tar.gz`, fixtureTarGz({ 'goodvibes-webui/index.html': 'new-webui' }));
  return { assets, payload };
}
