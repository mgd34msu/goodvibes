import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let root: string, assets: string, home: string;
const version = '3.1.2';
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'goodvibes-release-install-'));
  assets = join(root, 'assets'); home = join(root, 'home with spaces');
  mkdirSync(assets); mkdirSync(home);
  for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    const binary = `${command}-linux-x64`;
    const retire = command === 'goodvibes' ? 'if [ "$FIXTURE_RETIRE_PREFIX" = 1 ]; then mv "$HOME/bin" "$HOME/retired-bin"; mkdir "$HOME/bin"; printf foreign > "$HOME/bin/foreign"; fi; ' : '';
    writeFileSync(join(assets, binary), `#!/bin/sh\ncase "$1" in --version) ${retire}echo '${command} ${version}' ;; webui) echo 'http://127.0.0.1:3421' ;; check-install-reader) exec "$FIXTURE_REAL_BUN" "$FIXTURE_READER_CLI" "$@" ;; esac\n`);
    writeFileSync(join(assets, binary + '.bun'), '#!/bin/sh\n[ "$1" = -e ] || exit 77\ncp "$FIXTURE_RECEIPT" "$5"\n');
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
  writeFileSync(join(root, 'receipt.json'), JSON.stringify({schema:1,packageName:'@goodvibes-jev/daemon',version,artifact}));
  const stage = join(root, 'stage'); mkdirSync(join(stage, 'playwright-core'), { recursive: true });
  for (const name of ['package.json', 'index.js', 'cli.js']) writeFileSync(join(stage, 'playwright-core', name), '{}');
  execFileSync('tar', ['-czf', join(assets, 'browser-driver.tar.gz'), '-C', stage, 'playwright-core']);
  mkdirSync(join(stage, 'goodvibes-webui')); writeFileSync(join(stage, 'goodvibes-webui/index.html'), '<title>Fixture WebUI</title>');
  execFileSync('tar', ['-czf', join(assets, `goodvibes-webui-bundle-${version}.tar.gz`), '-C', stage, 'goodvibes-webui']);
  writeFileSync(join(assets, 'SHA256SUMS.txt'), readdirSync(assets).map(name => `${digest(join(assets, name))}  ${name}\n`).join(''));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function run(uninstall = false, fault?: 'agent' | 'prefix') {
  const script = resolve(import.meta.dir, 'install.sh');
  return spawnSync('sh', ['-c', `set -eu
    umask 077
    . "$1"
    fetch() { printf '%s\\n' "$1" >> "$FETCH_TRACE"; cp "$FIXTURE_ASSETS/\${1##*/}" "$2"; }
    setup_daemon_service() { :; }
    restart_running_daemon() { :; }
    restart_running_agent() { :; }
    migrate_legacy_installer_unit() { :; }
    uninstall_services_and_processes() { :; }
    if [ "$FIXTURE_FAIL_AFTER_PROGRAMS" = 1 ]; then install_agent() { fail 'fixture interrupted suite'; }; fi
    main
  `, 'release-installer-test', script], { encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, PATH: `${home}/bin:${process.env.PATH}`, GOODVIBES_INSTALL_SH_LIB: '1', GOODVIBES_VERSION: `v${version}`,
      GOODVIBES_INSTALL_DIR: join(home, 'bin'), GOODVIBES_WAKE_MODEL: '0', GOODVIBES_DAEMON_SERVICE: '0', GOODVIBES_RESTART_DAEMON: '0',
      GOODVIBES_UNINSTALL: uninstall ? '1' : '0', FIXTURE_REAL_BUN: process.execPath, FIXTURE_READER_CLI: resolve(import.meta.dir, 'test-helpers/check-install-reader.ts'),
      FIXTURE_FAIL_AFTER_PROGRAMS: fault === 'agent' ? '1' : '0', FIXTURE_RETIRE_PREFIX: fault === 'prefix' ? '1' : '0',
      FIXTURE_RECEIPT: join(root, 'receipt.json'), FIXTURE_ASSETS: assets, FETCH_TRACE: join(root, 'fetches') } });
}
test('released suite installs all products, companions and native receipt without a build', () => {
  const result = run(); expect(result.status, result.stderr).toBe(0);
  for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    expect(execFileSync(join(home, 'bin', command), ['--version'], {encoding:'utf8'}).trim()).toBe(`${command} ${version}`);
    for (const ending of ['.bun', '.bun.json', '.bun.LICENSE.md']) expect(existsSync(join(home, 'bin', command + ending))).toBe(true);
  }
  expect(existsSync(join(home, 'bin/playwright-core/cli.js'))).toBe(true);
  expect(existsSync(join(home, `bin/webui/${version}/index.html`))).toBe(true);
  expect(JSON.parse(readFileSync(join(home, 'bin/daemon-installation.json'), 'utf8')).version).toBe(version);
  expect(statSync(join(home, 'bin/lib/sqlite-vec-linux-x64/vec0.so')).mode & 0o777).toBe(0o644);
  const urls = readFileSync(join(root, 'fetches'), 'utf8').trim().split('\n');
  expect(urls.every(url => url.startsWith(`https://github.com/mgd34msu/goodvibes-jev/releases/download/v${version}/`))).toBe(true);
  expect(new Set(urls).size).toBe(urls.length);
  expect(result.stdout).not.toContain('Building');
});
test.each(['missing', 'corrupt', 'duplicate'])('a %s release asset stops before replacing an existing install', problem => {
  mkdirSync(join(home, 'bin')); writeFileSync(join(home, 'bin/goodvibes'), 'previous install');
  const bundle = join(assets, `goodvibes-webui-bundle-${version}.tar.gz`);
  if (problem === 'missing') rmSync(bundle);
  else if (problem === 'corrupt') writeFileSync(bundle, 'corrupt bytes');
  else {
    const manifest = join(assets, 'SHA256SUMS.txt');
    writeFileSync(manifest, readFileSync(manifest, 'utf8') + `${digest(bundle)}  ${bundle.split('/').at(-1)}\n`);
  }
  const result = run(); expect(result.status).not.toBe(0);
  expect(readFileSync(join(home, 'bin/goodvibes'), 'utf8')).toBe('previous install');
  expect(existsSync(join(home, 'bin/goodvibes-daemon'))).toBe(false);
});
test('release uninstall needs no downloads and preserves user data', () => {
  expect(run().status).toBe(0);
  mkdirSync(join(home, '.goodvibes')); writeFileSync(join(home, '.goodvibes/settings.json'), 'owner data');
  rmSync(join(root, 'fetches'));
  const result = run(true); expect(result.status, result.stderr).toBe(0);
  expect(existsSync(join(root, 'fetches'))).toBe(false);
  for (const name of ['goodvibes','goodvibes-agent','goodvibes-daemon','daemon-installation.json']) expect(existsSync(join(home, 'bin', name))).toBe(false);
  expect(readFileSync(join(home, '.goodvibes/settings.json'), 'utf8')).toBe('owner data');
});

test('saved reader requirements reject an incompatible release before replacing any installed program', () => {
  expect(run().status).toBe(0);
  const programs = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent', 'goodvibes-daemon.bun', 'daemon-installation.json'];
  const before = programs.map(name => readFileSync(join(home, 'bin', name)));
  const floor = join(home, 'bin/.goodvibes-reader-requirements.json');
  const saved = JSON.stringify({ schema: 1, minimumReader: '3.2.0', formats: ['payment-retained-holds-v2'] }); writeFileSync(floor, saved);
  const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('requires GoodVibes 3.2.0');
  for (const [index, name] of programs.entries()) expect(readFileSync(join(home, 'bin', name))).toEqual(before[index]);
  expect(readFileSync(floor, 'utf8')).toBe(saved);
  expect(readdirSync(join(home, 'bin')).filter(name => /update-transaction|install-claim/.test(name))).toEqual([]);
});

test('compatible reader evidence permits reinstall and survives data-preserving uninstall and a fresh reinstall', () => {
  expect(run().status).toBe(0);
  const floor = join(home, 'bin/.goodvibes-reader-requirements.json');
  const saved = JSON.stringify({ schema: 1, minimumReader: version, formats: ['payment-retained-holds-v2'] }); writeFileSync(floor, saved);
  const upgraded = run(); expect(upgraded.status, upgraded.stderr).toBe(0);
  expect(run(true).status).toBe(0); expect(readFileSync(floor, 'utf8')).toBe(saved);
  const installed = run(); expect(installed.status, installed.stderr).toBe(0); expect(readFileSync(floor, 'utf8')).toBe(saved);
});

test('the installer cannot replace a native updater claim or a program protected by it', () => {
  mkdirSync(join(home, 'bin')); writeFileSync(join(home, 'bin/goodvibes'), 'original program');
  const claim = join(home, 'bin/goodvibes-daemon.update-transaction'); writeFileSync(claim, 'original updater evidence');
  const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('Another update');
  expect(readFileSync(claim, 'utf8')).toBe('original updater evidence'); expect(readFileSync(join(home, 'bin/goodvibes'), 'utf8')).toBe('original program');
  expect(readdirSync(join(home, 'bin')).filter(name => name.startsWith('.goodvibes-install-claim.'))).toEqual([]);
});

test('orphaned companion transaction evidence is preserved before any executable replacement', () => {
  mkdirSync(join(home, 'bin')); writeFileSync(join(home, 'bin/goodvibes'), 'original program');
  const slot = join(home, 'bin/goodvibes-daemon.bun.update-download'); writeFileSync(slot, 'retained updater staging');
  const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('transaction files require inspection');
  expect(readFileSync(slot, 'utf8')).toBe('retained updater staging'); expect(readFileSync(join(home, 'bin/goodvibes'), 'utf8')).toBe('original program');
  expect(readdirSync(join(home, 'bin')).filter(name => /update-transaction|install-claim/.test(name))).toEqual([]);
});

test('interrupted suite publication retains exact claims and refuses a blind second attempt', () => {
  const result = run(false, 'agent'); expect(result.status).not.toBe(0); expect(result.stderr).toContain('suite replacement did not finish');
  const claims = ['goodvibes-daemon', 'goodvibes', 'goodvibes-agent'].map(name => join(home, 'bin', name + '.update-transaction'));
  const original = claims.map(path => readFileSync(path)); const before = readFileSync(join(home, 'bin/goodvibes'));
  expect(result.stdout).not.toContain('Install complete');
  const retried = run(); expect(retried.status).not.toBe(0); expect(retried.stderr).toContain('Another update');
  for (const [index, path] of claims.entries()) expect(readFileSync(path)).toEqual(original[index]);
  expect(readFileSync(join(home, 'bin/goodvibes'))).toEqual(before);
});

test('directory replacement during the real install cannot redirect later companion writes', () => {
  const result = run(false, 'prefix'); expect(result.status).not.toBe(0); expect(result.stderr).toContain('installation directory changed');
  expect(readdirSync(join(home, 'bin'))).toEqual(['foreign']);
  expect(readFileSync(join(home, 'bin/foreign'), 'utf8')).toBe('foreign');
  for (const command of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    expect(existsSync(join(home, 'retired-bin', command + '.update-transaction'))).toBe(true);
  }
});

test.each(['browser', 'webui'] as const)('an independently pinned but incomplete %s archive fails before touching programs', kind => {
  mkdirSync(join(home, 'bin')); writeFileSync(join(home, 'bin/goodvibes'), 'original program');
  const archive = kind === 'browser' ? 'browser-driver.tar.gz' : `goodvibes-webui-bundle-${version}.tar.gz`;
  const empty = join(root, 'empty-archive'); mkdirSync(empty);
  execFileSync('tar', ['-czf', join(assets, archive), '-C', empty, '.']);
  writeFileSync(join(assets, 'SHA256SUMS.txt'), readdirSync(assets).filter(name => name !== 'SHA256SUMS.txt').map(name => `${digest(join(assets, name))}  ${name}\n`).join(''));
  const result = run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('missing');
  expect(readFileSync(join(home, 'bin/goodvibes'), 'utf8')).toBe('original program');
  expect(existsSync(join(home, 'bin/goodvibes-daemon'))).toBe(false);
  expect(readdirSync(join(home, 'bin')).filter(name => /update-transaction|install-claim/.test(name))).toEqual([]);
});

test('an existing checkout receipt keeps its command links and data until its own uninstall', () => {
  const prefix=join(home,'checkout-install'); mkdirSync(join(prefix,'commands'),{recursive:true});
  writeFileSync(join(prefix,'installation.json'),'{}'); mkdirSync(join(home,'bin'));
  symlinkSync(join(prefix,'commands/goodvibes'),join(home,'bin/goodvibes'));
  const result=run(); expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('checkout installation owns');
  expect(existsSync(join(root,'fetches'))).toBe(false);
  expect(existsSync(join(prefix,'installation.json'))).toBe(true);
});

test('uninstall delegates an existing checkout receipt to its own installed uninstaller', () => {
  const prefix=join(home,'checkout-install');mkdirSync(join(prefix,'commands'),{recursive:true});
  mkdirSync(join(prefix,'current/runtime'),{recursive:true});
  writeFileSync(join(prefix,'installation.json'),'{}');writeFileSync(join(prefix,'current/uninstall.js'),'owner program');
  writeFileSync(join(prefix,'current/runtime/bun'),'#!/bin/sh\necho source-owned > "$HOME/source-uninstall-owned"\n');
  chmodSync(join(prefix,'current/runtime/bun'),0o755);mkdirSync(join(home,'bin'));
  symlinkSync(join(prefix,'commands/goodvibes'),join(home,'bin/goodvibes'));
  const result=run(true);expect(result.status,result.stderr).toBe(0);
  expect(readFileSync(join(home,'source-uninstall-owned'),'utf8').trim()).toBe('source-owned');
  expect(existsSync(join(root,'fetches'))).toBe(false);
  expect(existsSync(join(prefix,'installation.json'))).toBe(true);
});
