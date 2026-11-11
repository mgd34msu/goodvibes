/** Owned tooling regressions; they do not claim published native/service proof. */
import { afterEach, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acceptanceFailureRecord, finishAcceptance, waitForAcceptanceReadiness, assertHostedContext, readPublishedReaders, runAcceptanceSteps, runOwnedCommand, runHistoricalUpgradeSteps, assertHistoricalRollbackRefusal, type HistoricalUpgradeSteps, type AcceptanceSteps } from './accept-published-suite.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function steps(events: string[]): AcceptanceSteps {
  const record = (name: string) => async () => { events.push(name); };
  return { admit: record('admit'), install: record('install'), verifyInstalled: record('installed'),
    verifyDefaults: record('defaults'), disableUpdates: record('off'), restartAndVerifyOptOut: record('restart-off'),
    verifyOptOut: record('read-off'), uninstall: record('uninstall'), verifyPreserved: record('preserved') };
}
function nativeDaemonChild(root: string) {
  const command = join(root, 'goodvibes-daemon');
  writeFileSync(command, '#!/bin/sh\nprintf "%s" "$STATUS_STDOUT"\nprintf "%s" "$STATUS_STDERR" >&2\nexit "$STATUS_EXIT"\n', { mode: 0o700 });
  return (stderr: string, stdout = '', code = 1, diagnostics = true, args: readonly string[] = ['status', '--json']) => runOwnedCommand(command, args, {
    env: { ...process.env, STATUS_STDOUT: stdout, STATUS_STDERR: stderr, STATUS_EXIT: String(code) }, nativeDaemonDiagnostics: diagnostics,
  });
}
test('only original non-root GitHub-hosted native accounts admit real service acceptance', () => {
  const input = { env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: '/tmp/runner' },
    platform: 'linux', arch: 'x64', target: 'linux-x64', home: '/home/runner', accountHome: '/home/runner',
    uid: 1001, tag: 'v3.1.2', source: 'a'.repeat(40) };
  expect(() => assertHostedContext(input)).not.toThrow();
  for (const change of [{ home: '/tmp/fake-home' }, { uid: 0 }, { target: 'darwin-arm64' },
    { env: { ...input.env, RUNNER_ENVIRONMENT: 'self-hosted' } }, { tag: '../other' }, { source: 'main' }])
    expect(() => assertHostedContext({ ...input, ...change })).toThrow();
});
test('all native jobs use actual install/defaults/opt-out/reinstall/uninstall ordering', async () => {
  const events: string[] = []; await runAcceptanceSteps(steps(events));
  expect(events).toEqual(['admit', 'install', 'installed', 'defaults', 'off', 'restart-off', 'install', 'read-off',
    'uninstall', 'preserved', 'uninstall', 'preserved', 'install', 'installed', 'read-off', 'uninstall', 'preserved']);
});
test('foreign account admission failure never installs or uninstalls', async () => {
  const events: string[] = [], host = steps(events), original = new Error('Existing native service');
  host.admit = async () => { throw original; };
  await expect(runAcceptanceSteps(host)).rejects.toBe(original); expect(events).toEqual([]);
});
test('failed install awaits original cleanup before surfacing the original refusal', async () => {
  const events: string[] = [], host = steps(events), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = new Error('Original install failed');
  host.install = async () => { throw original; };
  host.uninstall = async () => { entered.resolve(); await release.promise; events.push('drained'); };
  const running = runAcceptanceSteps(host); let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  try { await entered.promise; expect(settled).toBe(false); release.resolve(); await expect(running).rejects.toBe(original); }
  finally { release.resolve(); await Promise.allSettled([running]); }
  expect(events).toEqual(['admit', 'drained', 'preserved']);
});
test('failed install and failed native cleanup both remain failures', async () => {
  const host = steps([]), original = new Error('Original publication failed'), cleanup = new Error('Original service did not drain');
  host.install = async () => { throw original; }; host.uninstall = async () => { throw cleanup; };
  await expect(runAcceptanceSteps(host)).rejects.toMatchObject({ name: 'AggregateError', errors: [original, cleanup] });
});

test('failure-only diagnostics run before original uninstall and their failure cannot skip owned cleanup', async () => {
  const events: string[] = [], host = steps(events), primary = new Error('Original install failed'), diagnostic = new Error('Owned diagnostics failed');
  host.install = async () => { events.push('install-failed'); throw primary; };
  host.diagnoseFailure = async () => { events.push('diagnose-failed'); throw diagnostic; };
  await expect(runAcceptanceSteps(host)).rejects.toMatchObject({ name: 'AggregateError', errors: [primary, diagnostic] });
  expect(events).toEqual(['admit', 'install-failed', 'diagnose-failed', 'uninstall', 'preserved']);
});

test('successful native acceptance never runs its optional failure diagnostic hook', async () => {
  const events: string[] = [], host = steps(events);
  host.diagnoseFailure = async () => { throw new Error('Successful acceptance must not diagnose failure'); };
  await runAcceptanceSteps(host);
  expect(events.at(-2)).toBe('uninstall'); expect(events.at(-1)).toBe('preserved');
});

test('a successful command followed by a failed assertion reports the proof and safe error code without private output', async () => {
  const secret = 'acceptance-private-launchctl-output-38df';
  const result = await runOwnedCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(secret)})`]);
  let failure: unknown;
  try { assert.match(result.stdout, /state = running/); } catch (error) { failure = error; }
  const record = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'service.running', command: 'launchctl', exitCode: result.code }, failure);
  expect(record).toEqual({ stage: 'verifyInstalled', check: 'service.running', command: 'launchctl', exitCode: 0,
    diagnostics: undefined, error: { name: 'AssertionError', code: 'ERR_ASSERTION' } });
  expect(JSON.stringify(record)).not.toContain(secret);
  const untrusted = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'installed.sqlite-library' },
    { name: secret, code: secret, message: secret, path: secret });
  expect(untrusted.error).toEqual({ name: 'Error' }); expect(JSON.stringify(untrusted)).not.toContain(secret);
});

test('owned status commands classify only fixed failure kinds from private stdout or stderr without exposing values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-status-')); roots.push(root);
  const invoke = nativeDaemonChild(root), secret = 'acceptance-private-status-value-40a9';
  const failure = (error: string) => JSON.stringify({ ok: false, error, fix: secret, target: `https://${secret}.invalid`,
    cause: { message: secret, code: secret }, headers: { Authorization: `Bearer ${secret}` } }, null, 2);
  const cases = [
    [failure('no operator token was found for this machine'), 'token-missing'],
    [failure(`'${secret}' is not a usable port`), 'invalid-port'],
    [failure(`could not reach the daemon at https://${secret}.invalid`), 'unreachable'],
    [failure(`the daemon at https://${secret}.invalid refused the operator token`), 'auth-refused'],
    [failure('the daemon on this machine does not know this command'), 'route-missing'],
    [failure('the daemon on this machine sent a reply this build could not read'), 'unreadable-reply'],
    [`private warning ${secret}\nDaemon command failed\n`, 'cli-command-caught'],
    [`error: Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.\nprivate stack ${secret}`, 'native-startup-repair'],
    [failure(secret), 'unknown'],
    [`{"ok":false,"error":"${secret}"`, 'unknown'],
  ] as const;
  for (const [output, kind] of cases) for (const stream of ['stderr', 'stdout']) {
    const result = await invoke(stream === 'stderr' ? output : '', stream === 'stdout' ? output : '');
    expect(result.code).toBe(1); expect(result.nativeDaemonFailure).toBe(kind); expect(result).not.toHaveProperty('stderr');
    const record = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'service.status-version', command: 'goodvibes-daemon',
      exitCode: result.code, nativeDaemonFailure: result.nativeDaemonFailure }, new Error(secret));
    expect(record.nativeDaemonFailure).toBe(kind);
    expect(JSON.stringify(record)).not.toContain(secret);
    expect(JSON.stringify(record)).not.toContain('Authorization'); expect(JSON.stringify(record)).not.toContain('https://');
  }
});

test('status diagnostics preserve nonzero exits, ignore unrelated fields and do not carry a failure into later probes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-status-probes-')); roots.push(root);
  const invoke = nativeDaemonChild(root), payload = JSON.stringify({ ok: false, error: 'no operator token was found for this machine' }, null, 2);
  const first = await invoke(`warning before machine reply\n${payload}`);
  expect(first.nativeDaemonFailure).toBe('token-missing');
  const success = await invoke('', '{"ok":true,"data":{}}', 0);
  expect(success).toEqual({ code: 0, stdout: '{"ok":true,"data":{}}' });
  const stale = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'service.status-version', exitCode: success.code,
    nativeDaemonFailure: first.nativeDaemonFailure }, new Error('Subsequent unrelated assertion'));
  expect(stale).not.toHaveProperty('nativeDaemonFailure');
  const unknown = await invoke(JSON.stringify({ ok: false, error: 'unrecognized', fix: 'no operator token was found for this machine',
    cause: 'Daemon command failed', headers: { error: 'the daemon on this machine refused the operator token',
      repair: 'Native daemon startup could not verify its installation. Repair using the released suite installer: curl -fsSL https://goodvibes.sh/install.sh | sh . The installer preserves existing application data.' } }));
  expect(unknown.nativeDaemonFailure).toBe('unknown');
  const nonzero = await invoke('', '{"ok":true,"data":{}}', 7);
  expect(nonzero.code).toBe(7); expect(nonzero.nativeDaemonFailure).toBe('unknown');
  expect(await invoke(payload, '', 1, false)).toEqual({ code: 1, stdout: '' });
});

test('native daemon diagnostics cover version, config and reader commands without exposing private output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-native-commands-')); roots.push(root);
  const invoke = nativeDaemonChild(root), secret = 'acceptance-private-native-command-f01b';
  for (const args of [['--version'], ['config', 'get', 'controlPlane.port', '--json'], ['check-install-reader', '--describe']]) {
    const result = await invoke(`private context ${secret}\nDaemon command failed\n`, '', 1, true, args);
    expect(result.code).toBe(1); expect(result.nativeDaemonFailure).toBe('cli-command-caught');
    expect(result).not.toHaveProperty('stderr');
    const record = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'installed.goodvibes-daemon.version',
      command: 'goodvibes-daemon', exitCode: result.code, nativeDaemonFailure: result.nativeDaemonFailure }, new Error(secret));
    expect(JSON.stringify(record)).not.toContain(secret);
  }
});

test('native diagnostic opt-in requires the installed daemon basename', async () => {
  await expect(runOwnedCommand(process.execPath, ['--version'], { nativeDaemonDiagnostics: true }))
    .rejects.toThrow('Native daemon diagnostics require the installed daemon executable basename.');
});

test('actual SIGKILL and SIGTERM failures retain safe OS signals and never become ordinary exit-one diagnoses', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-native-signals-')); roots.push(root);
  const command = join(root, 'goodvibes-daemon'), secret = 'acceptance-private-signal-context-42fa';
  writeFileSync(command, '#!/bin/sh\nulimit -c 0\nprintf "%s\\n" "$PRIVATE_CONTEXT" >&2\nkill -s "$EXIT_SIGNAL" "$$"\n', { mode: 0o700 });
  for (const signal of ['KILL', 'TERM'] as const) {
    const result = await runOwnedCommand(command, ['--version'], {
      env: { ...process.env, PRIVATE_CONTEXT: secret, EXIT_SIGNAL: signal }, nativeDaemonDiagnostics: true,
    });
    expect(result.code).toBe(1); expect(result.exitSignal).toBe(`SIG${signal}`); expect(result.nativeDaemonFailure).toBe('unknown');
    const record = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'installed.goodvibes-daemon.version',
      command: 'goodvibes-daemon', exitCode: result.code, exitSignal: result.exitSignal, nativeDaemonFailure: result.nativeDaemonFailure }, new Error(secret));
    expect(record.exitSignal).toBe(`SIG${signal}`); expect(JSON.stringify(record)).not.toContain(secret);
  }
  writeFileSync(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const success = await runOwnedCommand(command, ['--version'], { nativeDaemonDiagnostics: true });
  expect(success).toEqual({ code: 0, stdout: '' });
  const stale = acceptanceFailureRecord({ stage: 'verifyInstalled', exitCode: success.code, exitSignal: 'SIGKILL', nativeDaemonFailure: 'unknown' }, new Error('Later assertion'));
  expect(stale).not.toHaveProperty('exitSignal'); expect(stale).not.toHaveProperty('nativeDaemonFailure');
});

test('readiness retries the actual service observation before accepting a coherent status and HTTP proof', async () => {
  const events: string[] = []; let running = false, httpReady = false;
  await waitForAcceptanceReadiness(async () => {
    events.push('service');
    if (!running) { running = true; throw new Error('Service still starting'); }
  }, async () => {
    events.push('status-and-http');
    if (!httpReady) { httpReady = true; throw new Error('HTTP still starting'); }
  }, { timeoutMs: 1000, intervalMs: 1 });
  expect(events).toEqual(['service', 'service', 'status-and-http', 'service', 'status-and-http']);
});

test('readiness timeout keeps its last proof and safe filesystem cause without recording the private path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-readiness-')); roots.push(root);
  const secretPath = join(root, 'acceptance-private-missing-bundle');
  const evidence = { stage: 'verifyInstalled', check: 'webui.release-marker' }; let failure: unknown;
  try {
    await waitForAcceptanceReadiness(async () => {}, async () => { readFileSync(secretPath); }, { timeoutMs: 30, intervalMs: 5 });
  } catch (error) { failure = error; }
  const record = acceptanceFailureRecord(evidence, failure);
  expect(record).toMatchObject({ check: 'webui.release-marker', error: { code: 'ERR_ACCEPTANCE_READINESS_TIMEOUT' },
    lastProbeError: { name: 'Error', code: 'ENOENT' } });
  expect(JSON.stringify(record)).not.toContain(secretPath);
});

test('cancellation interrupts the readiness retry delay with the original reason and no further probes', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>(), reason = new Error('Original readiness owner stopped');
  let probes = 0;
  const running = waitForAcceptanceReadiness(async () => { probes++; entered.resolve(); throw new Error('Still starting'); }, async () => {},
    { signal: controller.signal, intervalMs: 60_000 });
  try {
    await entered.promise; await new Promise<void>(done => setImmediate(done));
    controller.abort(reason); await expect(running).rejects.toBe(reason);
    await new Promise<void>(done => setImmediate(done)); expect(probes).toBe(1);
  } finally { controller.abort(reason); await Promise.allSettled([running]); }
});

test('readiness cancellation retains an aggregate containing the original owner reason and failed drain', async () => {
  const controller = new AbortController(), reason = new Error('Original owner stopped'), drain = new Error('Owned group did not drain');
  const original = new AggregateError([reason, drain], 'Owned cancellation and drain failed');
  await expect(waitForAcceptanceReadiness(async () => { controller.abort(reason); throw original; }, async () => {},
    { signal: controller.signal })).rejects.toBe(original);
  expect(original.errors).toEqual([reason, drain]);
});

test('readiness cancellation retains a singular drain failure alongside its original owner reason', async () => {
  const controller = new AbortController(), reason = new Error('Original owner stopped'), drain = new Error('Owned group did not drain');
  await expect(waitForAcceptanceReadiness(async () => { controller.abort(reason); throw drain; }, async () => {},
    { signal: controller.signal })).rejects.toMatchObject({ name: 'AggregateError', errors: [reason, drain] });
});

test('cancellation during the actual final native cleanup still drains delivery and prevents a success receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-final-cleanup-')); roots.push(root);
  const receipt = join(root, 'accepted.json'), events: string[] = [], host = steps(events), controller = new AbortController();
  const reason = new Error('Owner stopped during final native cleanup'); let uninstalls = 0;
  host.uninstall = async () => { events.push('uninstall'); if (++uninstalls === 3) controller.abort(reason); };
  const running = (async () => {
    await runAcceptanceSteps(host);
    await finishAcceptance({ signal: controller.signal, finish: async () => { events.push('delivery-drained'); },
      assertCurrent: () => { events.push('delivery-current'); }, writeReceipt: () => { writeFileSync(receipt, '{"accepted":true}'); } });
  })();
  await expect(running).rejects.toBe(reason);
  expect(events.slice(-4)).toEqual(['uninstall', 'preserved', 'delivery-drained', 'delivery-current']);
  expect(existsSync(receipt)).toBe(false);
});

test('cancellation during the shared final delivery drain awaits that drain and prevents a success receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-final-feed-')); roots.push(root);
  const receipt = join(root, 'accepted.json'), controller = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const reason = new Error('Owner stopped during final delivery drain'); let drained = false, settled = false;
  const running = (async () => {
    await runAcceptanceSteps(steps([]));
    await finishAcceptance({ signal: controller.signal, finish: async () => { entered.resolve(); await release.promise; drained = true; },
      writeReceipt: () => { writeFileSync(receipt, '{"accepted":true}'); } });
  })();
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise; controller.abort(reason); await new Promise<void>(done => setImmediate(done));
    expect(settled).toBe(false); expect(existsSync(receipt)).toBe(false);
    release.resolve(); await expect(running).rejects.toBe(reason);
    expect(drained).toBe(true); expect(existsSync(receipt)).toBe(false);
  } finally { release.resolve(); await Promise.allSettled([running]); }
});

test('cancellation during an owned readiness command drains it before returning the original abort reason', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-ready-child-')); roots.push(root);
  const marker = join(root, 'started'), controller = new AbortController(), reason = new Error('Original readiness command owner stopped');
  let probes = 0;
  const running = waitForAcceptanceReadiness(async () => {
    probes++;
    await runOwnedCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`],
      { signal: controller.signal });
  }, async () => {}, { signal: controller.signal });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    expect(existsSync(marker)).toBe(true); const pid = Number(readFileSync(marker, 'utf8'));
    controller.abort(reason); await expect(running).rejects.toBe(reason);
    expect(() => process.kill(pid, 0)).toThrow(); expect(probes).toBe(1);
  } finally { controller.abort(reason); await Promise.allSettled([running]); }
});
test('actual owned command cancellation drains a SIGTERM-resistant child before returning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-child-')); roots.push(root);
  const marker = join(root, 'started'), controller = new AbortController();
  const running = runOwnedCommand(process.execPath, ['-e', `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000);`],
    { signal: controller.signal, timeoutMs: 10_000 });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise(done => setTimeout(done, 10));
    expect(existsSync(marker)).toBe(true); const pid = Number(readFileSync(marker, 'utf8'));
    controller.abort(new Error('Owned acceptance retired'));
    await expect(running).rejects.toThrow();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { controller.abort(); await Promise.allSettled([running]); }
});

test('failed owned installers report actual source refusals while stdout and expanded credentials stay private', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-diagnostics-')); roots.push(root);
  const secret = 'acceptance-secret-do-not-publish-7e384b';
  for (const stream of ['stdout', 'stderr']) {
    const installer = join(root, `install-${stream}.sh`);
    const source = `#!/bin/sh
set -eu
fail() { printf 'install.sh: %s\\n' "$*" ${stream === 'stderr' ? '>&2' : ''}; exit 1; }
printf '%s\\n' "$ACCEPTANCE_SECRET"
printf 'unrelated credential: %s\\n' "$ACCEPTANCE_SECRET" >&2
fail "Missing or ambiguous checksum: $ACCEPTANCE_SECRET. Release $ACCEPTANCE_SECRET is incomplete; no source build will be attempted."
`;
    writeFileSync(installer, source, { mode: 0o600 });
    const result = await runOwnedCommand('sh', [installer], { env: { ...process.env, ACCEPTANCE_SECRET: secret }, installerSource: source });
    expect(result.code).toBe(1); expect(result.stdout).toContain(secret);
    expect(result.diagnostics).toContain('install.sh: Missing or ambiguous checksum: [redacted]. Release [redacted] is incomplete; no source build will be attempted.');
    expect(JSON.stringify({ stage: 'install', exitCode: result.code, diagnostics: result.diagnostics })).not.toContain(secret);
    expect(result).not.toHaveProperty('stderr');
  }
});

test('actual shell failures retain their source line and OS cause without disclosing the failing path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-shell-diagnostics-')); roots.push(root);
  const installer = join(root, 'install.sh'), secretPath = join(root, 'acceptance-secret-missing-file');
  const source = '#!/bin/sh\nset -eu\nexec 9< "$ACCEPTANCE_SECRET"\n';
  writeFileSync(installer, source, { mode: 0o600 });
  const result = await runOwnedCommand('sh', [installer], { env: { ...process.env, ACCEPTANCE_SECRET: secretPath }, installerSource: source });
  expect(result.code).not.toBe(0);
  expect(result.diagnostics).toContain('Shell/OS failure at installer line 3: no such file or directory');
  expect(JSON.stringify(result)).not.toContain(secretPath);
});

test('owned child diagnostics normalize both Dash and Bash missing-file spellings without exposing paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-os-dialects-')); roots.push(root);
  const installer = join(root, 'install.sh'), secretPath = join(root, 'acceptance-secret-dialect-path');
  const source = '#!/bin/sh\nprintf "%s: 3: cannot open %s: %s\\n" "$0" "$ACCEPTANCE_SECRET" "$ACCEPTANCE_OS_REASON" >&2\nexit 1\n';
  writeFileSync(installer, source, { mode: 0o600 });
  for (const reason of ['No such file', 'No such file or directory']) {
    const result = await runOwnedCommand('sh', [installer], {
      env: { ...process.env, ACCEPTANCE_SECRET: secretPath, ACCEPTANCE_OS_REASON: reason }, installerSource: source,
    });
    expect(result.code).toBe(1);
    expect(result.diagnostics).toContain('Shell/OS failure at installer line 3: no such file or directory');
    expect(JSON.stringify(result)).not.toContain(secretPath);
    expect(result).not.toHaveProperty('stderr');
  }
});

test('unclassified installer output retains an owned source line while withholding credentials and arbitrary text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-unknown-diagnostics-')); roots.push(root);
  const installer = join(root, 'install.sh'), secret = 'acceptance-unrecognized-secret-812adb';
  const source = '#!/bin/sh\nprintf "%s: 2: unknown-%s\\n" "$0" "$ACCEPTANCE_SECRET" >&2\nexit 1\n';
  writeFileSync(installer, source, { mode: 0o600 });
  const result = await runOwnedCommand('sh', [installer], { env: { ...process.env, ACCEPTANCE_SECRET: secret }, installerSource: source });
  expect(result.diagnostics).toContain('Unclassified shell failure at installer line 2; dynamic output withheld.');
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('installer diagnostics preserve the shared stdout/stderr output bound without exposing overflow data', async () => {
  let failure: unknown;
  try {
    await runOwnedCommand(process.execPath, ['-e', `const fs=require('node:fs');fs.writeSync(1,Buffer.alloc(300000,120));fs.writeSync(2,Buffer.alloc(300000,121));`],
      { installerSource: '#!/bin/sh\n' });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Acceptance command output exceeded its bound.');
});

test('silent Bash set-e failure retains its actual function line before successful EXIT cleanup and hides credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-silent-diagnostics-')); roots.push(root);
  const installer = join(root, 'install.sh'), wrapper = join(root, 'adapter.sh'), cleanup = join(root, 'cleaned'), secret = 'acceptance-silent-secret-3d485f';
  const source = `#!/bin/sh
set -eu
[ "$0" = "$ACCEPTANCE_SCRIPT" ] && [ "$1" = original-argument ]
cleanup_release_install() {
  _install_exit=$?
  printf 'cleanup credential: %s\\n' "$ACCEPTANCE_SECRET" >&2
  printf 'cleaned\\n' > "$ACCEPTANCE_CLEANUP"
  exit "$_install_exit"
}
trap cleanup_release_install EXIT
refuse() {
  return 1
}
refuse
`;
  writeFileSync(installer, source, { mode: 0o600 });
  writeFileSync(wrapper, '. "$ACCEPTANCE_SOURCE"\n', { mode: 0o600 });
  const failedLine = source.split('\n').findIndex(line => line === '  return 1') + 1;
  for (const entry of [installer, wrapper]) {
    const result = await runOwnedCommand('bash', [entry, 'original-argument'], {
      env: { ...process.env, ACCEPTANCE_SCRIPT: entry, ACCEPTANCE_SOURCE: installer, ACCEPTANCE_CLEANUP: cleanup, ACCEPTANCE_SECRET: secret },
      installerSource: source, ...(entry === wrapper ? { installerSourcePath: installer } : {}),
    });
    expect(result.code).toBe(1); expect(readFileSync(cleanup, 'utf8')).toBe('cleaned\n');
    expect(result.diagnostics).toContain(`Installer exited nonzero after source line ${failedLine}; line captured before EXIT cleanup.`);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty('stderr');
  }
});

(existsSync('/bin/dash') ? test : test.skip)('dash parses the Bash-only metadata branch without changing original arguments or ordinary output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-dash-diagnostics-')); roots.push(root);
  const installer = join(root, 'install.sh');
  const source = '#!/bin/sh\nset -eu\n[ "$0" = "$ACCEPTANCE_SCRIPT" ]\n[ "$1" = original-argument ]\nprintf "ordinary output\\n"\n';
  writeFileSync(installer, source, { mode: 0o600 });
  const result = await runOwnedCommand('/bin/dash', [installer, 'original-argument'], {
    env: { ...process.env, ACCEPTANCE_SCRIPT: installer }, installerSource: source,
  });
  expect(result).toEqual({ code: 0, stdout: 'ordinary output\n' });
});

test('public producer proof reads only real program sidecars, never archive-only suite inventory', async () => {
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']) {
    const suffix = target.replace(/^darwin-/, 'macos-'), commands = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'];
    const assets = new Set(commands.flatMap(command => [`${command}-${suffix}`, `${command}-${suffix}.reader-ci-artifact.json`]));
    const requested: string[] = [];
    const load = async (name: string) => {
      requested.push(name); expect(name).not.toContain('suite-release-source-');
      return { target, sourceCommit: 'a'.repeat(40), headCommit: 'a'.repeat(40), readers: { version: '3.1.2' },
        files: [{ path: name.replace(/\.reader-ci-artifact\.json$/, '') }] };
    };
    const result = await readPublishedReaders({ target, tag: 'v3.1.2', source: 'a'.repeat(40), assets }, load);
    expect(result.size).toBe(3); expect(requested).toEqual(commands.map(command => `${command}-${suffix}.reader-ci-artifact.json`));
    assets.delete(`goodvibes-agent-${suffix}.reader-ci-artifact.json`);
    await expect(readPublishedReaders({ target, tag: 'v3.1.2', source: 'a'.repeat(40), assets }, load)).rejects.toThrow('cohort is missing');
    await expect(readPublishedReaders({ target, tag: 'v3.1.2', source: 'b'.repeat(40), assets: new Set([...assets, `goodvibes-agent-${suffix}.reader-ci-artifact.json`]) }, load)).rejects.toThrow();
  }
});

test('both actual publication workflows await one shared four-native-target acceptance matrix', () => {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected workflow mapping.');
    return value as Record<string, unknown>;
  };
  const workflow = (name: string) => object(Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', name), 'utf8')));
  const release = object(workflow('release.yml').jobs), suite = object(workflow('suite-release-assets.yml').jobs);
  const reusable = './.github/workflows/reusable-published-install-acceptance.yml';
  const fresh = object(release['published-install-acceptance']), existing = object(suite['published-install-acceptance']);
  expect(fresh.uses).toBe(reusable); expect(existing.uses).toBe(reusable);
  expect(fresh.needs).toEqual(['verify-tag-version', 'github-release']); expect(existing.needs).toBe('collect');
  // An explicit status check avoids implicit success() propagating a skipped
  // publish-npm ancestor; both required direct jobs must still have succeeded.
  expect(String(fresh.if).split(/\s*&&\s*/)).toEqual([
    '!cancelled()', "needs.verify-tag-version.result == 'success'", "needs.github-release.result == 'success'",
  ]);
  expect(existing.if).toBe("inputs.publish_existing && inputs.candidate-source == '' && needs.collect.result == 'success'");
  expect(object(existing.with).source).toBe('${{ needs.collect.outputs.source }}');
  expect(object(object(suite.collect).outputs).source).toBe('${{ steps.admit.outputs.source }}');
  for (const caller of [fresh, existing]) expect(object(caller.with)['tooling-sha']).toBe('${{ github.sha }}');
  const definition = workflow('reusable-published-install-acceptance.yml');
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    const inputs = object(object(object(definition.on)[trigger]).inputs);
    expect(Object.keys(inputs).sort()).toEqual(['source', 'tag', 'tooling-sha']);
    for (const input of Object.values(inputs).map(object)) {
      expect(input).toMatchObject({ required: true, type: 'string' });
      expect(input.default).toBeUndefined();
    }
  }
  const native = object(object(definition.jobs)['native-install']);
  const include = object(object(native.strategy).matrix).include;
  expect(include).toEqual([
    { target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' },
    { target: 'darwin-x64', runner: 'macos-15-intel' }, { target: 'darwin-arm64', runner: 'macos-15' },
  ]);
  expect(native['runs-on']).toBe('${{ matrix.runner }}');
  const steps = native.steps; if (!Array.isArray(steps)) throw new Error('Expected native steps.');
  expect(steps.map(object).find(step => String(step.uses).startsWith('actions/checkout@'))?.with)
    .toEqual({ ref: '${{ inputs.tooling-sha }}' });
  const install = steps.map(object).find(step => step.name === 'Download, install, serve and uninstall the published suite');
  expect(install?.env).toEqual({
    RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}',
  });
  expect(install?.run)
    .toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET"');
});

test('native release preparation retains its complete current merge tooling before the immutable source checkout', () => {
  const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/release.yml'), 'utf8')) as {
    jobs: Record<string, { steps?: { name?: string; uses?: string; run?: string; with?: { ref?: string } }[] }>;
  };
  const steps = workflow.jobs['prepare-native-assets']?.steps;
  if (!steps) throw new Error('Missing native release preparation steps.');
  const retained = steps.findIndex(step => step.name === 'Retain release merge tooling');
  const released = steps.findIndex(step => step.name === 'Checkout released source');
  expect(steps[0]?.name).toBe('Checkout release tooling');
  expect(steps[0]?.uses).toStartWith('actions/checkout@');
  expect(steps[0]?.with?.ref).toBeUndefined();
  expect(retained).toBeGreaterThan(0); expect(released).toBeGreaterThan(retained);
  expect(steps[released]?.with?.ref).toBe('${{ needs.verify-tag-version.outputs.sha }}');
  for (const filename of ['merge-suite-release-assets.py', 'release_asset_pins.py', 'release_asset_sources.py']) {
    expect(steps[retained]?.run).toContain(`.github/scripts/${filename}`);
  }
  const complete = steps.find(step => step.name === 'Complete the admitted native release');
  expect(complete?.run).toContain('python3 "$RUNNER_TEMP/release-merge-tooling/merge-suite-release-assets.py"');
  expect(complete?.run).toContain('"$RELEASE_TAG" "$SOURCE_SHA"');
});


function historicalSteps(events: string[]): HistoricalUpgradeSteps {
  const record = (name: string) => async () => { events.push(name); };
  return { admit: record('admit'), installPrevious: record('install-old-service-off'), verifyPrevious: record('original-old-versions-defaults'),
    seedPreviousData: record('original-data'), startPreviousService: record('start-old-service'), awaitAutomaticUpgrade: record('actual-auto-transition'),
    verifyUpgradedData: record('upgraded-data'), verifyRollbackRefusal: record('real-api-refusal'), uninstall: record('cleanup'), verifyPreserved: record('preserved') };
}

test('historical Linux delivery waits for actual old automatic transition before rollback and cleanup', async () => {
  const events: string[] = [], host = historicalSteps(events), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  host.awaitAutomaticUpgrade = async () => { events.push('observing-old-owner'); entered.resolve(); await release.promise; events.push('current-suite-observed'); };
  const running = runHistoricalUpgradeSteps(host);
  try {
    await entered.promise;
    expect(events).toEqual(['admit', 'install-old-service-off', 'original-old-versions-defaults', 'original-data', 'start-old-service', 'observing-old-owner']);
    release.resolve(); await running;
    expect(events.slice(-5)).toEqual(['current-suite-observed', 'upgraded-data', 'real-api-refusal', 'cleanup', 'preserved']);
  } finally { release.resolve(); await Promise.allSettled([running]); }
});

test('historical automatic-upgrade failure cannot be repaired by a current install and drains cleanup', async () => {
  const events: string[] = [], host = historicalSteps(events), original = new Error('Old automatic updater did not deliver'), cleanup = new Error('Original service did not drain');
  host.awaitAutomaticUpgrade = async () => { events.push('failed-auto-transition'); throw original; };
  host.uninstall = async () => { events.push('failed-cleanup'); throw cleanup; };
  await expect(runHistoricalUpgradeSteps(host)).rejects.toMatchObject({ name: 'AggregateError', errors: [original, cleanup] });
  expect(events).toEqual(['admit', 'install-old-service-off', 'original-old-versions-defaults', 'original-data', 'start-old-service', 'failed-auto-transition', 'failed-cleanup']);
});

test('historical rollback accepts only the actual admission refusal and checks original file/tree observations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-rollback-refusal-')); roots.push(root);
  const events: string[] = [];
  class Refusal extends Error {
    readonly receipt = { operation: 'rollback', phase: 'admission', committed: false, recoveryRequired: false };
    constructor() { super('Native cohort refused', { cause: new Error('Previous native cohort is incomplete; refusing partial rollback') }); }
  }
  const plan = { files: [{ path: join(root, 'program') }], directories: [{ path: join(root, 'webui') }], assertCurrent() { events.push('plan-current'); } };
  const verifier = {
    resolveSuiteUpdatePlan: () => plan,
    captureUpdateFileIo: (io: object) => io, realUpdateFileIo: {},
    retainNativeUpdateSources: (_paths: readonly string[], _io: object) => () => { events.push('files-current'); },
    retainNativeUpdateTree: (_path: string) => ({ assertCurrent() { events.push('tree-current'); } }),
    rollbackSuiteUpdate(_options: { assertCurrent(): void; beforeCommit(): void }) { events.push('actual-rollback'); throw new Refusal(); },
    UpdateTransactionError: Refusal,
  };
  const input = { bin: root, version: '3.1.2', webuiDirectory: join(root, 'webui') };
  await assertHistoricalRollbackRefusal(input, verifier);
  expect(events.indexOf('actual-rollback')).toBeGreaterThan(events.indexOf('files-current'));
  expect(events.slice(-4)).toEqual(['files-current', 'tree-current', 'tree-current', 'files-current']);
  for (const wrong of [new Error('Verifier dependency missing'), new Error('Invalid invocation'), Object.assign(new Refusal(), { receipt: { operation: 'rollback', phase: 'admission', committed: false, recoveryRequired: true } })]) {
    verifier.rollbackSuiteUpdate = () => { throw wrong; };
    await expect(assertHistoricalRollbackRefusal(input, verifier)).rejects.toThrow();
  }
  verifier.rollbackSuiteUpdate = options => { options.beforeCommit(); throw new Refusal(); };
  await expect(assertHistoricalRollbackRefusal(input, verifier)).rejects.toThrow('must refuse before admission');
  verifier.rollbackSuiteUpdate = () => { throw new Refusal(); };
  verifier.retainNativeUpdateSources = () => {
    let checks = 0;
    return () => { if (++checks > 1) throw new Error('Original installed file changed'); };
  };
  await expect(assertHistoricalRollbackRefusal(input, verifier)).rejects.toThrow('Original installed file changed');
});

test('historical upgrade uses separate Linux-only hosted accounts and a verifier build without native payload copying', () => {
  const value = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/reusable-published-install-acceptance.yml'), 'utf8')) as {
    jobs: Record<string, { if: string; strategy: { matrix: { include: Array<{ target: string; runner: string }> } }; steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }> }>;
  };
  const job = value.jobs['historical-linux-upgrade']!;
  expect(job.if).toBe("inputs.tag == 'v3.1.2'");
  expect(job.strategy.matrix.include).toEqual([{ target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' }]);
  expect(job.steps.find(step => String(step.uses).startsWith('actions/checkout@'))?.with).toEqual({ ref: '${{ inputs.source }}' });
  expect(job.steps.find(step => step.name === 'Verify the original released payload source')?.run).toBe('test "$(git rev-parse HEAD)" = "$PAYLOAD_SOURCE"');
  expect(job.steps.find(step => step.name === 'Build only the source-bound rollback verifier')?.run)
    .toBe('bun install --frozen-lockfile\nbun packages/engine/scripts/build.ts\n');
  const upgrade = job.steps.find(step => step.name === 'Observe actual old unattended upgrade and unsupported rollback refusal');
  expect(upgrade?.env).toEqual({
    RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}',
  });
  expect(upgrade?.run)
    .toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET" upgrade-v3.1.1');
});
