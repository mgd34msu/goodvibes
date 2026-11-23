// Proves: Assets come only from the authorised repository and are checked before anything is replaced, a failed or interrupted update leaves the previous programs, a release that cannot read the saved data is refused, and it does not run over the daemon's own updater or a checkout installation.
// Red when: An asset comes from outside the authorised release or with a wrong checksum, a failed or hung-up update leaves programs changed or a claim behind, an older release is installed over data it cannot read, or the installer runs over the updater's claim or a checkout installation.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeReaderCapabilities } from '../packages/engine/platform/src/platform/runtime/self-update.ts';
import { AGENT_RELEASE_EVIDENCE_ID, TUI_RELEASE_EVIDENCE_ID } from '../packages/engine/platform/src/platform/runtime/native-cohort-table.ts';
import { COMPILED_VERSION } from '../products/daemon/src/version.ts';

let root: string, assets: string, home: string;
// The fixture delegates reader checks to the actual source command handler;
// its released descriptors must identify that handler's compiled version.
const version = COMPILED_VERSION;
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function writeChecksums() {
  writeFileSync(join(assets, 'SHA256SUMS.txt'), readdirSync(assets).filter(name => name !== 'SHA256SUMS.txt').map(name => `${digest(join(assets, name))}  ${name}\n`).join(''));
}
function terminalReaderArtifact(command: 'goodvibes' | 'goodvibes-agent') {
  const asset = `${command}-linux-x64`;
  return { schema: 1, packageName: command === 'goodvibes' ? TUI_RELEASE_EVIDENCE_ID : AGENT_RELEASE_EVIDENCE_ID, version, target: 'linux-x64',
    sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40),
    files: ['', '.bun', '.bun.LICENSE.md', '.bun.json'].map(ending => ({ path: asset + ending, sha256: digest(join(assets, asset + ending)),
      mode: ending === '' || ending === '.bun' ? 0o755 : 0o644, size: statSync(join(assets, asset + ending)).size })),
    readers: nativeReaderCapabilities(version) };
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goodvibes-release-install-'));
  assets = join(root, 'assets'); home = join(root, 'home with spaces');
  mkdirSync(assets); mkdirSync(home);
  for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    const binary = `${command}-linux-x64`;
    const retire = command === 'goodvibes' ? 'if [ "$FIXTURE_RETIRE_PREFIX" = 1 ]; then mv "$HOME/bin" "$HOME/retired-bin"; mkdir "$HOME/bin"; printf foreign > "$HOME/bin/foreign"; fi; ' : '';
    writeFileSync(join(assets, binary), `#!/bin/sh\ncase "$1" in --version) ${retire}echo '${command} ${version}' ;; webui) echo 'http://127.0.0.1:3421' ;; check-install-reader) exec "$FIXTURE_REAL_BUN" "$FIXTURE_READER_CLI" "$@" ;; esac\n`);
    writeFileSync(join(assets, binary + '.bun'), '#!/bin/sh\n[ "$1" = -e ] || exit 77\nexec "$FIXTURE_REAL_BUN" "$@"\n');
    writeFileSync(join(assets, binary + '.bun.json'), JSON.stringify({ version: '1.3.14', target: 'linux-x64', source: 'build-interpreter', sha256: digest(join(assets, binary + '.bun')), upstreamSource: 'https://github.com/oven-sh/bun/tree/bun-v1.3.14' }));
    writeFileSync(join(assets, binary + '.bun.LICENSE.md'), 'Fixture runtime notice');
  }
  writeFileSync(join(assets, 'sqlite-vec-linux-x64.so'), 'fixture native addon');
  const artifact = { schema: 1, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), headCommit: 'a'.repeat(40), target: 'linux-x64',
    files: ['goodvibes-daemon-linux-x64', 'goodvibes-daemon-linux-x64.bun', 'goodvibes-daemon-linux-x64.bun.LICENSE.md', 'goodvibes-daemon-linux-x64.bun.json', 'lib/sqlite-vec-linux-x64/vec0.so'].map((path, i) => {
      const file = join(assets, i === 4 ? 'sqlite-vec-linux-x64.so' : path);
      return { path, sha256: digest(file), mode: i < 2 ? 0o755 : 0o644, size: statSync(file).size };
    }) };
  writeFileSync(join(assets, 'goodvibes-daemon-linux-x64.ci-artifact.json'), JSON.stringify(artifact));
  for (const command of ['goodvibes', 'goodvibes-agent'] as const) {
    writeFileSync(join(assets, `${command}-linux-x64.reader-ci-artifact.json`), JSON.stringify(terminalReaderArtifact(command), null, 2) + '\n');
  }
  const stage = join(root, 'stage'); mkdirSync(join(stage, 'playwright-core'), { recursive: true });
  for (const name of ['package.json', 'index.js', 'cli.js']) writeFileSync(join(stage, 'playwright-core', name), '{}');
  execFileSync('tar', ['-czf', join(assets, 'browser-driver.tar.gz'), '-C', stage, 'playwright-core']);
  mkdirSync(join(stage, 'goodvibes-webui')); writeFileSync(join(stage, 'goodvibes-webui/index.html'), '<title>Fixture WebUI</title>');
  execFileSync('tar', ['-czf', join(assets, `goodvibes-webui-bundle-${version}.tar.gz`), '-C', stage, 'goodvibes-webui']);
  writeChecksums();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(uninstall = false, fault?: 'prefix', platform?: 'darwin', controls: Readonly<Record<string, string>> = {}) {
  const script = resolve(import.meta.dir, 'install.sh');
  return spawnSync('sh', ['-c', `set -eu
    umask 077
    . "$1"
    if [ "$FIXTURE_DARWIN" = 1 ]; then resolve_platform() { os_tag=macos; arch_tag=x64; VEC_OS=darwin; VEC_SUFFIX=dylib; PLATFORM_SUFFIX=macos-x64; }; fi
    fetch() { printf '%s\\n' "$1" >> "$FETCH_TRACE"; cp "$FIXTURE_ASSETS/\${1##*/}" "$2"; }
    setup_daemon_service() { :; }
    restart_running_daemon() { :; }
    restart_running_agent() { :; }
    uninstall_services_and_processes() { :; }
    if [ -n "\${FIXTURE_INJECT:-}" ]; then eval "$FIXTURE_INJECT"; fi
    main
  `, 'release-installer-test', script], { encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_VERSION: `v${version}`,
      GOODVIBES_INSTALL_DIR: join(home, 'bin'), GOODVIBES_WAKE_MODEL: '0', GOODVIBES_DAEMON_SERVICE: '0', GOODVIBES_RESTART_DAEMON: '0',
      GOODVIBES_UNINSTALL: uninstall ? '1' : '0', FIXTURE_REAL_BUN: process.execPath, FIXTURE_READER_CLI: resolve(import.meta.dir, 'test-helpers/check-install-reader.ts'),
      FIXTURE_RETIRE_PREFIX: fault === 'prefix' ? '1' : '0', FIXTURE_DARWIN: platform === 'darwin' ? '1' : '0',
      FIXTURE_ASSETS: assets, FETCH_TRACE: join(root, 'fetches'), ...controls } });
}
/** Transaction leftovers that must never outlive a run, finished or rolled back. */
const transactionLeftovers = () => readdirSync(join(home, 'bin')).filter(name => /install-claim|update-transaction|\.incoming|goodvibes-previous/.test(name));
/** A previous installation the refusals below must leave byte for byte. */
function originalProgram() { mkdirSync(join(home, 'bin')); writeFileSync(join(home, 'bin/goodvibes'), 'original program'); }
const originalIntact = () => readFileSync(join(home, 'bin/goodvibes'), 'utf8') === 'original program' && !existsSync(join(home, 'bin/goodvibes-daemon'));

test('a release installs every product from verified assets of the authorised repository, and a failed update restores the previous programs', () => {
  const first = run(); expect(first.status, first.stderr).toBe(0);
  const bin = join(home, 'bin');
  for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    expect(execFileSync(join(bin, command), ['--version'], { encoding: 'utf8' }).trim()).toBe(`${command} ${version}`);
    for (const ending of ['.bun', '.bun.json', '.bun.LICENSE.md']) expect(existsSync(join(bin, command + ending))).toBe(true);
  }
  expect(existsSync(join(bin, 'playwright-core/cli.js'))).toBe(true);
  expect(existsSync(join(bin, 'webui/current/index.html'))).toBe(true);
  expect(existsSync(join(bin, 'lib/sqlite-vec-linux-x64/vec0.so'))).toBe(true);
  const urls = readFileSync(join(root, 'fetches'), 'utf8').trim().split('\n');
  expect(urls.every(url => url.startsWith(`https://github.com/mgd34msu/goodvibes/releases/download/v${version}/`))).toBe(true);

  const tracked = ['goodvibes', 'goodvibes.bun', 'goodvibes.bun.json', 'goodvibes.bun.LICENSE.md', 'goodvibes.readers.json', 'goodvibes-daemon', 'goodvibes-daemon.bun', 'goodvibes-daemon.readers.json'];
  const before = new Map(tracked.filter(name => existsSync(join(bin, name))).map(name => [name, readFileSync(join(bin, name))]));
  expect(before.size).toBeGreaterThan(4);
  // The next release's terminal cannot report its version, and one of its companions changed.
  writeFileSync(join(assets, 'goodvibes-linux-x64'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(assets, 'goodvibes-linux-x64.bun.LICENSE.md'), 'Changed runtime notice');
  writeFileSync(join(assets, 'goodvibes-linux-x64.reader-ci-artifact.json'), JSON.stringify(terminalReaderArtifact('goodvibes'), null, 2) + '\n');
  writeChecksums();
  const failed = run(); expect(failed.status).not.toBe(0);
  for (const [name, bytes] of before) expect(readFileSync(join(bin, name)), name).toEqual(bytes);
  expect(statSync(join(bin, 'goodvibes')).mode & 0o111).not.toBe(0);
  expect(transactionLeftovers()).toEqual([]);
});

test.each([['corrupt', 'INSTALL_E011']])('a %s release asset stops before replacing an existing install', (problem, id) => {
  originalProgram();
  const bundle = join(assets, `goodvibes-webui-bundle-${version}.tar.gz`);
  if (problem === 'missing') rmSync(bundle);
  else if (problem === 'corrupt') writeFileSync(bundle, 'corrupt bytes');
  else {
    const manifest = join(assets, 'SHA256SUMS.txt');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + `${digest(bundle)}  ${bundle.split('/').at(-1)}\n`);
  }
  const result = run(); expect(result.status).not.toBe(0);
  // A missing asset fails at the download; the others are refused by their checksum.
  if (id) expect(result.stderr).toContain(`(${id})`);
  expect(originalIntact()).toBe(true);
});

test('a release that cannot read the saved data is refused before replacing any installed program', () => {
  originalProgram();
  const floor = join(home, 'bin/.goodvibes-reader-requirements.json');
  const saved = JSON.stringify({ schema: 1, minimumReader: '99.0.0', formats: ['payment-retained-holds-v2'] }); writeFileSync(floor, saved);
  const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('(INSTALL_E057)');
  expect(originalIntact()).toBe(true);
  expect(readFileSync(floor, 'utf8')).toBe(saved);
  expect(transactionLeftovers()).toEqual([]);
});

test('the installer cannot replace a native updater claim or a program protected by it', () => {
  originalProgram();
  const claim = join(home, 'bin/goodvibes-daemon.update-transaction'); writeFileSync(claim, 'original updater evidence');
  const result = run(); expect(result.status).not.toBe(0);
  expect(readFileSync(claim, 'utf8')).toBe('original updater evidence');
  expect(originalIntact()).toBe(true);
  expect(readdirSync(join(home, 'bin')).filter(name => name.startsWith('.goodvibes-install-claim.'))).toEqual([]);
});

test('a hang-up during the swap rolls back and releases the claims', () => {
  // If the hang-up did not end the run, the next command would exit 99 instead of 129.
  const result = run(false, undefined, undefined, { FIXTURE_INJECT: 'install_agent() { kill -HUP $$; exit 99; }' });
  expect(result.status).toBe(129);
  expect(transactionLeftovers()).toEqual([]);
  expect(existsSync(join(home, 'bin/goodvibes'))).toBe(false);
  expect(existsSync(join(home, 'bin/goodvibes-daemon'))).toBe(false);
});

test('an existing checkout installation keeps its command links and data: install refuses, uninstall delegates to its own uninstaller', () => {
  const prefix = join(home, 'checkout-install'); mkdirSync(join(prefix, 'commands'), { recursive: true });
  mkdirSync(join(prefix, 'current/runtime'), { recursive: true });
  writeFileSync(join(prefix, 'installation.json'), '{}'); writeFileSync(join(prefix, 'current/uninstall.js'), 'owner program');
  writeFileSync(join(prefix, 'current/runtime/bun'), '#!/bin/sh\necho source-owned > "$HOME/source-uninstall-owned"\n');
  chmodSync(join(prefix, 'current/runtime/bun'), 0o755); mkdirSync(join(home, 'bin'));
  symlinkSync(join(prefix, 'commands/goodvibes'), join(home, 'bin/goodvibes'));
  const refused = run(); expect(refused.status).not.toBe(0);
  expect(existsSync(join(root, 'fetches'))).toBe(false);
  expect(existsSync(join(prefix, 'installation.json'))).toBe(true);
  const removed = run(true); expect(removed.status, removed.stderr).toBe(0);
  expect(readFileSync(join(home, 'source-uninstall-owned'), 'utf8').trim()).toBe('source-owned');
  expect(existsSync(join(root, 'fetches'))).toBe(false);
  expect(existsSync(join(prefix, 'installation.json'))).toBe(true);
});
