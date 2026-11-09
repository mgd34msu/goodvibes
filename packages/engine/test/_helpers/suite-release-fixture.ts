/** Synthetic complete release bytes and a real temporary installed suite.
 * No program execution, network or test registration occurs here. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { nativeReaderCapabilities, sha256, clientReaderMemberAsset, clientReaderPayloadPaths } from '../../sdk/src/platform/runtime/self-update.js';
import { type ClientReaderArtifact, type ClientReaderPackage, type ClientReaderTarget } from '../../sdk/src/platform/runtime/client-reader-artifact.js';

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
  // Native maintenance validates the inert Mach-O header and its exact saved
  // producer tuple too. These bytes are never executed or loaded as a library.
  const sqlitePath = join(root, 'lib/sqlite-darwin-x64/libsqlite3.dylib');
  for (const previous of [true, false]) {
    const version = previous ? '3.1.2' : '3.1.3', library = Buffer.alloc(64, previous ? 1 : 2);
    library.writeUInt32LE(0xfeedfacf, 0); library.writeUInt32LE(0x01000007, 4); library.writeUInt32LE(6, 12);
    const owner = Buffer.from(JSON.stringify({ schema: 1, packageName: '@goodvibes-jev/daemon', daemonVersion: version,
      target: 'darwin-x64', sqliteVersion: '3.54.0', sourceUrl: 'https://www.sqlite.org/2026/sqlite-autoconf-3540000.tar.gz',
      sourceSha3: 'c'.repeat(64), sha256: sha256(library), size: library.length }));
    if (previous) {
      writeFileSync(sqlitePath, library); writeFileSync(sqlitePath + '.json', owner);
      original.set(sqlitePath, library); original.set(sqlitePath + '.json', owner);
    } else { release.set('sqlite-darwin-x64.dylib', library); release.set('sqlite-darwin-x64.dylib.json', owner); }
  }
  // Darwin's daemon artifact binds its complete native cohort, not only the
  // program. Terminal-only Darwin artifacts remain single-file profiles.
  const daemon = join(root, 'goodvibes-daemon'), daemonAsset = 'goodvibes-daemon-macos-x64';
  for (const previous of [true, false]) {
    const metadata = JSON.parse((previous ? original.get(daemon + '.readers.json') : release.get(daemonAsset + '.reader-ci-artifact.json'))!.toString()) as ClientReaderArtifact;
    const files = clientReaderPayloadPaths('@goodvibes-jev/daemon', 'darwin-x64').map(path => {
      const bytes = previous ? original.get(path === daemonAsset ? daemon : join(root, path)) : release.get(clientReaderMemberAsset(metadata, path));
      if (!bytes) throw new Error('Missing synthetic Darwin daemon cohort member');
      return { path, sha256: sha256(bytes), size: bytes.length, mode: path === daemonAsset ? 0o755 : 0o644 };
    });
    const bytes = Buffer.from(JSON.stringify({ ...metadata, files }));
    if (previous) { writeFileSync(daemon + '.readers.json', bytes); original.set(daemon + '.readers.json', bytes); }
    else release.set(daemonAsset + '.reader-ci-artifact.json', bytes);
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

export const fixtureDigest = (bytes: string | Buffer): string => sha256(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
export function terminalFixturePayload(program: 'goodvibes' | 'goodvibes-agent', platform: NodeJS.Platform, arch: string, version: string, source: string) {
  if ((platform !== 'linux' && platform !== 'darwin') || (arch !== 'x64' && arch !== 'arm64')) throw new Error('Unsupported native fixture target');
  const target: ClientReaderTarget = `${platform}-${arch}`, asset = `${program}-${platform === 'darwin' ? 'macos' : platform}-${arch}`;
  const files = new Map<string, Buffer>([[asset, Buffer.from(source)]]);
  if (platform === 'linux') for (const ending of ['.bun', '.bun.LICENSE.md', '.bun.json']) files.set(asset + ending, Buffer.from(`${version} fixture runtime ${ending}\n`));
  const metadata: ClientReaderArtifact = { schema: 1, packageName: program === 'goodvibes' ? '@goodvibes-jev/tui' : '@goodvibes-jev/agent', version, target,
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40), readers: nativeReaderCapabilities(version),
    files: [...files].map(([path, bytes]) => ({ path, sha256: fixtureDigest(bytes), mode: path === asset || path === asset + '.bun' ? 0o755 : 0o644, size: bytes.length })),
  };
  return { asset, target, files, metadata: Buffer.from(JSON.stringify(metadata)) };
}
export function installTerminalFixture(root: string, program: 'goodvibes' | 'goodvibes-agent', platform: NodeJS.Platform, arch: string, version: string, source: string) {
  const payload = terminalFixturePayload(program, platform, arch, version, source), appPath = join(root, program);
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
export function terminalFixtureRelease(program: 'goodvibes' | 'goodvibes-agent', platform: NodeJS.Platform, arch: string, version: string, source: string) {
  const payload = terminalFixturePayload(program, platform, arch, version, source), assets = new Map(payload.files);
  assets.set(payload.asset + '.reader-ci-artifact.json', payload.metadata);
  assets.set(`sqlite-vec-${payload.target}.${platform === 'linux' ? 'so' : 'dylib'}`, Buffer.from('new-addon'));
  assets.set('browser-driver.tar.gz', suiteArchive({ 'playwright-core/package.json': '{}', 'playwright-core/index.js': 'new-driver', 'playwright-core/cli.js': 'new-cli' }));
  assets.set(`goodvibes-webui-bundle-${version}.tar.gz`, suiteArchive({ 'goodvibes-webui/index.html': 'new-webui' }));
  return { assets, payload };
}
