/** Unpublished, disposable native lifecycle fixtures. The ordinary publisher
 * retains authority over every compiled member and its existing release pin. */
import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runNativeBuildCommand } from '../products/daemon/scripts/native-execution-process.mjs';
import { acceptanceFailureRecord } from './accept-published-suite.mjs';

const [source, target, destination, supportDirectory] = process.argv.slice(2);
const controller = new AbortController(), stop = () => controller.abort(new Error('Mac fixture producer owner stopped.'));
process.once('SIGTERM', stop); process.once('SIGINT', stop);
let stage = 'input-admission', accepted = false, failure;
const receipt = { source, target, publication: false, allPlatformSuiteQualification: false, fixtures: [] };
const run = async (command, args, cwd) => {
  const result = await runNativeBuildCommand(command, args, { cwd, signal: controller.signal });
  assert.equal(result.exitCode, 0); return result.output.trim();
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const revision = path => { const s = lstatSync(path, { bigint: true });
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.size > 0n && s.size <= 536870912n);
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid].join(':'); };

try {
  assert.equal(process.platform, 'darwin'); assert.equal(target, `darwin-${process.arch}`);
  assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.match(source, /^[a-f0-9]{40}$/);
  const original = realpathSync(process.cwd()), temporary = realpathSync(process.env.RUNNER_TEMP);
  const root = resolve(destination), inside = relative(temporary, root);
  assert.ok(inside && !inside.startsWith(`..${sep}`) && inside !== '..' && !inside.startsWith(sep));
  assert.equal(await run('git', ['rev-parse', 'HEAD'], original), source);
  await run('git', ['diff', '--exit-code', 'HEAD'], original);
  assert.equal(json(join(original, 'package.json')).version, '3.1.2');
  mkdirSync(root, { mode: 0o700 });
  const support = realpathSync(supportDirectory), browser = join(support, 'browser-driver.tar.gz');
  const originalBrowser = revision(browser), manifestPath = join(support, 'SHA256SUMS.txt'), originalManifest = revision(manifestPath);
  assert.ok(lstatSync(manifestPath).size <= 131072);
  const browserLines = readFileSync(manifestPath, 'utf8').split('\n').filter(line => line.endsWith('  browser-driver.tar.gz'));
  assert.equal(browserLines.length, 1); const browserPin = /^([a-f0-9]{64})  browser-driver\.tar\.gz$/.exec(browserLines[0]); assert.ok(browserPin);
  const fixtures = [];
  for (const version of ['3.1.2', '3.1.3']) {
    stage = `source-${version}`;
    const checkout = join(root, `source-${version}`), assets = join(root, `assets-${version}`);
    await run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', original, checkout], temporary);
    await run('git', ['checkout', '--detach', source], checkout);
    if (version === '3.1.3') {
      const path = join(checkout, 'package.json'), manifest = json(path);
      writeFileSync(path, JSON.stringify({ ...manifest, version }, null, 2) + '\n');
      await run('bun', ['packages/engine/scripts/sync-version-fallback.ts'], checkout);
      // Only first-party workspace version metadata changes. Dependency pins
      // and integrity records stay byte-for-byte those of the selected source.
      const lockPath = join(checkout, 'bun.lock'), lock = readFileSync(lockPath, 'utf8');
      const split = lock.indexOf('\n  "packages": {'); assert.ok(split > 0);
      const workspaces = lock.slice(0, split), matches = [...workspaces.matchAll(/"version": "3\.1\.2"/g)];
      assert.equal(matches.length, 6);
      writeFileSync(lockPath, workspaces.replaceAll('"version": "3.1.2"', '"version": "3.1.3"') + lock.slice(split));
      const floorSource = 'packages/engine/platform/src/platform/runtime/native-reader-compatibility.ts';
      assert.ok(readFileSync(join(checkout, floorSource)).equals(readFileSync(join(original, floorSource))), 'Version fixtures must preserve real format reader floors.');
    }
    stage = `dependencies-${version}`;
    await run('bun', ['install', '--frozen-lockfile'], checkout);
    stage = `engine-${version}`; await run('bun', ['packages/engine/scripts/build.ts'], checkout);
    if (version === '3.1.3') {
      // Native TUI prebuild exports the engine's versioned operator contract;
      // WebUI preparation updates checked-in snapshots and versioned icon URLs.
      // Generate from this fixture's actual built engine before committing, so
      // the ordinary publisher can enforce its unchanged clean-source guard.
      stage = `generated-surfaces-${version}`;
      await run('bun', ['run', 'prepare:build'], join(checkout, 'products/tui'));
      await run('bun', ['scripts/prebuild.ts'], join(checkout, 'products/agent'));
      await run('bun', ['scripts/check-version.ts'], join(checkout, 'products/daemon'));
      await run('bun', ['scripts/release-prepare.ts', '--no-bump'], join(checkout, 'products/webui'));
      await run('git', ['add', '--update', '--', 'package.json', 'bun.lock', 'packages', 'products'], checkout);
      await run('git', ['-c', 'user.name=Unpublished native fixture', '-c', 'user.email=fixture@invalid.local',
        '-c', 'commit.gpgsign=false', 'commit', '-m', 'Unpublished 3.1.3 native lifecycle version fixture'], checkout);
    }
    const fixtureSource = await run('git', ['rev-parse', 'HEAD'], checkout); assert.match(fixtureSource, /^[a-f0-9]{40}$/);
    assert.equal(await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], checkout), 'HEAD');
    await run('git', ['diff', '--exit-code', 'HEAD'], checkout);
    stage = `native-${version}`;
    await run('bun', ['.github/scripts/package-suite-release.mjs', target, assets, `v${version}`, '--native-members-only'], checkout);
    const publisher = json(join(assets, `suite-release-source-${target}.json`));
    assert.equal(publisher.sourceCommit, fixtureSource); assert.equal(publisher.tag, `v${version}`); assert.equal(publisher.target, target);
    stage = `webui-${version}`; await run('bun', ['run', 'build'], join(checkout, 'products/webui'));
    const { packBundle } = await import(pathToFileURL(join(checkout, 'products/webui/scripts/pack-bundle.ts')).href);
    const packed = packBundle({ distDir: join(checkout, 'products/webui/dist'), outDir: assets, version });
    packed.assertCurrent(); packed.removeOwnedChecksum();
    assert.equal(revision(browser), originalBrowser); assert.equal(revision(manifestPath), originalManifest);
    copyFileSync(browser, join(assets, 'browser-driver.tar.gz'));
    assert.equal(revision(browser), originalBrowser);
    const pins = { ...publisher.files, [packed.assetName]: { sha256: packed.sha256, size: packed.size },
      'browser-driver.tar.gz': { sha256: browserPin[1], size: lstatSync(browser).size } };
    for (const [name, pin] of Object.entries(pins)) {
      assert.match(name, /^[A-Za-z0-9_.-]+$/); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
      assert.equal(lstatSync(join(assets, name)).size, pin.size);
    }
    packed.assertCurrent();
    writeFileSync(join(assets, 'SHA256SUMS.txt'), Object.entries(pins).map(([name, pin]) => `${pin.sha256}  ${name}\n`).join(''), { flag: 'wx', mode: 0o600 });
    await run('git', ['diff', '--exit-code', 'HEAD'], checkout);
    fixtures.push({ version, source: fixtureSource, assets: `assets-${version}`, checkout: `source-${version}`,
      webui: { assetName: packed.assetName, sha256: packed.sha256, size: packed.size } });
    receipt.fixtures.push({ version, source: fixtureSource, nativeProducts: 3, webui: 'actually built at fixture version' });
  }
  assert.equal(await run('git', ['rev-parse', 'HEAD'], original), source);
  await run('git', ['diff', '--exit-code', 'HEAD'], original);
  writeFileSync(join(root, 'fixtures.json'), JSON.stringify({ schema: 1, source, target, fixtures,
    browserSupport: { source: '81ce4d31b14b1b4a145672ed6257fc21c308c617', run: 42941236483,
      sha256: browserPin[1], provenance: 'original versionless archive and original manifest pin' } }) + '\n', { flag: 'wx', mode: 0o600 });
  controller.signal.throwIfAborted(); accepted = true;
} catch (error) { failure = acceptanceFailureRecord({ stage }, error); process.exitCode = 1;
  console.error('Unpublished Mac native fixture production failed.');
} finally {
  if (process.env.RUNNER_TEMP) writeFileSync(join(realpathSync(process.env.RUNNER_TEMP), 'macos-update-fixtures-result.json'),
    JSON.stringify({ ...receipt, accepted, ...(failure ? { failure } : {}) }) + '\n', { flag: 'wx', mode: 0o600 });
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
