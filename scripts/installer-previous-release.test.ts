/** Acceptance coordinator/metadata regressions only; native proof belongs to hosted jobs. */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acceptanceFailureRecord, assertPreviousReleaseInputs, markAcceptanceCheckpoint, readPreviousReleaseCohort,
  runPreviousReleaseUpgradeSteps, verifyCompiledSuiteRollback, type NativeLifecycleHost, type PreviousReleaseUpgradeSteps } from './accept-published-suite.mjs';
import { recordDaemonAutoRollback, recordDaemonCleanShutdown, recordDaemonStart, recordDaemonStartAttempt } from '../packages/engine/platform/src/platform/daemon/lifecycle-marker.ts';
import { describeLocalDaemonState } from '../products/daemon/src/daemon/local-daemon-state.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const source = 'a'.repeat(40), nextSource = 'b'.repeat(40);
const targets = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'];
const commands = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];

function steps(events: string[]): PreviousReleaseUpgradeSteps {
  const record = (name: string) => async () => { events.push(name); };
  return Object.fromEntries(['admit', 'installPrevious', 'verifyPrevious', 'seedPreviousData', 'prepareDelivery',
    'startPreviousService', 'verifyPreviousService', 'awaitAutomaticUpgrade', 'verifyUpgradedData', 'verifyCompleteRollback',
    'uninstall', 'verifyPreserved'].map(name => [name, record(name)])) as unknown as PreviousReleaseUpgradeSteps;
}

test('previous-release orchestration admits exact inputs and configures staged delivery before activating old services', async () => {
  assertPreviousReleaseInputs({ tag: 'v3.1.3', previousTag: 'v3.1.2', previousSource: source });
  assertPreviousReleaseInputs({ tag: 'v4.0.0', previousTag: 'v3.9.9', previousSource: source });
  for (const patch of [{ previousTag: undefined }, { previousSource: undefined }, { previousSource: 'main' },
    { previousTag: 'v3.1.3' }, { previousTag: 'v3.1.4' }, { previousTag: 'v03.1.2' }, { tag: 'v3.1.3-rc.1' }])
    expect(() => assertPreviousReleaseInputs({ tag: 'v3.1.3', previousTag: 'v3.1.2', previousSource: source, ...patch })).toThrow();
  const events: string[] = []; await runPreviousReleaseUpgradeSteps(steps(events));
  expect(events).toEqual(['admit', 'installPrevious', 'verifyPrevious', 'seedPreviousData', 'prepareDelivery',
    'startPreviousService', 'verifyPreviousService', 'awaitAutomaticUpgrade', 'verifyUpgradedData', 'verifyCompleteRollback',
    'uninstall', 'verifyPreserved']);
  expect(events).not.toContain('installCurrent');
});

for (const stage of ['installPrevious', 'verifyPrevious', 'prepareDelivery', 'awaitAutomaticUpgrade', 'verifyCompleteRollback'] as const)
  test(`previous-release ${stage} failure preserves primary refusal and awaits owned cleanup`, async () => {
    const events: string[] = [], host = steps(events), original = new Error('original owned failure');
    host[stage] = async () => { events.push(stage); throw original; };
    const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
    host.uninstall = async () => { events.push('uninstall'); entered.resolve(); await finish.promise; };
    const running = runPreviousReleaseUpgradeSteps(host); let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise; expect(settled).toBe(false); finish.resolve();
    await expect(running).rejects.toBe(original); expect(events.slice(-2)).toEqual(['uninstall', 'verifyPreserved']);
  });

test('foreign ownership never activates cleanup and failed cleanup retains its own failure', async () => {
  const events: string[] = [], host = steps(events), primary = new Error('foreign ownership');
  host.admit = async () => { throw primary; };
  await expect(runPreviousReleaseUpgradeSteps(host)).rejects.toBe(primary); expect(events).toEqual([]);
  const active = steps([]), cleanup = new Error('service not retired');
  active.awaitAutomaticUpgrade = async () => { throw primary; }; active.uninstall = async () => { throw cleanup; };
  await expect(runPreviousReleaseUpgradeSteps(active)).rejects.toMatchObject({ errors: [primary, cleanup] });
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
  if (violation === 'assets') fixture.release.assets.pop();
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
  recordDaemonStart(marker, { version: '3.1.3', pid: 101, now });
  const host: NativeLifecycleHost = { root, bin, data, daemon: join(bin, 'goodvibes-daemon'),
    checkpoint(check) { events.push(check); }, async setting() { return 3; },
    async invoke(command, args) {
      if (command === 'git') return nextSource;
      if (command === 'bun') {
        expect(stopped).toBe(true); expect(started).toBe(false); const writer = readFileSync(args[0]!, 'utf8');
        expect(writer).toContain('recordDaemonStartAttempt'); expect(writer).toContain('for(let i=0;i<3;i++)');
        expect(writer).toContain('"3.1.3"');
        for (let i = 0; i < 3; i++) recordDaemonStartAttempt(marker, { version: '3.1.3', now });
        events.push('seed'); return '';
      }
      if (args[0] === '--version') return `${command.split('/').at(-1)} 3.1.2`;
      return JSON.stringify({ ok: true, data: { identity: { version: '3.1.2' },
        local: describeLocalDaemonState({ isLocal: true, controlPlaneConfigDir, now }) } });
    }, async servicePid() { return started ? 102 : 101; }, async stopService() {
      recordDaemonCleanShutdown(marker, { version: '3.1.3', now }); stopped = true; events.push('stop');
    },
    async startService() {
      expect(events).toContain('seed'); expect(recordDaemonStartAttempt(marker, { version: '3.1.3', now }).failedStarts).toBe(3);
      recordDaemonAutoRollback(marker, { rejectedVersion: '3.1.3', now });
      recordDaemonStartAttempt(marker, { version: '3.1.2', now });
      recordDaemonStart(marker, { version: '3.1.2', pid: 102, now });
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
for (const [field, value, check] of [
  ['version', '3.1.3', 'rollback.marker-version'], ['rejectedVersion', undefined, 'rollback.rejected-version'],
  ['state', 'clean-shutdown', 'rollback.marker-state'], ['pid', 101, 'rollback.marker-pid'],
  ['failedStarts', 1, 'rollback.failed-starts'], ['autoRollbackAt', 1_000_000, 'rollback.rollback-guard'],
] as const) test(`restored rollback marker ${field} mismatch identifies its exact field without exposing values`, async () => {
  const fixture = rollbackFixture('linux-arm64'), invoke = fixture.input.host.invoke;
  fixture.input.host.invoke = async (command, args) => {
    const result = await invoke(command, args);
    if (args[0] !== 'status') return result;
    const status = JSON.parse(result); status.data.local.marker[field] = value; return JSON.stringify(status);
  };
  let failure: unknown;
  try { await verifyCompiledSuiteRollback(fixture.input); } catch (error) { failure = error; }
  expect(failure).toBeDefined(); expect(fixture.events.at(-1)).toBe(check);
  const record = acceptanceFailureRecord({ stage: 'verifyCompleteRollback', check }, failure);
  expect(record).toMatchObject({ check, error: { name: 'AssertionError', code: 'ERR_ASSERTION' } });
  expect(JSON.stringify(record)).not.toContain('clean-shutdown');
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
test('readiness mismatch exposes only a finite release state and checkpoints clear it', () => {
  const evidence: Parameters<typeof acceptanceFailureRecord>[0] = { stage: 'awaitAutomaticUpgrade', observedRelease: 'previous' };
  expect(acceptanceFailureRecord(evidence, new Error('private output'))).toMatchObject({ observedRelease: 'previous' });
  expect(JSON.stringify(acceptanceFailureRecord({ ...evidence, observedRelease: 'private output' as 'previous' }, new Error()))).not.toContain('private output');
  markAcceptanceCheckpoint(evidence, 'next'); expect(evidence.observedRelease).toBeUndefined();
});

test('the historical Mac native verifier reuses the shared compiled rollback without changing its real fixture versions', () => {
  const verifier = readFileSync(join(import.meta.dir, 'verify-macos-update-rollback.mjs'), 'utf8');
  expect(verifier).toContain('verifyCompiledSuiteRollback({ host, target, source: fixtureSource, sourceRoot: futureCheckout,');
  expect(verifier).toContain("previousVersion: '3.1.2', currentVersion: '3.1.3', previousReaders: baseline.readers");
  expect(verifier).toContain('webuiDirectory: bundle, verifyPreserved: preserve');
  expect(verifier).not.toContain('recordDaemonStartAttempt');
  expect(verifier).not.toContain('rollbackSuiteUpdate(');
});
