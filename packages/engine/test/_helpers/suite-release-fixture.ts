/** Synthetic complete release bytes and a real temporary installed suite.
 * No program execution, network or test registration occurs here. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { nativeReaderCapabilities, sha256 } from '../../sdk/src/platform/runtime/self-update.js';
import { type ClientReaderArtifact, type ClientReaderPackage } from '../../sdk/src/platform/runtime/client-reader-artifact.js';

export function suiteArchive(files: Readonly<Record<string, string>>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, value] of Object.entries(files)) {
    const data = Buffer.from(value), header = Buffer.alloc(512);
    header.write(path, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export function suiteReleaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-suite-update-'));
  const programs = [
    { name: 'goodvibes', packageName: '@goodvibes-jev/tui' },
    { name: 'goodvibes-agent', packageName: '@goodvibes-jev/agent' },
    { name: 'goodvibes-daemon', packageName: '@goodvibes-jev/daemon' },
  ] as const;
  const release = new Map<string, Buffer>(), original = new Map<string, Buffer>();
  for (const program of programs) {
    const asset = program.name + '-macos-x64', path = join(root, program.name);
    const before = Buffer.from(program.name + ' version 3.1.2'), after = Buffer.from(program.name + ' version 3.1.3');
    writeFileSync(path, before, { mode: 0o755 }); original.set(path, before); release.set(asset, after);
    const descriptor = (version: string, bytes: Buffer): ClientReaderArtifact => ({ schema: 1, packageName: program.packageName as ClientReaderPackage,
      version, target: 'darwin-x64', sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40),
      files: [{ path: asset, sha256: sha256(bytes), mode: 0o755, size: bytes.length }], readers: nativeReaderCapabilities(version) });
    const beforeMetadata = Buffer.from(JSON.stringify(descriptor('3.1.2', before)));
    writeFileSync(path + '.readers.json', beforeMetadata, { mode: 0o644 }); original.set(path + '.readers.json', beforeMetadata);
    release.set(asset + '.reader-ci-artifact.json', Buffer.from(JSON.stringify(descriptor('3.1.3', after))));
  }
  for (const [relative, asset] of [
    ['lib/sqlite-vec-darwin-x64/vec0.dylib', 'sqlite-vec-darwin-x64.dylib'],
    ['lib/sqlite-darwin-x64/libsqlite3.dylib', 'sqlite-darwin-x64.dylib'],
    ['lib/sqlite-darwin-x64/libsqlite3.dylib.json', 'sqlite-darwin-x64.dylib.json'],
  ]) {
    const path = join(root, relative!); mkdirSync(join(path, '..'), { recursive: true });
    const bytes = Buffer.from('old ' + asset); writeFileSync(path, bytes, { mode: 0o644 }); original.set(path, bytes);
    release.set(asset!, Buffer.from('new ' + asset));
  }
  const webui = join(root, 'webui', '3.1.2'), driver = join(root, 'playwright-core');
  for (const directory of [webui, driver]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, '.goodvibes-release.json'), JSON.stringify({ schema: 1, version: '3.1.2' }));
    writeFileSync(join(directory, 'original.txt'), 'Retained original directory');
  }
  release.set('browser-driver.tar.gz', suiteArchive({ 'playwright-core/package.json': '{}', 'playwright-core/index.js': 'new driver', 'playwright-core/cli.js': 'new cli' }));
  release.set('goodvibes-webui-bundle-3.1.3.tar.gz', suiteArchive({ 'goodvibes-webui/index.html': 'New WebUI', 'goodvibes-webui/assets/app.js': 'new frontend' }));
  writeFileSync(join(root, '.goodvibes-reader-requirements.json'), JSON.stringify({ schema: 1, minimumReader: '3.1.2', formats: ['knowledge-schema-v12'] }), { mode: 0o600 });
  const fetchImpl = async (url: string) => {
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (name === 'SHA256SUMS.txt') return new Response([...release].map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`).join(''));
    const bytes = release.get(name); return new Response(bytes ?? 'missing', { status: bytes ? 200 : 404 });
  };
  return { cleanup() { rmSync(root, { recursive: true, force: true }); }, root, webui, driver, programs, release, original, fetchImpl, options: { execPath: join(root, 'goodvibes'), platform: 'darwin' as const, arch: 'x64', version: '3.1.3',
    webuiDirectory: webui, downloadBaseUrl: 'https://fixture.invalid/v3.1.3', fetchImpl } };
}
