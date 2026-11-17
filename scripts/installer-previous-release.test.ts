/** The previous-release acceptance runs only pinned, verified earlier bytes; the native run itself belongs to hosted jobs. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { assertPreviousReleaseInputs, readPreviousReleaseCohort, verifyCompiledSuiteRollback, type NativeLifecycleHost } from './accept-published-suite.mjs';
import { recordDaemonAutoRollback, recordDaemonCleanShutdown, recordDaemonStart, recordDaemonStartAttempt, type ProcessIdentityProbe } from '../packages/engine/platform/src/platform/daemon/lifecycle-marker.ts';
import { describeLocalDaemonState } from '../products/daemon/src/daemon/local-daemon-state.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = 'a'.repeat(40), nextSource = 'b'.repeat(40);
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const commands = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];

test('previous-release acceptance admits only an exact earlier tag and commit', () => {
  assertPreviousReleaseInputs({ tag: 'v3.1.3', previousTag: 'v3.1.2', previousSource: source });
  assertPreviousReleaseInputs({ tag: 'v4.0.0', previousTag: 'v3.9.9', previousSource: source });
  for (const patch of [{ previousTag: undefined }, { previousSource: undefined }, { previousSource: 'main' },
    { previousTag: 'v3.1.3' }, { previousTag: 'v3.1.4' }, { previousTag: 'v03.1.2' }, { tag: 'v3.1.3-rc.1' }])
    expect(() => assertPreviousReleaseInputs({ tag: 'v3.1.3', previousTag: 'v3.1.2', previousSource: source, ...patch })).toThrow();
});

function previousCatalog(target: string) {
  const suffix = target.replace(/^darwin-/, 'macos-'), tag = 'v3.1.2';
  const readers = commands.map(name => ({ target, sourceCommit: source, headCommit: source, readers: { version: '3.1.2' },
    files: [{ path: `${name}-${suffix}` }] }));
  const names = ['SHA256SUMS.txt', 'browser-driver.tar.gz', 'goodvibes-webui-bundle-3.1.2.tar.gz',
    ...commands.flatMap(name => [`${name}-${suffix}`, `${name}-${suffix}.reader-ci-artifact.json`]),
    ...Array.from({ length: 56 }, (_, index) => `other-member-${index}`)];
  const release = { tag_name: tag, draft: false, prerelease: false, assets: names.map(name => ({ name })) };
  const reference = { ref: `refs/tags/${tag}`, object: { type: 'tag', sha: 'c'.repeat(40) } };
  const annotated = { tag, sha: 'c'.repeat(40), object: { type: 'commit', sha: source } };
  const requests: string[] = [], checks: string[] = [];
  const load = () => readPreviousReleaseCohort({ tag, source, target, checkpoint: check => checks.push(check), onHttpStatus() {} }, async url => {
    requests.push(url); let body: unknown;
    if (url.endsWith(`/releases/tags/${tag}`)) body = release;
    else if (url.endsWith(`/git/ref/tags/${tag}`)) body = reference;
    else if (url.endsWith(`/git/tags/${annotated.sha}`)) body = annotated;
    else if (url.endsWith('/scripts/install.sh')) body = '#!/bin/sh\n# immutable previous installer\n';
    else { const index = commands.findIndex(name => url.endsWith(`${name}-${suffix}.reader-ci-artifact.json`));
      if (index < 0) throw new Error('Unowned catalog request'); body = readers[index]; }
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  });
  return { load, readers, release, reference, annotated, requests, checks };
}
for (const target of targets) test(`actual previous ${target} catalog verifies immutable tag/readers without requiring latest`, async () => {
  const fixture = previousCatalog(target), result = await fixture.load();
  expect(result.readers.size).toBe(3); expect(result.installer.toString()).toContain('immutable previous installer');
  expect(fixture.requests.some(url => url.endsWith('/releases/latest'))).toBe(false);
  expect(fixture.requests.at(-1)).toBe(`https://raw.githubusercontent.com/mgd34msu/goodvibes/${source}/scripts/install.sh`);
});
for (const violation of ['source', 'reader', 'assets', 'draft'] as const) test(`previous ${violation} mismatch refuses before running a baseline installer`, async () => {
  const fixture = previousCatalog('darwin-arm64');
  if (violation === 'source') fixture.annotated.object.sha = nextSource;
  if (violation === 'reader') fixture.readers[0]!.headCommit = nextSource;
  // The catalog is validated by required contents, so drop a required member (a reader record), not an arbitrary one.
  if (violation === 'assets') fixture.release.assets = fixture.release.assets.filter(asset => !asset.name.endsWith('.reader-ci-artifact.json'));
  if (violation === 'draft') fixture.release.draft = true;
  await expect(fixture.load()).rejects.toThrow(); expect(fixture.requests.some(url => url.endsWith('/scripts/install.sh'))).toBe(false);
});

function rollbackFixture(target: string) {
  const root = mkdtempSync(join(tmpdir(), 'previous-rollback-coordinator-')); roots.push(root);
  const bin = join(root, 'bin'), data = join(root, 'data'), webui = join(bin, 'webui', '3.1.2'), suffix = target.replace(/^darwin-/, 'macos-');
  const put = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value)); };
  const readers = new Map(commands.map(name => {
    const paths = [`${name}-${suffix}`, ...(target.startsWith('linux-') ? ['.bun', '.bun.json', '.bun.LICENSE.md'].map(tail => `${name}-${suffix}${tail}`) : []),
      ...(name === 'goodvibes-daemon' ? [`lib/sqlite-vec-${target}/vec0.${target.startsWith('linux-') ? 'so' : 'dylib'}`,
        ...(target.startsWith('darwin-') ? [`lib/sqlite-${target}/libsqlite3.dylib`, `lib/sqlite-${target}/libsqlite3.dylib.json`] : [])] : [])];
    const reader = { sourceCommit: source, target, readers: { version: '3.1.2' }, files: paths.map(path => ({ path })) };
    for (const path of paths) put(join(bin, path.startsWith(`${name}-${suffix}`) ? name + path.slice(`${name}-${suffix}`.length) : path) + '.previous', 'owned coordinator member; not an executable');
    const metadata = join(bin, name === 'goodvibes-daemon' && target.startsWith('linux-') ? 'daemon-installation.json' : `${name}.readers.json`);
    put(metadata + '.previous', name === 'goodvibes-daemon' && target.startsWith('linux-') ? { artifact: reader } : reader);
    return [name, reader] as const;
  }));
  for (const directory of [join(bin, 'playwright-core'), webui]) put(join(directory + '.previous', '.goodvibes-release.json'), { schema: 1, version: '3.1.2' });
  const events: string[] = []; let stopped = false, started = false;
  const controlPlaneConfigDir = join(data, 'tui'), marker = join(controlPlaneConfigDir, 'control-plane', 'daemon-lifecycle.json');
  mkdirSync(dirname(marker), { recursive: true }); let clock = 1_000_000;
  const now = () => clock++;
  // The pids here are invented; the host's own process table must not decide whether a marker's owner is alive.
  const processIdentity: ProcessIdentityProbe = { isAlive: () => false, startTime: () => null };
  recordDaemonStart(marker, { version: '3.1.3', pid: 101, now, processIdentity });
  const host: NativeLifecycleHost = { root, bin, data, daemon: join(bin, 'goodvibes-daemon'),
    checkpoint(check) { events.push(check); }, async setting() { return 3; },
    async invoke(command, args) {
      if (command === 'git') return nextSource;
      if (command === 'bun') {
        expect(stopped).toBe(true); expect(started).toBe(false);
        for (let i = 0; i < 3; i++) recordDaemonStartAttempt(marker, { version: '3.1.3', now, processIdentity });
        events.push('seed'); return '';
      }
      if (args[0] === '--version') return `${command.split('/').at(-1)} 3.1.2`;
      return JSON.stringify({ ok: true, data: { identity: { version: '3.1.2' },
        local: describeLocalDaemonState({ isLocal: true, controlPlaneConfigDir, now }) } });
    }, async servicePid() { return started ? 102 : 101; }, async stopService() {
      recordDaemonCleanShutdown(marker, { version: '3.1.3', now, processIdentity }); stopped = true; events.push('stop');
    },
    async startService() {
      expect(events).toContain('seed'); expect(recordDaemonStartAttempt(marker, { version: '3.1.3', now, processIdentity }).failedStarts).toBe(3);
      recordDaemonAutoRollback(marker, { rejectedVersion: '3.1.3', now, processIdentity });
      recordDaemonStartAttempt(marker, { version: '3.1.2', now, processIdentity });
      recordDaemonStart(marker, { version: '3.1.2', pid: 102, now, processIdentity });
      started = true; events.push('start-native');
    }, async restartService() { throw new Error('Unowned restart'); },
    async verifyCohort(version, selected) { expect(started).toBe(true); expect(version).toBe('3.1.2'); expect(selected).toBe(readers); events.push('cohort'); },
  };
  const input = { host, target, source: nextSource, sourceRoot: root, previousVersion: '3.1.2', currentVersion: '3.1.3', previousReaders: readers,
    webuiDirectory: webui, async verifyPreserved() { events.push('preserved'); } };
  return { input, events, bin, put };
}
for (const target of targets) test(`shared ${target} rollback coordinator requires complete previous cohort before seeding native startup`, async () => {
  const fixture = rollbackFixture(target), result = await verifyCompiledSuiteRollback(fixture.input);
  expect(result).toEqual({ updatedPid: 101, rolledBackPid: 102 });
  expect(fixture.events.indexOf('stop')).toBeLessThan(fixture.events.indexOf('seed'));
  expect(fixture.events.indexOf('seed')).toBeLessThan(fixture.events.indexOf('start-native'));
  expect(fixture.events.indexOf('start-native')).toBeLessThan(fixture.events.indexOf('cohort'));
  expect(fixture.events).toContain('preserved');
});
test('missing companion or substituted previous reader refuses before service stop and failed-start mutation', async () => {
  for (const violation of ['missing', 'reader']) {
    const fixture = rollbackFixture('darwin-arm64');
    if (violation === 'missing') rmSync(join(fixture.bin, 'lib/sqlite-darwin-arm64/libsqlite3.dylib.previous'));
    else fixture.put(join(fixture.bin, 'goodvibes.readers.json.previous'), { sourceCommit: nextSource });
    await expect(verifyCompiledSuiteRollback(fixture.input)).rejects.toThrow();
    expect(fixture.events).not.toContain('stop'); expect(fixture.events).not.toContain('seed');
  }
});
