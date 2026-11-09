import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { suiteReleaseFixture } from '@goodvibes-jev/engine/toolchain/testing/suite-release';
import { captureUpdateFileIo, realUpdateFileIo, createInstalledReaderCohort, nativeReaderCapabilities } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { retainNativeUpdateSources } from '@goodvibes-jev/engine/platform/platform/runtime/compiled-native-startup';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { parseDaemonCli } from '../../cli/parser.js';
import { repairDaemonSuiteBeforeStartup } from '../../cli/startup-suite-repair.js';
import { EventEmitter } from 'node:events';
import { runConfiguredDaemonCli } from '../../cli/serve.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';
import type { DaemonUpdateArtifact } from '@goodvibes-jev/engine/platform/platform/daemon';

class ProcessTarget extends EventEmitter { readonly exits: number[] = []; exit(code: 0 | 1): void { this.exits.push(code); } }
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function configurationFixture(auto = true, suite?: Pick<ReturnType<typeof suiteReleaseFixture>, 'root' | 'webui'>) {
  const root = suite?.root ?? makeOwnedTempDir('startup-suite-configuration');
  if (!suite) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), settings = join(home, '.goodvibes', 'daemon', 'settings.json');
  mkdirSync(dirname(settings), { recursive: true });
  writeFileSync(settings, JSON.stringify({ update: { auto, releasesUrl: 'https://example.test/releases/latest' },
    controlPlane: { webui: { serve: true, bundleDir: suite?.webui ?? join(root, 'webui', '3.1.3') } } }));
  const env = { HOME: home }, flags = parseDaemonCli(['serve']).flags;
  const configuration = createDaemonCliConfiguration(flags, env, root, { readOnly: true, diagnosticMode: 'structural' });
  return { root, configuration, env, settings };
}
function fixture() {
  const f = suiteReleaseFixture(); cleanups.push(() => f.cleanup());
  const daemon = join(f.root, 'goodvibes-daemon');
  // Historical daemon-only update: the daemon's selected version is current,
  // while the two installed terminal profiles are still absent as in3.1.1.
  for (const [relative, asset] of [
    ['goodvibes-daemon', 'goodvibes-daemon-macos-x64'], ['goodvibes-daemon.readers.json', 'goodvibes-daemon-macos-x64.reader-ci-artifact.json'],
    ['lib/sqlite-vec-darwin-x64/vec0.dylib', 'sqlite-vec-darwin-x64.dylib'],
    ['lib/sqlite-darwin-x64/libsqlite3.dylib', 'sqlite-darwin-x64.dylib'], ['lib/sqlite-darwin-x64/libsqlite3.dylib.json', 'sqlite-darwin-x64.dylib.json'],
  ]) writeFileSync(join(f.root, relative!), f.release.get(asset!)!);
  unlinkSync(join(f.root, 'goodvibes.readers.json')); unlinkSync(join(f.root, 'goodvibes-agent.readers.json'));
  unlinkSync(join(f.root, '.goodvibes-reader-requirements.json'));
  const configured = configurationFixture(true, f);
  const ownFiles = [daemon, daemon + '.readers.json', ...['lib/sqlite-vec-darwin-x64/vec0.dylib', 'lib/sqlite-darwin-x64/libsqlite3.dylib', 'lib/sqlite-darwin-x64/libsqlite3.dylib.json'].map(path => join(f.root, path))];
  const current = retainNativeUpdateSources(ownFiles, captureUpdateFileIo(realUpdateFileIo));
  // Code-owned OS-admission port only: inert byte fixtures are never executed
  // as a native daemon. All subsequent suite verification/publication is real.
  const artifact: DaemonUpdateArtifact = { suite: true, execPath: daemon, version: '3.1.3', assertCurrent: current,
    currentReader: { readers: nativeReaderCapabilities('3.1.3'), assertCurrent: current } };
  return { ...f, ...configured, daemon, artifact, current };
}

test('a current daemon with historical sibling profiles repairs the real suite before any new data floor', async () => {
  const f = fixture(), before = readFileSync(f.settings), args = ['serve', '--port', '12345'];
  const cohort = createInstalledReaderCohort({ execPath: f.daemon, version: '3.1.3', platform: 'darwin', arch: 'x64' });
  expect(() => cohort(['knowledge-schema-v17'])).toThrow();
  let restarts = 0, graphStarts = 0, writableStarts = 0; const target = new ProcessTarget();
  const handle = runConfiguredDaemonCli(f.configuration, { inboxFactory() { graphStarts++; throw new Error('Graph must not start'); } }, f.env,
    { process: target }, () => {}, () => {}, undefined, async signal => {
      const repaired = await repairDaemonSuiteBeforeStartup({ configuration: f.configuration, argv: args, env: f.env, signal,
    print() {}, platform: 'darwin', arch: 'x64' }, { admit: () => f.artifact, fetchImpl: f.fetchImpl,
    async restart(options, key) {
      restarts++; expect(options.execPath).toBe(f.daemon); expect(options.argv).toEqual(args); expect(options.env).toEqual(f.env);
      expect(key).toBe('GOODVIBES_DAEMON_STARTUP_REPAIRED_FROM');
      expect(() => f.current()).toThrow(); // The old writer is genuinely retired.
      for (const name of ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']) {
        const profile = JSON.parse(readFileSync(join(f.root, name + '.readers.json'), 'utf8')) as { version: string };
        expect(profile.version).toBe('3.1.3');
      }
      expect(readFileSync(f.settings)).toEqual(before);
      expect(() => createInstalledReaderCohort({ execPath: f.daemon, version: '3.1.3', platform: 'darwin', arch: 'x64' })(['knowledge-schema-v17'])).not.toThrow();
      return 0;
    } });
      if (repaired) return null;
      writableStarts++; return f.configuration;
    });
  expect(await handle.finished).toBe(0);
  expect(target.exits).toEqual([0]); expect([restarts, graphStarts, writableStarts]).toEqual([1, 0, 0]);
  expect(existsSync(join(f.configuration.daemonHomeDirectory, 'operator-tokens.json'))).toBe(false);
  expect(readFileSync(f.settings)).toEqual(before);
});

test('saved automatic-update opt-out admits no repair, download or replacement process', async () => {
  const f = configurationFixture(false); let admissions = 0, downloads = 0, restarts = 0;
  expect(await repairDaemonSuiteBeforeStartup({ configuration: f.configuration, argv: ['serve'], env: f.env, signal: new AbortController().signal,
    print() {}, platform: 'darwin', arch: 'x64' }, { admit() { admissions++; throw new Error('Must not admit'); },
    async fetchImpl() { downloads++; throw new Error('Must not fetch'); }, async restart() { restarts++; return 0; } })).toBe(false);
  expect([admissions, downloads, restarts]).toEqual([0, 0, 0]);
});

test('missing release evidence fails before data writes or relaunch', async () => {
  const f = fixture(), original = readFileSync(join(f.root, 'goodvibes')), settings = readFileSync(f.settings);
  f.release.delete('goodvibes-agent-macos-x64.reader-ci-artifact.json'); let restarts = 0;
  await expect(repairDaemonSuiteBeforeStartup({ configuration: f.configuration, argv: ['serve'], env: f.env, signal: new AbortController().signal,
    print() {}, platform: 'darwin', arch: 'x64' }, { admit: () => f.artifact, fetchImpl: f.fetchImpl, async restart() { restarts++; return 0; } })).rejects.toBeDefined();
  expect(restarts).toBe(0); expect(readFileSync(join(f.root, 'goodvibes'))).toEqual(original); expect(readFileSync(f.settings)).toEqual(settings);
});


test('shutdown fences and drains the original startup preparation before any graph or token acquisition', async () => {
  const f = configurationFixture(), target = new ProcessTarget(), entered = Promise.withResolvers<AbortSignal>(), release = Promise.withResolvers<void>();
  let graphStarts = 0;
  const handle = runConfiguredDaemonCli(f.configuration, { inboxFactory() { graphStarts++; throw new Error('Graph must not start'); } }, f.env,
    { process: target }, () => {}, () => {}, undefined, async signal => { entered.resolve(signal); await release.promise; return null; });
  const signal = await entered.promise, closing = handle.shutdown(); let closed = false;
  void closing.then(() => { closed = true; });
  try {
    expect(signal.aborted).toBe(true); await Promise.resolve(); expect(closed).toBe(false);
    expect(graphStarts).toBe(0); expect(existsSync(join(f.configuration.daemonHomeDirectory, 'operator-tokens.json'))).toBe(false);
  } finally { release.resolve(); await closing; }
  expect(target.exits).toEqual([0]);
});
