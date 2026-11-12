/** Owned tooling regressions; they do not claim published native/service proof. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { acceptPublishedSuite, consumeAcceptanceMetadataFetch, acceptanceFailureRecord, markAcceptanceCheckpoint, readPublicAcceptanceDelivery, finishAcceptance, waitForAcceptanceReadiness, waitForNativeServiceRetirement, assertHostedContext, readPublishedReaders, runAcceptanceSteps, runOwnedCommand, runHistoricalUpgradeSteps, runInstallerMigrationSteps, assertHistoricalRollbackRefusal, type InstallerMigrationSteps, type HistoricalUpgradeSteps, type AcceptanceSteps, type NativeServiceRetirementObservation, type AcceptanceFetch } from './accept-published-suite.mjs';

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

function publicDeliveryFixture(metadataToken?: string) {
  const source = 'a'.repeat(40), tag = 'v3.1.2', target = 'darwin-arm64';
  const api = 'https://api.github.com/repos/mgd34msu/goodvibes', download = `https://github.com/mgd34msu/goodvibes/releases/download/${tag}/`;
  const releaseUrl = `${api}/releases/tags/${tag}`, latestUrl = `${api}/releases/latest`;
  const immutableUrl = `https://raw.githubusercontent.com/mgd34msu/goodvibes/${source}/scripts/install.sh`, publicUrl = 'https://goodvibes.sh/install.sh';
  const descriptors = ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent'].map(command => `${command}-macos-arm64.reader-ci-artifact.json`);
  const assets = ['SHA256SUMS.txt', ...descriptors.flatMap(name => [name, name.replace('.reader-ci-artifact.json', '')]),
    ...Array.from({ length: 58 }, (_, i) => `other-native-member-${i}`)].map(name => ({ name }));
  const release = { tag_name: tag, draft: false, assets }, latest = { tag_name: tag };
  const readers = descriptors.map(name => ({ target, sourceCommit: source, headCommit: source, readers: { version: '3.1.2' },
    files: [{ path: name.replace('.reader-ci-artifact.json', '') }] }));
  const responses = new Map<string, { body: unknown; status?: number; url?: string }>([
    [releaseUrl, { body: release }], [latestUrl, { body: latest }],
    [immutableUrl, { body: '#!/bin/sh\nexit 0\n' }], [publicUrl, { body: '#!/bin/sh\nexit 0\n', url: immutableUrl }],
    ...descriptors.map((name, i) => [download + name, { body: readers[i] }] as const),
  ]);
  const evidence: Parameters<typeof acceptanceFailureRecord>[0] = { stage: 'published-catalog' }, requests: string[] = [];
  const fixtureFetch: AcceptanceFetch = async (url, options) => {
    if (metadataToken && url.startsWith(api + '/')) {
      expect(new Headers(options.headers).get('authorization')).toBe(`Bearer ${metadataToken}`);
      expect(options.redirect).toBe('error');
    } else expect(options.headers).toBeUndefined();
    requests.push(url);
    const fixture = responses.get(url); if (!fixture) throw new Error('Unowned public fixture request');
    const body = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
    const response = new Response(body, { status: fixture.status ?? 200, headers: { 'x-private-fixture': 'private-http-header-sentinel' } });
    Object.defineProperty(response, 'url', { value: fixture.url ?? url }); return response;
  };
  const deliveryFetch = metadataToken ? consumeAcceptanceMetadataFetch({ GOODVIBES_ACCEPTANCE_METADATA_TOKEN: metadataToken }, fixtureFetch).fetch : fixtureFetch;
  const deliver = () => readPublicAcceptanceDelivery({ tag, source, target,
    checkpoint(check) { markAcceptanceCheckpoint(evidence, check); }, onHttpStatus(status) { evidence.httpStatus = status; },
  }, deliveryFetch);
  return { evidence, requests, responses, release, latest, readers, releaseUrl, latestUrl, publicUrl, immutableUrl, descriptors, download, deliver };
}

test('metadata inspection authenticates only the exact canonical repository GET routes', async () => {
  const token = 'metadata-only-sentinel', env: NodeJS.ProcessEnv = { GOODVIBES_ACCEPTANCE_METADATA_TOKEN: token };
  const requests: Array<{ url: string; options: RequestInit }> = [];
  const metadata = consumeAcceptanceMetadataFetch(env, async (url, options) => { requests.push({ url, options }); return new Response('{}'); });
  expect(env).toEqual({}); expect(metadata.authentication).toBe('read-only-ci-token');
  const api = 'https://api.github.com/repos/mgd34msu/goodvibes';
  const known = ['/releases/tags/v3.1.2', '/releases/tags/v3.1.3-rc.1', '/releases/latest', '/git/ref/tags/v3.1.2', '/git/tags/' + 'a'.repeat(40)];
  for (const path of known) await metadata.fetch(api + path, { redirect: 'follow' });
  for (const request of requests) {
    expect(new Headers(request.options.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(request.options.redirect).toBe('error');
  }
  requests.length = 0;
  const unknown = [api + '/releases', api + '/releases/assets/123', api + '/git/ref/heads/main', api + '/releases/latest?private=1',
    api + '/releases/latest#fragment', api + '/releases/latest\n', api + '/releases/tags/v3.1.2/../latest',
    api.replace('mgd34msu/goodvibes', 'someone/else') + '/releases/latest', api.replace('api.github.com', 'api.github.com.evil.invalid') + '/releases/latest',
    api.replace('https:', 'http:') + '/releases/latest', api.replace('api.github.com', 'api.github.com:443') + '/releases/latest',
    api.replace('api.github.com', 'user@api.github.com') + '/releases/latest',
    'https://github.com/mgd34msu/goodvibes/releases/download/v3.1.2/SHA256SUMS.txt',
    'https://raw.githubusercontent.com/mgd34msu/goodvibes/main/scripts/install.sh', 'https://goodvibes.sh/install.sh'];
  for (const url of unknown) await metadata.fetch(url, {});
  await metadata.fetch(api + '/releases/latest', { method: 'POST' });
  expect(requests).toHaveLength(unknown.length + 1);
  for (const request of requests) { expect(request.options.headers).toBeUndefined(); expect(request.options.redirect).toBeUndefined(); }
  expect(JSON.stringify(metadata)).not.toContain(token);
});

test('metadata inspection actually refuses redirects before credentials reach the destination', async () => {
  let originRequests = 0, redirectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/destination') { redirectedRequests++; response.end('{}'); }
    else { originRequests++; response.writeHead(302, { Location: '/destination' }); response.end(); }
  });
  try {
    await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    // Only this owned fixture rewrites the fixed API destination to localhost.
    const metadata = consumeAcceptanceMetadataFetch({ GOODVIBES_ACCEPTANCE_METADATA_TOKEN: 'owned-fixture-token' },
      (_url, options) => fetch(`http://127.0.0.1:${address.port}/origin`, options));
    await expect(metadata.fetch('https://api.github.com/repos/mgd34msu/goodvibes/releases/latest', {})).rejects.toThrow();
    expect(originRequests).toBe(1); expect(redirectedRequests).toBe(0);
  } finally { await new Promise<void>((yes, no) => { server.close(error => error ? no(error) : yes()); server.closeAllConnections(); }); }
});

test('acceptance consumes the dedicated token before failure or an owned installer/product child', async () => {
  const name = 'GOODVIBES_ACCEPTANCE_METADATA_TOKEN', previous = process.env[name], token = 'private-metadata-credential-sentinel';
  const output = spyOn(console, 'error').mockImplementation(() => {});
  process.env[name] = token;
  try {
    await expect(acceptPublishedSuite({ tag: 'v3.1.2', source: 'a'.repeat(40), target: 'linux-x64', scenario: 'invalid' as never })).rejects.toThrow('Unknown published acceptance scenario');
    expect(process.env[name]).toBeUndefined();
    const child = await runOwnedCommand(process.execPath, ['-e', 'process.stdout.write(process.env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN === undefined ? "absent" : "present")']);
    expect(child.code).toBe(0); expect(child.stdout).toBe('absent');
    const explicit = await runOwnedCommand(process.execPath, ['-e', 'process.stdout.write(process.env.GOODVIBES_ACCEPTANCE_METADATA_TOKEN === undefined ? "absent" : "present")'], { env: { ...process.env } });
    expect(explicit.code).toBe(0); expect(explicit.stdout).toBe('absent');
    expect(JSON.stringify(output.mock.calls)).not.toContain(token);
    expect(output.mock.calls[0]?.[0]).toContain('canonical-repository-metadata-get-only');
  } finally { output.mockRestore(); if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
});

test('authenticated catalog inspection preserves complete anonymous public readers and installer delivery', async () => {
  const fixture = publicDeliveryFixture('private-metadata-sentinel');
  const result = await fixture.deliver();
  expect(result.readers.size).toBe(3);
  expect(result.published.bytes.equals(result.immutable.bytes)).toBe(true);
  expect(fixture.requests).toEqual([fixture.releaseUrl, ...fixture.descriptors.map(name => fixture.download + name), fixture.latestUrl, fixture.immutableUrl, fixture.publicUrl]);
  expect(JSON.stringify(result)).not.toContain('private-metadata-sentinel');
});

async function publicDeliveryFailure(fixture: ReturnType<typeof publicDeliveryFixture>) {
  let failure: unknown;
  try { await fixture.deliver(); } catch (error) { failure = error; }
  expect(failure).toBeDefined(); return acceptanceFailureRecord(fixture.evidence, failure);
}

for (const status of [403, 429, 503]) test(`public catalog retains only actual HTTP ${status} and its fixed request checkpoint`, async () => {
  const fixture = publicDeliveryFixture(), secret = 'private-http-body-token-sentinel';
  fixture.responses.set(fixture.releaseUrl, { status, body: { message: secret, authorization: `Bearer ${secret}` }, url: `https://private.invalid/${secret}` });
  const record = await publicDeliveryFailure(fixture);
  expect(record).toMatchObject({ stage: 'published-catalog', check: 'catalog.release.http', httpStatus: status,
    error: { name: 'AssertionError', code: 'ERR_ASSERTION' } });
  expect(fixture.requests).toEqual([fixture.releaseUrl]);
  for (const value of [secret, 'private-http-header-sentinel', 'private.invalid', 'Bearer']) expect(JSON.stringify(record)).not.toContain(value);
});

test('malformed HTTP200 catalog JSON retains its request status without returning the private body', async () => {
  const fixture = publicDeliveryFixture(), secret = 'private-malformed-response-sentinel';
  fixture.responses.set(fixture.releaseUrl, { body: `{${secret}` });
  const record = await publicDeliveryFailure(fixture);
  expect(record).toMatchObject({ check: 'catalog.release.http', httpStatus: 200, error: { name: 'SyntaxError' } });
  expect(JSON.stringify(record)).not.toContain(secret);
});

for (const field of ['tag', 'draft', 'asset-count', 'unique-assets', 'manifest']) test(`public release ${field} refusal has its own checkpoint and clears prior HTTP status`, async () => {
  const fixture = publicDeliveryFixture();
  if (field === 'tag') fixture.release.tag_name = 'private-wrong-tag-sentinel';
  if (field === 'draft') fixture.release.draft = true;
  if (field === 'asset-count') fixture.release.assets = [];
  if (field === 'unique-assets') fixture.release.assets[0] = fixture.release.assets[1]!;
  if (field === 'manifest') fixture.release.assets[0] = { name: 'private-wrong-manifest-sentinel' };
  const record = await publicDeliveryFailure(fixture);
  expect(record.check).toBe(`catalog.release.${field}`); expect(record.httpStatus).toBeUndefined();
  expect(record.error).toEqual({ name: 'AssertionError', code: 'ERR_ASSERTION' });
  expect(JSON.stringify(record)).not.toContain('sentinel');
});

for (const field of ['target', 'source', 'head', 'version', 'files']) test(`public reader ${field} validation identifies its original assertion without echoing values`, async () => {
  const fixture = publicDeliveryFixture(), reader = fixture.readers[0]!;
  if (field === 'target') reader.target = 'private-reader-sentinel';
  if (field === 'source') reader.sourceCommit = 'private-reader-sentinel';
  if (field === 'head') reader.headCommit = 'private-reader-sentinel';
  if (field === 'version') reader.readers.version = 'private-reader-sentinel';
  if (field === 'files') reader.files = [];
  const record = await publicDeliveryFailure(fixture);
  expect(record.check).toBe(`catalog.reader.goodvibes.${field}`); expect(record.httpStatus).toBeUndefined();
  expect(record.error).toEqual({ name: 'AssertionError', code: 'ERR_ASSERTION' }); expect(JSON.stringify(record)).not.toContain('sentinel');
});

test('public latest and installer refusals keep distinct checkpoints after earlier successful requests', async () => {
  const latest = publicDeliveryFixture(); latest.latest.tag_name = 'private-latest-sentinel';
  const wrongLatest = await publicDeliveryFailure(latest); expect(wrongLatest.check).toBe('catalog.latest.tag'); expect(wrongLatest.httpStatus).toBeUndefined();
  const redirect = publicDeliveryFixture(); redirect.responses.get(redirect.publicUrl)!.url = 'https://private.invalid/private-redirect-sentinel';
  expect((await publicDeliveryFailure(redirect)).check).toBe('installer.public.redirect');
  const bytes = publicDeliveryFixture(); bytes.responses.get(bytes.publicUrl)!.body = 'private-installer-body-sentinel';
  const wrongBytes = await publicDeliveryFailure(bytes); expect(wrongBytes.check).toBe('installer.public.bytes'); expect(wrongBytes.httpStatus).toBeUndefined();
  for (const record of [wrongLatest, wrongBytes]) expect(JSON.stringify(record)).not.toContain('sentinel');
});

test('HTTP status is scoped to its actual request and only valid integer statuses can enter a receipt', async () => {
  for (const member of ['goodvibes', 'goodvibes-daemon', 'goodvibes-agent']) {
    const fixture = publicDeliveryFixture();
    fixture.responses.set(`${fixture.download}${member}-macos-arm64.reader-ci-artifact.json`, { status: 503, body: 'private-reader-body-sentinel' });
    const record = await publicDeliveryFailure(fixture);
    expect(record.check).toBe(`catalog.reader.${member}.http`); expect(record.httpStatus).toBe(503);
  }
  for (const [key, check] of [['latestUrl', 'catalog.latest.http'], ['immutableUrl', 'installer.immutable.http'], ['publicUrl', 'installer.public.http']] as const) {
    const fixture = publicDeliveryFixture(); fixture.responses.set(fixture[key], { status: 403, body: 'private-http-body-sentinel' });
    const record = await publicDeliveryFailure(fixture); expect(record.check).toBe(check); expect(record.httpStatus).toBe(403);
  }
  for (const status of [0, 99, 600, NaN, Infinity, 200.5, 'private-http-status-sentinel'])
    expect(acceptanceFailureRecord({ stage: 'published-catalog', httpStatus: status as number }, new Error('private-error-sentinel')).httpStatus).toBeUndefined();
  const fixture = publicDeliveryFixture(); await fixture.deliver();
  expect(fixture.evidence.check).toBe('installer.public.bytes'); expect(fixture.evidence.httpStatus).toBeUndefined();
});
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
test('an unpublished native lifecycle proof runs before opt-out and retains owned cleanup when it fails', async () => {
  const events: string[] = [], host = steps(events), original = new Error('Replacement native runtime did not become healthy');
  host.verifyNativeLifecycle = async () => { events.push('update-rollback'); throw original; };
  await expect(runAcceptanceSteps(host)).rejects.toBe(original);
  expect(events).toEqual(['admit', 'install', 'installed', 'defaults', 'update-rollback', 'uninstall', 'preserved']);
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

test('native failure receipts retain the original whitelisted startup guard before a later successful probe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-first-startup-')); roots.push(root);
  const invoke = nativeDaemonChild(root), secret = 'first-native-startup-private-091c';
  const result = await invoke(`[goodvibes-daemon:native-startup-failure] sqlite SQLITE_ADMISSION_CHANGED\nprivate cause ${secret}\n`, '', 1, true, ['--version']);
  expect(result.code).toBe(1); expect(result.nativeDaemonFailure).toBe('native-startup-repair');
  expect(result.nativeStartupFailure).toEqual({ stage: 'sqlite', code: 'SQLITE_ADMISSION_CHANGED' });
  const record = acceptanceFailureRecord({ stage: 'verifyInstalled', check: 'installed.goodvibes-daemon.version',
    exitCode: result.code, nativeDaemonFailure: result.nativeDaemonFailure, nativeStartupFailure: result.nativeStartupFailure }, new Error(secret));
  expect(record.nativeStartupFailure).toEqual({ stage: 'sqlite', code: 'SQLITE_ADMISSION_CHANGED' });
  expect(JSON.stringify(record)).not.toContain(secret);
  const success = await invoke('', 'goodvibes-daemon 3.1.2\n', 0, true, ['--version']);
  expect(success).not.toHaveProperty('nativeStartupFailure');
  expect(record.nativeStartupFailure).toEqual({ stage: 'sqlite', code: 'SQLITE_ADMISSION_CHANGED' });
  const injected = await invoke(JSON.stringify({ ok: false, error: secret,
    cause: '[goodvibes-daemon:native-startup-failure] sqlite SQLITE_ADMISSION_CHANGED' }));
  expect(injected).not.toHaveProperty('nativeStartupFailure');
  const unknown = await invoke(`[goodvibes-daemon:native-startup-failure] sqlite ${secret}\n`, '', 1, true, ['--version']);
  expect(unknown).not.toHaveProperty('nativeStartupFailure');
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

test('native service retirement waits through actual print exits zero zero then113 and retains only first and final safe observations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'published-acceptance-service-retirement-')); roots.push(root);
  const command = join(root, 'launchctl'), counter = join(root, 'count'), secret = 'acceptance-private-launchctl-state-401c';
  writeFileSync(counter, '0');
  writeFileSync(command, `#!/bin/sh
n=$(cat "$COUNTER"); n=$((n+1)); printf '%s' "$n" > "$COUNTER"
case "$n" in
  1) printf 'state = running\\npid = 41\\nruns = 2\\nlast exit code = 0\\nAuthorization: %s\\n' "$PRIVATE_STATE"; exit 0 ;;
  2) printf 'state = spawn scheduled\\nruns = 3\\n'; exit 0 ;;
  *) exit 113 ;;
esac
`, { mode: 0o700 });
  const observations: NativeServiceRetirementObservation[] = [];
  await waitForNativeServiceRetirement(() => runOwnedCommand(command, ['print', 'owned-label'], {
    env: { ...process.env, COUNTER: counter, PRIVATE_STATE: secret },
  }), { intervalMs: 1, onObservation: record => { observations.push(record); } });
  expect(readFileSync(counter, 'utf8')).toBe('3'); expect(observations).toHaveLength(2);
  expect(observations[0]).toEqual({ exitCode: 0, signal: null, state: 'running', pid: 41, runs: 2, lastExitCode: 0 });
  expect(observations[1]).toEqual({ exitCode: 113, signal: null, state: 'other' });
  expect(JSON.stringify(observations)).not.toContain(secret); expect(JSON.stringify(observations)).not.toContain('Authorization');
});

test('native service retirement cancellation interrupts its retry without replacing the original reason or probing again', async () => {
  const controller = new AbortController(), entered = Promise.withResolvers<void>(), reason = new Error('Original retirement owner stopped');
  let probes = 0;
  const running = waitForNativeServiceRetirement(async () => {
    probes++; return { code: 0, stdout: 'state = not running\nruns = 4\nlast exit code = -15\n' };
  }, { signal: controller.signal, onObservation: () => { entered.resolve(); } });
  try {
    await entered.promise; await new Promise<void>(done => setImmediate(done)); controller.abort(reason);
    await expect(running).rejects.toBe(reason); expect(probes).toBe(1);
  } finally { controller.abort(reason); await Promise.allSettled([running]); }
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

test('release publication is last while explicitly requested public acceptance retains its native matrix', () => {
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected workflow mapping.');
    return value as Record<string, unknown>;
  };
  const workflow = (name: string) => object(Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', name), 'utf8')));
  const release = object(workflow('release.yml').jobs), suite = object(workflow('suite-release-assets.yml').jobs);
  const reusable = './.github/workflows/reusable-published-install-acceptance.yml';
  const staged = object(release['staged-install-acceptance']), publisher = object(release['github-release']);
  const existing = object(suite['published-install-acceptance']);
  expect(staged.uses).toBe('./.github/workflows/reusable-staged-install-acceptance.yml');
  expect(existing.uses).toBe(reusable); expect(existing.needs).toBe('collect');
  expect(release['published-install-acceptance']).toBeUndefined();
  expect(publisher.needs).toContain('staged-install-acceptance');
  expect(String(publisher.if)).toContain("needs.staged-install-acceptance.result == 'success'");
  for (const job of Object.values(release).map(object)) {
    expect(Array.isArray(job.needs) ? job.needs : [job.needs]).not.toContain('github-release');
  }
  expect(existing.if).toBe("inputs.publish_existing && inputs.candidate-source == '' && needs.collect.result == 'success'");
  expect(object(existing.with).source).toBe('${{ needs.collect.outputs.source }}');
  expect(object(object(suite.collect).outputs).source).toBe('${{ steps.admit.outputs.source }}');
  for (const caller of [staged, existing]) expect(object(caller.with)['tooling-sha']).toBe('${{ github.sha }}');
  const definition = workflow('reusable-published-install-acceptance.yml');
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    const inputs = object(object(object(definition.on)[trigger]).inputs);
    expect(Object.keys(inputs).sort()).toEqual(['previous-source', 'previous-tag', 'source', 'tag', 'tooling-sha']);
    for (const name of ['source', 'tag', 'tooling-sha']) {
      const input = object(inputs[name]);
      expect(input).toMatchObject({ required: true, type: 'string' });
      expect(input.default).toBeUndefined();
    }
    for (const name of ['previous-source', 'previous-tag']) expect(object(inputs[name])).toMatchObject({ required: false, type: 'string', default: '' });
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
    GOODVIBES_ACCEPTANCE_METADATA_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
    RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}',
  });
  expect(install?.run)
    .toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET"');
});



function historicalSteps(events: string[]): HistoricalUpgradeSteps {
  const record = (name: string) => async () => { events.push(name); };
  return { admit: record('admit'), installPrevious: record('install-old-service-off'), verifyPrevious: record('original-old-versions-defaults'),
    seedPreviousData: record('original-data'), startPreviousService: record('start-old-service'), awaitAutomaticUpgrade: record('actual-auto-transition'),
    verifyUpgradedData: record('upgraded-data'), verifyRollbackRefusal: record('real-api-refusal'), uninstall: record('cleanup'), verifyPreserved: record('preserved') };
}

function installerMigrationSteps(events: string[]): InstallerMigrationSteps {
  const record = (name: string) => async () => { events.push(name); };
  return { admit: record('admit'), installPrevious: record('install-old-service-off'), verifyPrevious: record('original-old-versions-defaults'),
    seedPreviousData: record('original-data-settings'), disablePreviousUpdates: record('old-updater-opt-out'),
    startPreviousService: record('start-old-service'), verifyPreviousService: record('old-service-status-webui'),
    installCurrent: record('current-public-installer'), verifyCurrent: record('current-public-cohort-service-webui'),
    verifyMigratedData: record('saved-data-settings-opt-out'), restartAndVerifyMigrated: record('restart-cohort-data-settings-opt-out'),
    uninstall: record('cleanup'), verifyPreserved: record('preserved') };
}

test('public installer migration first proves the opted-out old service and then the current cohort without claiming automatic upgrade or rollback', async () => {
  const events: string[] = [], host = installerMigrationSteps(events), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const proof = host.verifyPreviousService;
  host.verifyPreviousService = async () => { entered.resolve(); await release.promise; await proof(); };
  Object.assign(host, { awaitAutomaticUpgrade: async () => { throw new Error('Migration must not wait for an automatic transition'); },
    verifyRollbackRefusal: async () => { throw new Error('Migration must not invoke rollback'); } });
  const running = runInstallerMigrationSteps(host);
  try {
    await entered.promise;
    expect(events).toEqual(['admit', 'install-old-service-off', 'original-old-versions-defaults', 'original-data-settings', 'old-updater-opt-out', 'start-old-service']);
    release.resolve(); await running;
    expect(events.slice(6)).toEqual(['old-service-status-webui', 'current-public-installer', 'current-public-cohort-service-webui',
      'saved-data-settings-opt-out', 'restart-cohort-data-settings-opt-out', 'cleanup', 'preserved']);
  } finally { release.resolve(); await Promise.allSettled([running]); }
});

test('a failed old-service proof cannot invoke the current installer but still retires original ownership', async () => {
  const events: string[] = [], host = installerMigrationSteps(events), original = new Error('Old service did not answer');
  host.verifyPreviousService = async () => { throw original; };
  await expect(runInstallerMigrationSteps(host)).rejects.toBe(original);
  expect(events).not.toContain('current-public-installer'); expect(events.slice(-2)).toEqual(['cleanup', 'preserved']);
});

test('failed public installer migration waits for cleanup and retains both original and cleanup errors', async () => {
  const events: string[] = [], host = installerMigrationSteps(events), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const original = new Error('Public installer refused old cohort'), cleanup = new Error('Original service did not drain');
  host.installCurrent = async () => { events.push('public-installer-failed'); throw original; };
  host.uninstall = async () => { entered.resolve(); await release.promise; events.push('cleanup-failed'); throw cleanup; };
  const running = runInstallerMigrationSteps(host); let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise; expect(settled).toBe(false); release.resolve();
    await expect(running).rejects.toMatchObject({ name: 'AggregateError', errors: [original, cleanup] });
    expect(events).not.toContain('current-public-cohort-service-webui'); expect(events.at(-1)).toBe('cleanup-failed');
  } finally { release.resolve(); await Promise.allSettled([running]); }
});

test('installer migration refuses foreign admission before any old install or cleanup', async () => {
  const events: string[] = [], host = installerMigrationSteps(events), original = new Error('Existing installation belongs to another owner');
  host.admit = async () => { throw original; };
  await expect(runInstallerMigrationSteps(host)).rejects.toBe(original); expect(events).toEqual([]);
});

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
