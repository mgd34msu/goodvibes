/** Native lifecycle acceptance on disposable GitHub-hosted accounts only.
 * Public and staged delivery share the actual source installer, compiled native
 * programs and original service manager; no simulated service substitutes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundedNativeProcessClose, drainNativeProcessGroup, signalNativeProcessGroup } from '../products/daemon/scripts/native-execution-process.mjs';

const repository = 'mgd34msu/goodvibes';
const products = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
const unit = 'goodvibes.service', label = 'sh.goodvibes.daemon';

// Acceptance-only metadata: Bash (including macOS sh) records source line
// numbers without tracing commands, arguments or credentials. Dash skips this.
// Opening/closing the private scalar journal avoids passing another descriptor
// into installed services. Freeze before the installer's EXIT cleanup runs.
const installerLineProbe = `if [ -n "\${BASH_VERSION:-}" ]; then
  set -T
  trap 'case "\${FUNCNAME[0]-}:$BASH_COMMAND" in cleanup_release_install:*|*:cleanup_release_install) trap - DEBUG ;; *) if [ "\${BASH_SOURCE[0]-}" = "$GOODVIBES_ACCEPTANCE_SOURCE_PATH" ] && [ "$LINENO" -gt 0 ] && [ "$LINENO" -le "$GOODVIBES_ACCEPTANCE_LINE_LIMIT" ]; then printf "%s\\n" "$LINENO" 2>/dev/null >"$GOODVIBES_ACCEPTANCE_LINE_PATH" || :; fi ;; esac' DEBUG
fi
. "$0"`;

/** Emit public source literals and fixed error classes only. In particular,
 * paths, expanded shell variables and unrelated stdout/stderr stay private. */
function installerFailureDiagnostics(source, stdout, stderr) {
  const templates = [], sourceLines = source.split('\n').length;
  for (const match of source.matchAll(/\bfail\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)) {
    const text = (match[1] ?? match[2]).split('\n')[0];
    // Unsupported shell quoting/substitution must never turn into raw output.
    if (!text || /[\\`]|\$\(/.test(text)) continue;
    const parts = match[1] !== undefined ? [text] : text.split(/(\$(?:\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?]))/g);
    if (!parts.some((part, index) => index % 2 === 0 && /[A-Za-z]{3}/.test(part))) continue;
    templates.push({ literals: parts.filter((_part, index) => index % 2 === 0).map((part, index) => index === 0 ? `install.sh: ${part}` : part),
      diagnostic: `install.sh: ${parts.map((part, index) => index % 2 ? '[redacted]' : part).join('')}`.slice(0, 512) });
  }
  const diagnostics = new Set();
  for (const line of `${stderr}\n${stdout}`.split(/\r?\n/)) {
    const template = templates.find(({ literals }) => {
      if (literals.length === 1) return line === literals[0];
      if (!line.startsWith(literals[0]) || !line.endsWith(literals.at(-1))) return false;
      let offset = literals[0].length;
      return literals.slice(1).every(literal => {
        const found = line.indexOf(literal, offset); if (found < 0) return false;
        offset = found + literal.length; return true;
      });
    });
    if (template) diagnostics.add(template.diagnostic);
    // Shells print different prefixes; preserve only an in-range source line.
    const number = /:\s*(?:line\s+)?(\d+):/.exec(line)?.[1];
    const location = number && Number(number) > 0 && Number(number) <= sourceLines ? ` at installer line ${Number(number)}` : '';
    const reason = /(?:^|: )(Bad file descriptor|Bad fd number|Is a directory|Not a directory|Permission denied|Operation not permitted|No such file(?: or directory)?|not found|command not found|parameter not set|unbound variable|Illegal instruction|Segmentation fault|Exec format error|Argument list too long|Syntax error|Bad substitution|Read-only file system|Too many open files|No space left on device|unexpected operator)(?:$|[ .(:])/i.exec(line)?.[1];
    // Dash abbreviates missing read-redirection targets to "No such file".
    const canonicalReason = /^no such file(?: or directory)?$/i.test(reason ?? '') ? 'no such file or directory' : reason?.toLowerCase();
    if (canonicalReason) diagnostics.add(`Shell/OS failure${location}: ${canonicalReason}`);
    else if (location && !template) diagnostics.add(`Unclassified shell failure${location}; dynamic output withheld.`);
    const curl = /^curl: \((\d{1,3})\)/.exec(line);
    if (curl) diagnostics.add(`curl failed with error ${Number(curl[1])}; dynamic output withheld.`);
    if (diagnostics.size >= 8) break;
  }
  return [...diagnostics].slice(0, 8);
}

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
  const { timeoutMs = 120_000, signal, installerSource, installerSourcePath = args[0], ...spawnOptions } = options;
  signal?.throwIfAborted();
  const shell = command.split(sep).at(-1);
  const probe = installerSource !== undefined && ['sh', 'bash', 'dash'].includes(shell);
  const probeRoot = probe ? mkdtempSync(join(tmpdir(), 'goodvibes-acceptance-line-')) : undefined;
  const probePath = probeRoot && join(probeRoot, 'line');
  let child;
  try {
    if (probePath) writeFileSync(probePath, '', { flag: 'wx', mode: 0o600 });
    child = spawn(command, probe ? [...(shell === 'bash' ? ['--posix'] : []), '-c', installerLineProbe, ...args] : args,
      { ...spawnOptions, ...(probePath ? { env: { ...(spawnOptions.env ?? process.env), GOODVIBES_ACCEPTANCE_LINE_PATH: probePath,
        GOODVIBES_ACCEPTANCE_SOURCE_PATH: installerSourcePath,
        GOODVIBES_ACCEPTANCE_LINE_LIMIT: String(installerSource.split('\n').length) } } : {}), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { if (probeRoot) rmSync(probeRoot, { recursive: true, force: true }); throw error; }
  let stdout = '', stderr = '', bytes = 0, failOutput;
  const overflow = new Promise((_yes, no) => { failOutput = no; });
  const consume = (chunk, retain) => {
    bytes += chunk.length;
    if (bytes > 512 * 1024) failOutput(new Error('Acceptance command output exceeded its bound.'));
    else if (retain) stdout += chunk.toString('utf8');
    else if (installerSource !== undefined) stderr += chunk.toString('utf8');
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
  let result, failure, lastInstallerLine;
  try {
    if (signal?.aborted) cancel();
    result = await boundedNativeProcessClose(Promise.race([closed, overflow, cancelled]), timeoutMs, 'Acceptance command exceeded its bound.');
  } catch (error) { failure = error; }
  finally {
    signal?.removeEventListener('abort', cancel);
    try { await drainNativeProcessGroup(child, closed); }
    catch (error) { failure = failure ? new AggregateError([failure, error], 'Acceptance child drain failed.') : error; }
    if (probeRoot) {
      try {
        const metadata = readFileSync(probePath, 'utf8');
        if (/^\d{1,10}\n$/.test(metadata) && Number(metadata) > 0 && Number(metadata) <= installerSource.split('\n').length)
          lastInstallerLine = Number(metadata);
      } catch { /* Numeric metadata is optional; original failures stay primary. */ }
      finally { rmSync(probeRoot, { recursive: true, force: true }); }
    }
  }
  if (failure) throw failure;
  if (result.code !== 0 && installerSource !== undefined) {
    result.diagnostics = installerFailureDiagnostics(installerSource, stdout, stderr);
    if (lastInstallerLine) result.diagnostics.unshift(`Installer exited nonzero after source line ${lastInstallerLine}; line captured before EXIT cleanup.`);
    result.diagnostics = result.diagnostics.slice(0, 8);
  }
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

/** Linux historical delivery uses the actual old unattended updater. The
 * current installer is reserved for finally-cleanup, never upgrade repair. */
export async function runHistoricalUpgradeSteps(host) {
  await host.admit();
  let attempted = false, primary;
  try {
    attempted = true; await host.installPrevious();
    await host.verifyPrevious(); await host.seedPreviousData();
    await host.startPreviousService(); await host.awaitAutomaticUpgrade();
    await host.verifyUpgradedData(); await host.verifyRollbackRefusal();
  } catch (error) { primary = error; }
  finally {
    if (attempted) {
      try { await host.uninstall(); await host.verifyPreserved(); }
      catch (error) { primary = primary ? new AggregateError([primary, error], 'Historical acceptance and owned cleanup failed.') : error; }
    }
  }
  if (primary) throw primary;
}

/** Invoke the actual platform API against the downloaded installed tree.
 * The separately built verifier supplies no installed bytes and does not claim
 * an interactive compiled /update rollback was driven by this acceptance. */
export async function assertHistoricalRollbackRefusal(input, verifier) {
  input.signal?.throwIfAborted();
  const modulePath = name => input.sourceRoot
    ? pathToFileURL(join(input.sourceRoot, 'packages/engine/platform/dist/platform/runtime', name)).href
    : new URL(`../packages/engine/platform/dist/platform/runtime/${name}`, import.meta.url).href;
  const api = verifier ?? await import(modulePath('self-update.js'));
  const sources = verifier ?? await import(modulePath('compiled-native-startup.js'));
  const trees = verifier ?? await import(modulePath('update-directories.js'));
  const options = { execPath: join(input.bin, 'goodvibes-daemon'), platform: 'linux', arch: process.arch,
    currentVersion: input.version, version: input.version, webuiDirectory: input.webuiDirectory };
  const plan = api.resolveSuiteUpdatePlan(options);
  // This is the real historical absence, not a constructed invalid argument.
  assert.ok(plan.files.some(file => !existsSync(file.path + '.previous')), 'The historical previous native cohort is unexpectedly complete.');
  const files = sources.retainNativeUpdateSources(plan.files.flatMap(file => ['', '.previous'].map(tail => file.path + tail)),
    api.captureUpdateFileIo(api.realUpdateFileIo));
  const transient = sources.retainNativeUpdateSources(plan.files.flatMap(file => ['.update-transaction', '.update-download', '.update-previous', '.rollback-exchange'].map(tail => file.path + tail)),
    api.captureUpdateFileIo(api.realUpdateFileIo));
  const directories = plan.directories.flatMap(directory => [directory.path, directory.path + '.previous']).map(path => trees.retainNativeUpdateTree(path));
  const current = () => { input.signal?.throwIfAborted(); plan.assertCurrent(); files(); for (const directory of directories) directory.assertCurrent(); };
  let commitReached = false, refusal;
  current(); transient();
  try {
    api.rollbackSuiteUpdate({ ...options, assertCurrent: current, beforeCommit() {
      commitReached = true; throw new Error('Historical rollback unexpectedly reached the commit boundary.');
    } });
  } catch (error) { refusal = error; }
  assert.equal(commitReached, false, 'The historical rollback must refuse before admission to effects.');
  assert.ok(refusal instanceof api.UpdateTransactionError, 'Only the actual incomplete native-cohort refusal counts.');
  assert.equal(refusal.receipt.operation, 'rollback'); assert.equal(refusal.receipt.phase, 'admission');
  assert.equal(refusal.receipt.committed, false); assert.equal(refusal.receipt.recoveryRequired, false);
  assert.ok(refusal.cause instanceof Error);
  assert.equal(refusal.cause.message, 'Previous native cohort is incomplete; refusing partial rollback');
  current(); transient();
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
      failures: evidence.failures.length ? evidence.failures : [{ stage: evidence.stage, command: evidence.command, exitCode: evidence.exitCode, diagnostics: evidence.diagnostics }],
      diagnostic: input.delivery ? 'Staged native install/service/cleanup acceptance failed.' : 'Published native install/service/cleanup acceptance failed.' };
    if (evidence.root) writeFileSync(join(evidence.root, 'acceptance-result.json'), JSON.stringify(diagnostic) + '\n', { flag: 'wx', mode: 0o600 });
    console.error(JSON.stringify(diagnostic));
    throw error;
  }
}

async function performPublishedAcceptance({ tag, source, target, signal, scenario = 'fresh', delivery }, evidence) {
  assert.ok(scenario === 'fresh' || scenario === 'upgrade-v3.1.1', 'Unknown published acceptance scenario.');
  const historical = scenario === 'upgrade-v3.1.1';
  if (historical) {
    assert.equal(process.platform, 'linux', 'The published old automatic updater supports Linux only.');
    assert.equal(tag, 'v3.1.2', 'This scenario verifies the actual v3.1.1 to v3.1.2 delivery contract.');
  }
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
  const invoke = async (command, args, extra = {}, cleanup = false, installerSource, installerSourcePath) => {
    assertHome(); evidence.command = command.split(sep).at(-1); evidence.exitCode = undefined; evidence.diagnostics = undefined;
    const result = await runOwnedCommand(command, args, { cwd: home, env: { ...env, ...extra }, timeoutMs: 300_000,
      signal: cleanup ? undefined : signal, installerSource, installerSourcePath }); assertHome();
    evidence.exitCode = result.code; evidence.diagnostics = result.diagnostics;
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
  let readers, published, installer;
  if (delivery) {
    evidence.stage = 'staged-candidate';
    ({ readers, published, installer } = await delivery.admit({ tag, source, target, root, signal }));
  } else {
    const release = JSON.parse((await fetchBytes(`${api}/releases/tags/${tag}`)).bytes);
    assert.equal(release.tag_name, tag); assert.equal(release.draft, false);
    assert.ok(Array.isArray(release.assets) && release.assets.length >= 65, 'The complete native suite must be published first.');
    const names = new Set(release.assets.map(asset => asset.name));
    assert.equal(names.size, release.assets.length); assert.ok(names.has('SHA256SUMS.txt'));
    readers = await readPublishedReaders({ tag, source, target, assets: names }, async name =>
      JSON.parse((await fetchBytes(`https://github.com/${repository}/releases/download/${tag}/${name}`, 131_072)).bytes));
    const latest = JSON.parse((await fetchBytes(`${api}/releases/latest`)).bytes);
    assert.equal(latest.tag_name, tag, 'Default updater acceptance requires this exact tag to be latest.');
    evidence.stage = 'public-installer';
    const immutable = await fetchBytes(`https://raw.githubusercontent.com/${repository}/${source}/scripts/install.sh`);
    published = await fetchBytes('https://goodvibes.sh/install.sh');
    assert.match(published.url, /^https:\/\/raw\.githubusercontent\.com\/mgd34msu\/goodvibes\/(?:main|[a-f0-9]{40})\/scripts\/install\.sh$/);
    assert.ok(published.bytes.equals(immutable.bytes), 'The public installer differs from the accepted release source.');
    installer = join(root, 'install.sh'); writeFileSync(installer, published.bytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(root, 'immutable-install.sh'), immutable.bytes, { flag: 'wx', mode: 0o600 });
  }
  const installEnv = { GOODVIBES_VERSION: tag, GOODVIBES_WAKE_MODEL: '0', GOODVIBES_SHADOW_REMOVE: '0' };
  let previousInstaller, previousSource, previousReader;
  if (historical) {
    evidence.stage = 'historical-source';
    const oldRelease = JSON.parse((await fetchBytes(`${api}/releases/tags/v3.1.1`)).bytes);
    assert.equal(oldRelease.tag_name, 'v3.1.1'); assert.equal(oldRelease.draft, false);
    const oldNames = new Set(oldRelease.assets.map(asset => asset.name));
    const suffix = target;
    for (const name of [...products.flatMap(command => ['', '.bun', '.bun.json', '.bun.LICENSE.md'].map(tail => `${command}-${suffix}${tail}`)),
      `goodvibes-daemon-${suffix}.ci-artifact.json`, `sqlite-vec-${target}.so`, 'browser-driver.tar.gz', 'goodvibes-webui-bundle-3.1.1.tar.gz', 'SHA256SUMS.txt']) {
      assert.ok(oldNames.has(name), 'The actual old Linux release cohort is incomplete.');
    }
    const reference = JSON.parse((await fetchBytes(`${api}/git/ref/tags/v3.1.1`, 131_072)).bytes);
    assert.equal(reference.ref, 'refs/tags/v3.1.1');
    let object = reference.object; assert.match(object.sha, /^[a-f0-9]{40}$/);
    if (object.type === 'tag') {
      const annotated = JSON.parse((await fetchBytes(`${api}/git/tags/${object.sha}`, 131_072)).bytes);
      assert.equal(annotated.sha, object.sha); assert.equal(annotated.tag, 'v3.1.1'); object = annotated.object;
    }
    assert.equal(object.type, 'commit'); previousSource = object.sha; assert.match(previousSource, /^[a-f0-9]{40}$/);
    previousReader = JSON.parse((await fetchBytes(`https://github.com/${repository}/releases/download/v3.1.1/goodvibes-daemon-${target}.ci-artifact.json`, 131_072)).bytes);
    assert.equal(previousReader.target, target); assert.equal(previousReader.sourceCommit, previousSource); assert.equal(previousReader.headCommit, previousSource);
    const old = await fetchBytes(`https://raw.githubusercontent.com/${repository}/${previousSource}/scripts/install.sh`);
    previousInstaller = join(root, 'install-v3.1.1.sh');
    writeFileSync(previousInstaller, old.bytes, { flag: 'wx', mode: 0o600 });
  }
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
  const sentinel = join(data, 'published-acceptance-preserved.txt'); let preserved, originalWebui;
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
    async install() { await invoke('sh', [installer], installEnv, false, delivery?.installerSource ?? readFileSync(installer, 'utf8'), delivery?.installerSourcePath); },
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
          const bundle = await setting('controlPlane.webui.bundleDir'); if (!historical) assert.equal(resolve(bundle), join(bin, 'webui', version));
          else assert.equal(resolve(bundle), originalWebui, 'Automatic upgrade must preserve the actual configured WebUI selection.');
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
    async uninstall() { await invoke('sh', [installer], { ...installEnv, GOODVIBES_UNINSTALL: '1' }, true, delivery?.installerSource ?? readFileSync(installer, 'utf8'), delivery?.installerSourcePath); },
    verifyPreserved,
  };
  const previousInstallEnv = { GOODVIBES_VERSION: 'v3.1.1', GOODVIBES_WAKE_MODEL: '0' };
  const upgrade = {
    admit: host.admit,
    async installPrevious() { await invoke('sh', [previousInstaller], { ...previousInstallEnv, GOODVIBES_DAEMON_SERVICE: '0' }, false, readFileSync(previousInstaller, 'utf8')); },
    async verifyPrevious() {
      for (const name of products) assert.equal(await invoke(join(bin, name), ['--version']), `${name} 3.1.1`);
      await host.verifyDefaults();
      const installed = JSON.parse(readFileSync(join(bin, 'daemon-installation.json'), 'utf8'));
      assert.equal(installed.version, '3.1.1'); assert.deepEqual(installed.artifact, previousReader);
      assert.equal(lstatSync(servicePath, { throwIfNoEntry: false }), undefined, 'Old programs must be recorded before service activation.');
      originalWebui = resolve(await setting('controlPlane.webui.bundleDir'));
      assert.equal(originalWebui, join(bin, 'webui', '3.1.1'));
    },
    async seedPreviousData() {
      mkdirSync(data, { recursive: true }); preserved = 'Original 3.1.1 data survives the actual automatic delivery and refusal.\n';
      writeFileSync(sentinel, preserved, { flag: 'wx', mode: 0o600 });
      // A real supported saved value, distinct from its default, must survive.
      await invoke(daemon, ['config', 'set', 'update.intervalMinutes', '61']);
      assert.equal(await setting('update.intervalMinutes'), 61);
      if (delivery) await delivery.preparePrevious({ invoke, daemon, setting });
    },
    async startPreviousService() {
      // Deliberately re-run the OLD installer. No current installer or direct
      // apply API is permitted to perform the version transition being proved.
      await invoke('sh', [previousInstaller], previousInstallEnv, false, readFileSync(previousInstaller, 'utf8')); await service('check');
    },
    async awaitAutomaticUpgrade() {
      const deadline = Date.now() + 10 * 60_000; let complete = false;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        try {
          for (const name of products) assert.equal(await invoke(join(bin, name), ['--version']), `${name} ${version}`);
          await host.verifyInstalled(); complete = true; break;
        } catch { signal?.throwIfAborted(); await new Promise(done => setTimeout(done, 1000)); }
      }
      assert.ok(complete, 'The original 3.1.1 daemon did not automatically deliver the complete current suite.');
      await host.verifyDefaults();
    },
    async verifyUpgradedData() {
      assert.equal(readFileSync(sentinel, 'utf8'), preserved);
      assert.equal(await setting('update.intervalMinutes'), 61);
      assert.equal(resolve(await setting('controlPlane.webui.bundleDir')), originalWebui);
    },
    async verifyRollbackRefusal() {
      await host.verifyInstalled(); await upgrade.verifyUpgradedData();
      // Retire the real periodic owner before its installed-tree API check.
      await invoke(daemon, ['config', 'set', 'update.auto', 'false']);
      await service('restart'); await host.verifyInstalled(); await upgrade.verifyUpgradedData();
      // Implemented below through the actual source-bound platform rollback
      // API, never by inventing old reader metadata or a nonexistent CLI verb.
      await assertHistoricalRollbackRefusal({ bin, version, webuiDirectory: originalWebui, signal,
        ...(delivery?.rollbackSourceRoot ? { sourceRoot: delivery.rollbackSourceRoot } : {}) });
      await host.verifyInstalled(); await upgrade.verifyUpgradedData();
    },
    uninstall: host.uninstall, verifyPreserved,
  };
  const selectedHost = historical ? upgrade : host;
  for (const name of Object.keys(selectedHost)) {
    const original = selectedHost[name];
    selectedHost[name] = async () => {
      evidence.stage = name; evidence.command = undefined; evidence.exitCode = undefined; evidence.diagnostics = undefined;
      try { return await original(); }
      catch (error) { evidence.failures.push({ stage: name, command: evidence.command, exitCode: evidence.exitCode, diagnostics: evidence.diagnostics }); throw error; }
    };
  }
  if (historical) await runHistoricalUpgradeSteps(selectedHost);
  else await runAcceptanceSteps(selectedHost);
  if (delivery?.finish) {
    evidence.stage = 'staged-delivery-drain'; evidence.command = undefined; evidence.exitCode = undefined; evidence.diagnostics = undefined;
    await delivery.finish();
  }
  delivery?.assertCurrent();
  writeFileSync(join(root, 'acceptance-result.json'), JSON.stringify({ tag, source, target, scenario, ...(historical ? { previousTag: 'v3.1.1', previousSource } : {}),
    ...(delivery ? { delivery: historical ? 'exact staged candidate; installer fetch adapter and owned loopback update feed'
      : 'exact staged candidate; installer fetch adapter', candidateInstaller: published.url, publicDelivery: 'not claimed' } : { publicInstaller: published.url }),
    installedProducts: [...products, 'goodvibes-webui'], defaultService: true, updateDefaults: true, optOutPersisted: !historical,
    uninstallPreservedData: true, futureVersionUpgrade: historical ? 'actual old unattended daemon plus pre-graph suite repair' : 'not claimed', publicRollback: historical ? 'incomplete historical cohort refused without effects' : 'not claimed' }) + '\n', { flag: 'wx', mode: 0o600 });

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [tag, source, target, scenario = 'fresh'] = process.argv.slice(2);
  const controller = new AbortController(), stop = () => controller.abort(new Error('Acceptance owner stopped.'));
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  acceptPublishedSuite({ tag, source, target, scenario, signal: controller.signal }).catch(() => { console.error('Published suite acceptance failed; no successful native install claim was emitted.'); process.exitCode = 1; })
    .finally(() => { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); });
}
