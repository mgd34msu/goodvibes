/** Actual compiled Mac updater and startup rollback, with an unpublished
 * version fixture and explicitly seeded (not observed) failed-start history. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptanceFailureRecord, acceptPublishedSuite, readPublishedReaders, waitForAcceptanceReadiness } from './accept-published-suite.mjs';
import { startStagedReleaseFeed } from './accept-staged-suite.mjs';

const [source, target, directory] = process.argv.slice(2), commands = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon'];
const controller = new AbortController(), stop = () => controller.abort(new Error('Mac lifecycle verifier owner stopped.'));
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.mode].join(':');
const retained = [], retainedDirectories = [];
const retain = (path, limit = 536870912n) => {
  const stat = lstatSync(path, { bigint: true });
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0n && stat.size <= limit);
  const entry = { path, revision: revision(stat), size: Number(stat.size) }; retained.push(entry); return entry;
};
const readJson = path => JSON.parse(readFileSync(retain(path, 131072n).path, 'utf8'));
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 131072, timeout: 30_000 }).trim();
let stage = 'input-admission', feed, failure, accepted = false, updated = false, rolledBack = false, fixtureSource;
let initialPid, updatedPid, rolledBackPid;
const assertCurrent = () => {
  controller.signal.throwIfAborted();
  for (const entry of [...retainedDirectories, ...retained])
    assert.equal(revision(lstatSync(entry.path, { bigint: true })), entry.revision, 'Original lifecycle fixture changed.');
  feed?.assertCurrent();
};

async function admitCohort(root, fixture) {
  assert.ok(['3.1.2', '3.1.3'].includes(fixture.version)); assert.match(fixture.source, /^[a-f0-9]{40}$/);
  assert.equal(fixture.assets, `assets-${fixture.version}`); assert.equal(fixture.checkout, `source-${fixture.version}`);
  const assets = join(root, fixture.assets), stat = lstatSync(assets, { bigint: true });
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); retainedDirectories.push({ path: assets, revision: revision(stat) });
  const publisher = readJson(join(assets, `suite-release-source-${target}.json`));
  assert.equal(publisher.schema, 1); assert.equal(publisher.target, target); assert.equal(publisher.tag, `v${fixture.version}`);
  assert.equal(publisher.sourceCommit, fixture.source);
  const suffix = target.replace(/^darwin-/, 'macos-');
  const native = [...commands.flatMap(name => [`${name}-${suffix}`, `${name}-${suffix}.reader-ci-artifact.json`]),
    `sqlite-vec-${target}.dylib`, `sqlite-${target}.dylib`, `sqlite-${target}.dylib.json`];
  assert.deepEqual(Object.keys(publisher.files).sort(), native.sort());
  const manifest = retain(join(assets, 'SHA256SUMS.txt'), 131072n), pins = new Map(), entries = new Map();
  for (const line of readFileSync(manifest.path, 'utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    assert.ok(match && !pins.has(match[2])); pins.set(match[2], match[1]);
  }
  const webuiName = `goodvibes-webui-bundle-${fixture.version}.tar.gz`;
  assert.deepEqual([...pins.keys()].sort(), [...native, webuiName, 'browser-driver.tar.gz'].sort());
  assert.equal(fixture.webui.assetName, webuiName); assert.equal(pins.get(webuiName), fixture.webui.sha256);
  const selected = { ...publisher.files, [webuiName]: fixture.webui };
  for (const [name, pin] of pins) {
    const entry = retain(join(assets, name)); entries.set(name, entry);
    assert.match(pin, /^[a-f0-9]{64}$/);
    if (selected[name]) { assert.equal(pin, selected[name].sha256); assert.equal(entry.size, selected[name].size); }
  }
  entries.set('SHA256SUMS.txt', manifest);
  const readers = await readPublishedReaders({ source: fixture.source, tag: `v${fixture.version}`, target, assets: new Set(entries.keys()) }, async name => {
    const value = readJson(entries.get(name).path), command = commands.find(command => name === `${command}-${suffix}.reader-ci-artifact.json`);
    assert.ok(command); assert.equal(value.schema, 1); assert.equal(value.readers.version, fixture.version);
    assert.equal(value.packageName, `@goodvibes-jev/${command === 'goodvibes' ? 'tui' : command === 'goodvibes-agent' ? 'agent' : 'daemon'}`);
    const expected = command === 'goodvibes-daemon' ? [`${command}-${suffix}`, `lib/sqlite-vec-${target}/vec0.dylib`,
      `lib/sqlite-${target}/libsqlite3.dylib`, `lib/sqlite-${target}/libsqlite3.dylib.json`] : [`${command}-${suffix}`];
    assert.deepEqual(value.files.map(file => file.path), expected);
    for (const file of value.files) {
      const flat = file.path.startsWith('lib/sqlite-vec-') ? `sqlite-vec-${target}.dylib`
        : file.path.startsWith('lib/sqlite-') ? `sqlite-${target}.dylib${file.path.endsWith('.json') ? '.json' : ''}` : file.path;
      assert.equal(file.sha256, pins.get(flat)); assert.equal(file.size, entries.get(flat).size);
    }
    return value;
  });
  return { readers, pins, entries, assertCurrent(name) { assertCurrent(); const entry = entries.get(name); assert.ok(entry); return entry; } };
}

async function verify() {
  assert.equal(process.platform, 'darwin'); assert.equal(target, `darwin-${process.arch}`); assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(git(process.cwd(), ['rev-parse', 'HEAD']), source);
  const root = realpathSync(directory), rootStat = lstatSync(root, { bigint: true });
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink()); retainedDirectories.push({ path: root, revision: revision(rootStat) });
  const index = readJson(join(root, 'fixtures.json')); assert.equal(index.schema, 1); assert.equal(index.source, source); assert.equal(index.target, target);
  assert.equal(index.fixtures.length, 2); assert.deepEqual(index.fixtures.map(f => f.version), ['3.1.2', '3.1.3']);
  assert.equal(index.fixtures[0].source, source); fixtureSource = index.fixtures[1].source;
  assert.equal(index.browserSupport.run, 42941236483); assert.equal(index.browserSupport.source, '81ce4d31b14b1b4a145672ed6257fc21c308c617');
  const futureCheckout = join(root, 'source-3.1.3');
  assert.equal(git(futureCheckout, ['rev-parse', 'HEAD']), fixtureSource);
  assert.equal(git(futureCheckout, ['rev-parse', 'HEAD^']), source);
  assert.equal(git(futureCheckout, ['rev-parse', '--abbrev-ref', 'HEAD']), 'HEAD');
  git(futureCheckout, ['diff', '--exit-code', 'HEAD']);
  stage = 'baseline-publisher'; const baseline = await admitCohort(root, index.fixtures[0]);
  stage = 'future-publisher'; const future = await admitCohort(root, index.fixtures[1]);
  for (const cohort of [baseline, future]) assert.equal(cohort.pins.get('browser-driver.tar.gz'), index.browserSupport.sha256);
  for (const name of commands) assert.deepEqual(future.readers.get(name).readers.formats, baseline.readers.get(name).readers.formats);
  // The fixture has only this Mac target. The full staged/public release gates
  // remain unchanged, and this receipt cannot qualify an all-platform release.
  feed = await startStagedReleaseFeed({ entries: future.entries, assertCurrent: name => {
    controller.signal.throwIfAborted();
    for (const entry of [...retainedDirectories, ...retained]) assert.equal(revision(lstatSync(entry.path, { bigint: true })), entry.revision);
    const entry = future.entries.get(name); assert.ok(entry); return entry;
  } }, 'v3.1.3');
  let installerSource, installerSourcePath;
  const delivery = {
    get installerSource() { return installerSource; }, get installerSourcePath() { return installerSourcePath; },
    async admit({ root: owned }) {
      assertCurrent(); stage = 'installer-delivery';
      const bytes = execFileSync('git', ['show', `${source}:scripts/install.sh`], { maxBuffer: 1_048_576 });
      installerSource = bytes.toString('utf8'); installerSourcePath = join(owned, 'immutable-install.sh');
      writeFileSync(installerSourcePath, bytes, { flag: 'wx', mode: 0o600 }); retain(installerSourcePath, 1_048_576n);
      const installer = join(owned, 'install.sh'), base = `https://github.com/mgd34msu/goodvibes/releases/download/v3.1.2/`;
      const cases = [...baseline.entries].map(([name, entry]) => `    ${quote(name)}) cp ${quote(entry.path)} "$2" ;;`).join('\n');
      writeFileSync(installer, `#!/bin/sh\nGOODVIBES_INSTALL_SH_LIB=1\n. ${quote(installerSourcePath)}\nfetch() {\n  case "$1" in ${quote(base)}*) fixture_name=\${1#${quote(base)}} ;; *) fail 'Unadmitted fixture URL' ;; esac\n  case "$fixture_name" in\n${cases}\n    *) fail 'Unadmitted fixture member' ;;\n  esac\n}\nmain "$@"\n`, { flag: 'wx', mode: 0o600 });
      retain(installer, 1_048_576n); return { readers: baseline.readers, installer, published: { url: `unpublished-macos-lifecycle:${source}`, bytes } };
    },
    assertCurrent,
    async preparePrevious() { throw new Error('This proof does not claim a historical Mac release.'); },
    async finish() { await feed.close(); },
    async verifyNativeLifecycle(host) {
      const { daemon, bin, data, invoke, setting, checkpoint, signal } = host;
      stage = 'unattended-update'; checkpoint('fixture.update.baseline-runtime'); initialPid = await host.servicePid();
      const sentinel = join(data, 'macos-update-preserved.txt'), content = 'Owned data survives actual Mac update and complete-cohort rollback.\n';
      writeFileSync(sentinel, content, { flag: 'wx', mode: 0o600 });
      let priorRequirements;
      const verifyReaderFloors = () => {
        const path = join(bin, '.goodvibes-reader-requirements.json'), stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) { assert.equal(priorRequirements, undefined); return; }
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072);
        const value = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(value.schema, 1); assert.equal(value.minimumReader, '3.1.2'); assert.ok(Array.isArray(value.formats));
        for (const format of priorRequirements?.formats ?? []) assert.ok(value.formats.includes(format));
        priorRequirements = value;
      };
      verifyReaderFloors();
      await invoke(daemon, ['config', 'set', 'update.intervalMinutes', '61']);
      await invoke(daemon, ['config', 'set', 'update.firstCheckSeconds', '5']);
      await invoke(daemon, ['config', 'set', 'update.releasesUrl', feed.url]);
      const bundle = await setting('controlPlane.webui.bundleDir');
      await host.restartService();
      const preserve = async () => {
        checkpoint('fixture.preserved-data-settings'); assert.equal(readFileSync(sentinel, 'utf8'), content);
        verifyReaderFloors();
        assert.equal(await setting('update.intervalMinutes'), 61); assert.equal(await setting('update.firstCheckSeconds'), 5);
        assert.equal(await setting('update.releasesUrl'), feed.url); assert.equal(await setting('controlPlane.webui.bundleDir'), bundle);
        for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) assert.equal(await setting(key), true);
      };
      const ready = async (version, readers) => {
        await waitForAcceptanceReadiness(async () => {
          checkpoint(version === '3.1.3' ? 'fixture.update.new-version' : 'fixture.rollback.restored-version');
          for (const name of commands) assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${version}`);
        }, () => host.verifyCohort(version, readers), { signal, timeoutMs: 10 * 60_000, intervalMs: 1000 });
        await preserve(); return host.servicePid();
      };
      updatedPid = await ready('3.1.3', future.readers); assert.notEqual(updatedPid, initialPid); updated = true;
      stage = 'complete-cohort-rollback'; checkpoint('fixture.rollback.previous-cohort');
      const files = [...commands.flatMap(name => [join(bin, name), join(bin, `${name}.readers.json`)]),
        join(bin, 'lib', `sqlite-vec-${target}`, 'vec0.dylib'), join(bin, 'lib', `sqlite-${target}`, 'libsqlite3.dylib'),
        join(bin, 'lib', `sqlite-${target}`, 'libsqlite3.dylib.json')];
      for (const path of files) { const stat = lstatSync(`${path}.previous`); assert.ok(stat.isFile() && !stat.isSymbolicLink()); }
      for (const path of [join(bin, 'playwright-core'), bundle]) { const stat = lstatSync(`${path}.previous`); assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); }
      const previousWebui = JSON.parse(readFileSync(join(`${bundle}.previous`, '.goodvibes-release.json'), 'utf8'));
      assert.equal(previousWebui.version, '3.1.2');
      checkpoint('fixture.rollback.stop-before-seeded-history'); await host.stopService();
      const marker = join(data, 'tui', 'control-plane', 'daemon-lifecycle.json');
      assert.equal(await setting('update.rollbackAfterFailedStarts'), 3);
      const seed = join(host.root, 'seed-failed-start-history.mjs');
      const module = pathToFileURL(join(futureCheckout, 'packages/engine/platform/src/platform/daemon/lifecycle-marker.ts')).href;
      writeFileSync(seed, `import assert from 'node:assert/strict';\nimport {recordDaemonStartAttempt,readLifecycleMarker} from ${JSON.stringify(module)};\nconst path=process.argv[2];\nconst original=readLifecycleMarker(path);\nassert.equal(original?.version,'3.1.3');\nassert.equal(original?.failedStarts,0);\nassert.equal(original?.autoRollbackAt,undefined);\nfor(let i=0;i<3;i++) recordDaemonStartAttempt(path,{version:'3.1.3'});\nassert.equal(readLifecycleMarker(path)?.failedStarts,3);\n`, { flag: 'wx', mode: 0o600 });
      retain(seed, 16384n); checkpoint('fixture.rollback.seeded-history-writer'); await invoke('bun', [seed, marker]);
      // Only history is seeded. The actual compiled startup policy decides to
      // restore, owns all cohort publication/drain, and requests launchd handover.
      checkpoint('fixture.rollback.native-startup'); await host.startService();
      rolledBackPid = await ready('3.1.2', baseline.readers); assert.notEqual(rolledBackPid, updatedPid);
      checkpoint('fixture.rollback.rejected-version');
      const status = JSON.parse(await invoke(daemon, ['status', '--json']));
      assert.equal(status.ok, true); assert.equal(status.data.identity.version, '3.1.2');
      assert.equal(status.data.local.marker.version, '3.1.2'); assert.equal(status.data.local.marker.rejectedVersion, '3.1.3');
      rolledBack = true; assertCurrent();
    },
  };
  stage = 'native-lifecycle';
  let primary;
  try { await acceptPublishedSuite({ source, tag: 'v3.1.2', target, delivery, signal: controller.signal }); }
  catch (error) { primary = error; }
  finally { try { await feed.close(); } catch (error) { primary = primary ? new AggregateError([primary, error], 'Lifecycle and feed drain failed.') : error; } }
  if (primary) throw primary;
}

try { await verify(); controller.signal.throwIfAborted(); assert.ok(updated && rolledBack); accepted = true; }
catch (error) { failure = acceptanceFailureRecord({ stage }, error); process.exitCode = 1; console.error('Actual Mac unattended update/rollback verification failed.'); }
finally {
  // The feed also belongs to failures before native account admission.
  try { await feed?.close(); } catch (error) { accepted = false; process.exitCode = 1; failure ??= acceptanceFailureRecord({ stage: 'fixture-feed-drain' }, error); }
  const result = { accepted, source, target, fixtureSource, baselineVersion: '3.1.2', unpublishedTargetVersion: '3.1.3',
    unattendedUpdateVerified: updated, completeCohortRollbackVerified: rolledBack,
    rollbackTrigger: 'three failed-start history entries seeded through the source lifecycle writer while service stopped; crashes not observed',
    runtimeProof: 'actual original HOME and launchd; all3 compiled versions/readers; HTTP WebUI; settings and data; replacement process; owned uninstall',
    ...(initialPid ? { initialPid } : {}), ...(updatedPid ? { updatedPid } : {}), ...(rolledBackPid ? { rolledBackPid } : {}),
    browserSupport: { run: 42941236483, provenance: 'original unchanged versionless archive and original publisher pin' },
    ...(failure ? { failure } : {}), historicalMacReleaseQualification: false, allPlatformSuiteQualification: false, publication: false };
  if (process.env.RUNNER_TEMP) writeFileSync(join(resolve(process.env.RUNNER_TEMP), 'macos-update-rollback-result.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
