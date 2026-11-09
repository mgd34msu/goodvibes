/** Public-release acceptance on disposable GitHub-hosted native accounts only.
 * No build output, Actions payload or simulated service substitutes for install. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from '../products/daemon/scripts/native-execution-process.mjs';

const repository = 'mgd34msu/goodvibes';
const products = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
const unit = 'goodvibes.service', label = 'sh.goodvibes.daemon';

export function assertHostedContext(input) {
  assert.equal(input.env.GITHUB_ACTIONS, 'true', 'Acceptance requires a disposable Actions account.');
  assert.equal(input.env.RUNNER_ENVIRONMENT, 'github-hosted', 'Persistent/self-hosted accounts are refused.');
  assert.match(input.tag, /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  assert.match(input.source, /^[a-f0-9]{40}$/);
  assert.equal(input.target, `${input.platform}-${input.arch}`);
  assert.ok(['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(input.target));
  assert.equal(input.home, input.accountHome, 'A HOME override cannot isolate a native service manager.');
  assert.ok(input.uid > 0, 'Do not install into the root account.');
  assert.ok(input.env.RUNNER_TEMP && isAbsolute(input.env.RUNNER_TEMP));
}

/** Drain the exact admitted child before reporting timeout/cancellation. Output
 * stays bounded/private: installer/status output can contain local credentials. */
export async function runOwnedCommand(command, args, options = {}) {
  const { timeoutMs = 120_000, signal, ...spawnOptions } = options;
  signal?.throwIfAborted();
  const child = spawn(command, args, { ...spawnOptions, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', bytes = 0, failOutput;
  const overflow = new Promise((_yes, no) => { failOutput = no; });
  const consume = (chunk, retain) => {
    bytes += chunk.length;
    if (bytes > 512 * 1024) failOutput(new Error('Acceptance command output exceeded its bound.'));
    else if (retain) stdout += chunk.toString('utf8');
  };
  child.stdout.on('data', chunk => consume(chunk, true));
  child.stderr.on('data', chunk => consume(chunk, false));
  const closed = new Promise((yes, no) => {
    child.once('error', () => no(new Error('Acceptance command could not start.')));
    child.once('close', code => yes({ code: code ?? 1, stdout }));
  });
  let rejectCancellation;
  const cancelled = new Promise((_yes, no) => { rejectCancellation = no; });
  const cancel = () => {
    try { signalNativeProcessGroup(child, 'SIGTERM'); rejectCancellation(new Error('Acceptance command canceled.')); }
    catch (error) { rejectCancellation(error); }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  let result, failure;
  try {
    if (signal?.aborted) cancel();
    result = await boundedNativeProcessClose(Promise.race([closed, overflow, cancelled]), timeoutMs, 'Acceptance command exceeded its bound.');
  } catch (error) { failure = error; }
  finally {
    signal?.removeEventListener('abort', cancel);
    try { await drainNativeProcessGroup(child, closed); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance child drain failed.') : error; }
  }
  if (failure) throw failure;
  signal?.throwIfAborted(); return result;
}

/** A single ordering contract, shared by all four native workflow jobs. Cleanup
 * is always awaited and failures retain both the primary and cleanup failure. */
export async function runAcceptanceSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.install();
    await host.verifyInstalled(); await host.verifyDefaults();
    await host.disableUpdates(); await host.restartAndVerifyOptOut();
    await host.install(); await host.verifyOptOut();
    await host.uninstall(); await host.verifyPreserved();
    await host.uninstall(); await host.verifyPreserved();
    await host.install(); await host.verifyInstalled(); await host.verifyOptOut();
  } catch (error) { primary = error; }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Acceptance and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

/** These are the actual public per-program producer descriptors. The suite
 * archive's suite-release-source-* inventory is intentionally not published. */
export async function readPublishedReaders(input, load) {
  const suffix = input.target.replace(/^darwin-/, 'macos-'), records = new Map();
  for (const command of products) {
    const asset = `${command}-${suffix}`, descriptor = `${asset}.reader-ci-artifact.json`;
    assert.ok(input.assets.has(asset) && input.assets.has(descriptor), 'A public native reader cohort is missing.');
    const value = await load(descriptor);
    assert.equal(value.target, input.target); assert.equal(value.sourceCommit, input.source); assert.equal(value.headCommit, input.source);
    assert.equal(value.version ?? value.readers?.version, input.tag.slice(1));
    assert.ok(Array.isArray(value.files) && value.files.some(file => file.path === asset));
    records.set(command, value);
  }
  return records;
}

async function fetchBytes(url, limit = 1_048_576) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  assert.equal(response.status, 200, 'Public release request did not succeed.');
  const reader = response.body?.getReader(); assert.ok(reader);
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; assert.ok(size <= limit, 'Public metadata exceeds its bound.'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return { bytes: Buffer.concat(chunks), url: response.url };
}

export async function acceptPublishedSuite(input) {
  const evidence = { stage: 'account-admission', failures: [] };
  try { await performPublishedAcceptance(input, evidence); }
  catch (error) {
    const diagnostic = { tag: input.tag, source: input.source, target: input.target, accepted: false,
      failures: evidence.failures.length ? evidence.failures : [{ stage: evidence.stage, command: evidence.command, exitCode: evidence.exitCode }],
      diagnostic: 'Published native install/service/cleanup acceptance failed.' };
    if (evidence.root) writeFileSync(join(evidence.root, 'acceptance-result.json'), JSON.stringify(diagnostic) + '\n', { flag: 'wx', mode: 0o600 });
    console.error(JSON.stringify(diagnostic));
    throw error;
  }
}

async function performPublishedAcceptance({ tag, source, target, signal }, evidence) {
  const account = userInfo(), home = realpathSync(process.env.HOME ?? '');
  assertHostedContext({ env: process.env, platform: process.platform, arch: process.arch,
    home, accountHome: realpathSync(account.homedir), uid: account.uid, tag, source, target });
  const originalHome = lstatSync(home, { bigint: true });
  const assertHome = () => {
    const now = lstatSync(home, { bigint: true });
    assert.ok(now.isDirectory() && !now.isSymbolicLink() && now.dev === originalHome.dev && now.ino === originalHome.ino && now.uid === originalHome.uid);
    assert.equal(realpathSync(home), home);
  };
  const bin = join(home, '.local/bin'), data = join(home, '.goodvibes');
  const servicePath = process.platform === 'linux' ? join(home, '.config/systemd/user', unit)
    : join(home, 'Library/LaunchAgents', `${label}.plist`);
  for (const path of [data, servicePath, ...products.map(name => join(bin, name))])
    assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, 'Existing GoodVibes ownership is not an acceptance fixture.');
  for (const path of [join(home, '.local'), bin, join(home, '.config'), join(home, '.config/systemd'), join(home, '.config/systemd/user'),
    join(home, 'Library'), join(home, 'Library/LaunchAgents')]) {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (stat) assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path, 'Native install parents must belong to the original account.');
  }
  const root = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'goodvibes-published-')); evidence.root = root;
  evidence.stage = 'native-service-context';
  const env = { ...process.env, HOME: home };
  for (const name of Object.keys(env)) if (/^(?:GOODVIBES_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|JEV_|CLEF_)/.test(name)
    || ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'NODE_OPTIONS', 'BUN_OPTIONS'].includes(name)) delete env[name];
  const invoke = async (command, args, extra = {}, cleanup = false) => {
    assertHome(); evidence.command = command.split(sep).at(-1); evidence.exitCode = undefined;
    const result = await runOwnedCommand(command, args, { cwd: home, env: { ...env, ...extra }, timeoutMs: 300_000, signal: cleanup ? undefined : signal }); assertHome();
    evidence.exitCode = result.code;
    assert.equal(result.code, 0, `Acceptance command failed: ${command.split(sep).at(-1)}`); return result.stdout.trim();
  };
  if (process.platform === 'linux') {
    env.XDG_RUNTIME_DIR = `/run/user/${account.uid}`;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
    await invoke('sudo', ['-n', 'loginctl', 'enable-linger', account.username]);
    await invoke('sudo', ['-n', 'systemctl', 'start', `user@${account.uid}.service`]);
    await invoke('systemctl', ['--user', 'show-environment']);
    for (const name of [unit, 'goodvibes-daemon.service']) {
      const probe = await runOwnedCommand('systemctl', ['--user', 'show', name, '--property=LoadState', '--value'], { env });
      assert.equal(probe.stdout.trim(), 'not-found', 'An existing native service must never be adopted.');
    }
  } else {
    await invoke('launchctl', ['print', `gui/${account.uid}`]);
    const probe = await runOwnedCommand('launchctl', ['print', `gui/${account.uid}/${label}`], { env });
    assert.notEqual(probe.code, 0, 'An existing LaunchAgent must never be adopted.');
  }
  evidence.stage = 'published-catalog'; evidence.command = undefined; evidence.exitCode = undefined;
  const api = `https://api.github.com/repos/${repository}`;
  const release = JSON.parse((await fetchBytes(`${api}/releases/tags/${tag}`)).bytes);
  assert.equal(release.tag_name, tag); assert.equal(release.draft, false);
  assert.ok(Array.isArray(release.assets) && release.assets.length >= 65, 'The complete native suite must be published first.');
  const names = new Set(release.assets.map(asset => asset.name));
  assert.equal(names.size, release.assets.length); assert.ok(names.has('SHA256SUMS.txt'));
  const readers = await readPublishedReaders({ tag, source, target, assets: names }, async name =>
    JSON.parse((await fetchBytes(`https://github.com/${repository}/releases/download/${tag}/${name}`, 131_072)).bytes));
  const latest = JSON.parse((await fetchBytes(`${api}/releases/latest`)).bytes);
  assert.equal(latest.tag_name, tag, 'Default updater acceptance requires this exact tag to be latest.');
  evidence.stage = 'public-installer';
  const immutable = await fetchBytes(`https://raw.githubusercontent.com/${repository}/${source}/scripts/install.sh`);
  const published = await fetchBytes('https://goodvibes.sh/install.sh');
  assert.match(published.url, /^https:\/\/raw\.githubusercontent\.com\/mgd34msu\/goodvibes\/(?:main|[a-f0-9]{40})\/scripts\/install\.sh$/);
  assert.ok(published.bytes.equals(immutable.bytes), 'The public installer differs from the accepted release source.');
  const installer = join(root, 'install.sh'); writeFileSync(installer, published.bytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(root, 'immutable-install.sh'), immutable.bytes, { flag: 'wx', mode: 0o600 });
  const installEnv = { GOODVIBES_VERSION: tag, GOODVIBES_WAKE_MODEL: '0', GOODVIBES_SHADOW_REMOVE: '0' };
  const daemon = join(bin, 'goodvibes-daemon'), version = tag.slice(1);
  const setting = async key => {
    const result = JSON.parse(await invoke(daemon, ['config', 'get', key, '--json']));
    assert.equal(result.ok, true); assert.equal(result.data.key, key); return result.data.value;
  };
  const assertServiceOwned = () => {
    assertHome(); const stat = lstatSync(servicePath); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    assert.ok(readFileSync(servicePath, 'utf8').includes(daemon), 'The service must retain this exact admitted executable.');
  };
  const service = async action => {
    assertServiceOwned();
    if (process.platform === 'linux') await invoke('systemctl', ['--user', action === 'restart' ? 'restart' : 'is-active', unit]);
    else {
      if (action === 'restart') await invoke('launchctl', ['kickstart', '-k', `gui/${account.uid}/${label}`]);
      const status = await invoke('launchctl', ['print', `gui/${account.uid}/${label}`]); assert.match(status, /state = running/);
    }
  };
  const sentinel = join(data, 'published-acceptance-preserved.txt'); let preserved;
  const verifyOptOut = async () => { for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) assert.equal(await setting(key), false); };
  const verifyPreserved = async () => {
    if (preserved !== undefined) assert.equal(readFileSync(sentinel, 'utf8'), preserved);
    for (const name of products) assert.ok(!existsSync(join(bin, name)), 'Uninstall must remove original installed programs.');
    assert.equal(lstatSync(servicePath, { throwIfNoEntry: false }), undefined, 'Uninstall must retire its original native service.');
    const stopped = process.platform === 'linux'
      ? await runOwnedCommand('systemctl', ['--user', 'is-active', unit], { env })
      : await runOwnedCommand('launchctl', ['print', `gui/${account.uid}/${label}`], { env });
    assert.notEqual(stopped.code, 0, 'The original service must stop before uninstall is acknowledged.');
  };
  const host = {
    async admit() { assertHome(); },
    async install() { await invoke('sh', [installer], installEnv); },
    async verifyInstalled() {
      for (const name of products) {
        assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${version}`);
        const reader = readers.get(name);
        assert.deepEqual(JSON.parse(await invoke(join(bin, name), ['check-install-reader', '--describe'])), reader.readers);
        const installed = JSON.parse(readFileSync(join(bin, name === 'goodvibes-daemon' && process.platform === 'linux' ? 'daemon-installation.json' : `${name}.readers.json`), 'utf8'));
        assert.deepEqual(name === 'goodvibes-daemon' && process.platform === 'linux' ? installed.artifact : installed, reader);
      }
      await service('check');
      const extension = process.platform === 'linux' ? 'so' : 'dylib';
      assert.ok(lstatSync(join(bin, 'lib', `sqlite-vec-${target}`, `vec0.${extension}`)).isFile());
      if (process.platform === 'darwin') for (const name of ['libsqlite3.dylib', 'libsqlite3.dylib.json'])
        assert.ok(lstatSync(join(bin, 'lib', `sqlite-${target}`, name)).isFile());
      assert.ok(lstatSync(join(bin, 'playwright-core', 'package.json')).isFile());
      const deadline = Date.now() + 90_000; let observed = false;
      while (Date.now() < deadline) {
        try {
          const status = JSON.parse(await invoke(daemon, ['status', '--json']));
          assert.equal(status.ok, true); assert.equal(status.data.identity.version, version);
          const port = await setting('controlPlane.port'); assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
          const bundle = await setting('controlPlane.webui.bundleDir'); assert.equal(resolve(bundle), join(bin, 'webui', version));
          const marker = JSON.parse(readFileSync(join(bundle, '.goodvibes-release.json'), 'utf8')); assert.equal(marker.version, version);
          assert.equal(await setting('controlPlane.webui.serve'), true);
          const page = await fetchBytes(`http://127.0.0.1:${port}/`, 2_097_152);
          assert.ok(page.bytes.equals(readFileSync(join(bundle, 'index.html'))), 'Actual daemon must serve the installed released WebUI.');
          observed = true; break;
        } catch { await new Promise(done => setTimeout(done, 500)); }
      }
      assert.ok(observed, 'The actual installed service/WebUI did not become ready.');
    },
    async verifyDefaults() { for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) assert.equal(await setting(key), true); },
    async disableUpdates() {
      for (const key of ['update.auto', 'update.autoUpdateAtLaunch']) await invoke(daemon, ['config', 'set', key, 'false']);
      mkdirSync(data, { recursive: true }); preserved = 'Original owned data survives actual uninstall and reinstall.\n';
      writeFileSync(sentinel, preserved, { flag: 'wx', mode: 0o600 });
    },
    async restartAndVerifyOptOut() { await service('restart'); await host.verifyInstalled(); await verifyOptOut(); },
    verifyOptOut,
    async uninstall() { await invoke('sh', [installer], { ...installEnv, GOODVIBES_UNINSTALL: '1' }, true); },
    verifyPreserved,
  };
  for (const name of Object.keys(host)) {
    const original = host[name];
    host[name] = async () => {
      evidence.stage = name; evidence.command = undefined; evidence.exitCode = undefined;
      try { return await original(); }
      catch (error) { evidence.failures.push({ stage: name, command: evidence.command, exitCode: evidence.exitCode }); throw error; }
    };
  }
  await runAcceptanceSteps(host);
  writeFileSync(join(root, 'acceptance-result.json'), JSON.stringify({ tag, source, target, publicInstaller: published.url,
    installedProducts: [...products, 'goodvibes-webui'], defaultService: true, updateDefaults: true, optOutPersisted: true,
    uninstallPreservedData: true, futureVersionUpgrade: 'not claimed', publicRollback: 'not claimed' }) + '\n', { flag: 'wx', mode: 0o600 });

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, source, target] = process.argv.slice(2);
  const controller = new AbortController(), stop = () => controller.abort(new Error('Acceptance owner stopped.'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  acceptPublishedSuite({ tag, source, target, signal: controller.signal }).catch(() => { console.error('Published suite acceptance failed; no successful native install claim was emitted.'); process.exitCode = 1; })
    .finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
