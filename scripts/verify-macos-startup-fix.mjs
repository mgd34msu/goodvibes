/** Focused, unpublished Mac startup proof: current native programs/companions,
 * original unchanged shared archives, and the ordinary installed lifecycle. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { acceptanceFailureRecord, acceptPublishedSuite, readPublishedReaders } from './accept-published-suite.mjs';

const [source, tag, target, currentDirectory, supportDirectory] = process.argv.slice(2);
const sharedSource = '81ce4d31b14b1b4a145672ed6257fc21c308c617', sharedRun = 42941236483;
const sharedNames = ['browser-driver.tar.gz', 'goodvibes-webui-bundle-3.1.2.tar.gz'];
const commands = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
const flat = /^[A-Za-z0-9_.-]+$/;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const revision = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.uid, stat.mode].join(':');
const controller = new AbortController(), stop = () => controller.abort(new Error('Focused Mac verification owner stopped.'));
let stage = 'input-admission', failure;
process.once('SIGTERM', stop); process.once('SIGINT', stop);

async function verify() {
  assert.equal(process.platform, 'darwin'); assert.equal(target, `darwin-${process.arch}`);
  assert.match(source, /^[a-f0-9]{40}$/); assert.equal(tag, 'v3.1.2');
  const roots = [currentDirectory, supportDirectory].map(directory => {
    const path = realpathSync(directory), stat = lstatSync(path, { bigint: true });
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); return { path, revision: revision(stat) };
  });
  const retained = [];
  const retain = (path, limit = 536870912n) => {
    const stat = lstatSync(path, { bigint: true });
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0n && stat.size <= limit);
    const entry = { path, revision: revision(stat), size: Number(stat.size) }; retained.push(entry); return entry;
  };
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    for (const root of roots) assert.equal(revision(lstatSync(root.path, { bigint: true })), root.revision, 'Original input directory changed.');
    for (const entry of retained) assert.equal(revision(lstatSync(entry.path, { bigint: true })), entry.revision, 'Original verification input changed.');
  };
  stage = 'current-publisher';
  const inventory = retain(join(roots[0].path, `suite-release-source-${target}.json`), 131072n);
  const publisher = JSON.parse(readFileSync(inventory.path, 'utf8'));
  assert.equal(publisher.schema, 1); assert.equal(publisher.sourceCommit, source);
  assert.equal(publisher.target, target); assert.equal(publisher.tag, tag);
  assert.ok(publisher.files && typeof publisher.files === 'object' && !Array.isArray(publisher.files));
  const suffix = target.replace(/^darwin-/, 'macos-');
  const nativeNames = [...commands.flatMap(command => [`${command}-${suffix}`, `${command}-${suffix}.reader-ci-artifact.json`]),
    `sqlite-vec-${target}.dylib`, `sqlite-${target}.dylib`, `sqlite-${target}.dylib.json`];
  const members = new Map();
  for (const name of nativeNames) {
    assert.match(name, flat); const pin = publisher.files[name];
    assert.ok(pin && /^[a-f0-9]{64}$/.test(pin.sha256) && Number.isSafeInteger(pin.size) && pin.size > 0);
    const entry = retain(join(roots[0].path, name)); assert.equal(entry.size, pin.size);
    members.set(name, { ...entry, sha256: pin.sha256 });
  }
  stage = 'shared-support';
  const supportManifest = retain(join(roots[1].path, 'SHA256SUMS.txt'), 131072n);
  const supportPins = new Map();
  for (const line of readFileSync(supportManifest.path, 'utf8').trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    assert.ok(match && !supportPins.has(match[2]), 'Invalid original shared-support manifest.'); supportPins.set(match[2], match[1]);
  }
  for (const name of sharedNames) {
    assert.ok(supportPins.has(name)); members.set(name, { ...retain(join(roots[1].path, name)), sha256: supportPins.get(name) });
  }
  stage = 'current-readers';
  const readers = await readPublishedReaders({ source, tag, target, assets: new Set(members.keys()) }, async name => {
    const member = members.get(name); assert.ok(member && member.size <= 131072);
    const value = JSON.parse(readFileSync(member.path, 'utf8'));
    const command = commands.find(command => name === `${command}-${suffix}.reader-ci-artifact.json`);
    assert.ok(command); assert.equal(value.schema, 1);
    assert.equal(value.packageName, `@goodvibes-jev/${command === 'goodvibes' ? 'tui' : command === 'goodvibes-agent' ? 'agent' : 'daemon'}`);
    assert.equal(value.readers.version, tag.slice(1));
    const expected = command === 'goodvibes-daemon' ? [`${command}-${suffix}`, `lib/sqlite-vec-${target}/vec0.dylib`,
      `lib/sqlite-${target}/libsqlite3.dylib`, `lib/sqlite-${target}/libsqlite3.dylib.json`] : [`${command}-${suffix}`];
    assert.deepEqual(value.files.map(file => file.path), expected);
    for (const file of value.files) {
      const name = file.path.startsWith('lib/sqlite-vec-') ? `sqlite-vec-${target}.dylib`
        : file.path.startsWith('lib/sqlite-') ? `sqlite-${target}.dylib${file.path.endsWith('.json') ? '.json' : ''}` : file.path;
      const member = members.get(name); assert.ok(member); assert.equal(file.sha256, member.sha256); assert.equal(file.size, member.size);
    }
    assertCurrent(); return value;
  });
  let installerSource, installerSourcePath;
  const delivery = {
    get installerSource() { return installerSource; }, get installerSourcePath() { return installerSourcePath; },
    async admit({ root }) {
      stage = 'installer-delivery';
      assertCurrent();
      const manifest = join(root, 'focused-SHA256SUMS.txt');
      writeFileSync(manifest, [...members].map(([name, entry]) => `${entry.sha256}  ${name}\n`).join(''), { flag: 'wx', mode: 0o600 });
      members.set('SHA256SUMS.txt', retain(manifest, 131072n));
      const bytes = execFileSync('git', ['show', `${source}:scripts/install.sh`], { maxBuffer: 1_048_576 });
      installerSource = bytes.toString('utf8'); installerSourcePath = join(root, 'immutable-install.sh');
      writeFileSync(installerSourcePath, bytes, { flag: 'wx', mode: 0o600 }); retain(installerSourcePath, 1_048_576n);
      const installer = join(root, 'install.sh'), base = `https://github.com/mgd34msu/goodvibes/releases/download/${tag}/`;
      const cases = [...members].map(([name, entry]) => `    ${quote(name)}) cp ${quote(entry.path)} "$2" ;;`).join('\n');
      writeFileSync(installer, `#!/bin/sh\nGOODVIBES_INSTALL_SH_LIB=1\n. ${quote(installerSourcePath)}\nfetch() {\n  case "$1" in ${quote(base)}*) focused_name=\${1#${quote(base)}} ;; *) fail 'Unadmitted focused verification URL' ;; esac\n  case "$focused_name" in\n${cases}\n    *) fail 'Unadmitted focused verification asset' ;;\n  esac\n}\nmain "$@"\n`, { flag: 'wx', mode: 0o600 });
      retain(installer, 1_048_576n);
      stage = 'native-lifecycle';
      return { readers, installer, published: { url: `focused-macos-current-native:${source};original-shared-support:${sharedSource}`, bytes } };
    },
    assertCurrent,
    async preparePrevious() { throw new Error('Focused Mac verification does not claim a historical upgrade.'); },
  };
  stage = 'native-lifecycle';
  await acceptPublishedSuite({ source, tag, target, delivery, signal: controller.signal });
}

let accepted = false;
try { await verify(); controller.signal.throwIfAborted(); accepted = true; }
catch (error) {
  failure = acceptanceFailureRecord({ stage }, error);
  console.error('Focused Mac startup verification failed; no publication or all-platform qualification is claimed.'); process.exitCode = 1;
}
finally {
  const result = { accepted, source, tag, target, ...(failure ? { failure } : {}), nativePayloads: 'current selected Mac publisher cohort',
    sharedSupport: { source: sharedSource, run: sharedRun, members: sharedNames, provenance: 'original unchanged archive bytes and original manifest pins' },
    verificationContract: 'original hosted HOME; actual launchd boot/status/restart; exact version/readers/WebUI; update opt-out; uninstall/data preservation',
    ...(accepted ? { verifiedVersion: '3.1.2', nativeLifecycleVerified: true } : {}),
    allPlatformSuiteQualification: false, publication: false };
  if (process.env.RUNNER_TEMP) writeFileSync(join(resolve(process.env.RUNNER_TEMP), 'macos-startup-fix-result.json'), JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
