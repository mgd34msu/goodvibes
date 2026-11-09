/** Owned tooling regressions; they do not claim published native/service proof. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertHostedContext, readPublishedReaders, runAcceptanceSteps, runOwnedCommand, type AcceptanceSteps } from './accept-published-suite.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function steps(events: string[]): AcceptanceSteps {
  const record = (name: string) => async () => { events.push(name); };
  return { admit: record('admit'), install: record('install'), verifyInstalled: record('installed'),
    verifyDefaults: record('defaults'), disableUpdates: record('off'), restartAndVerifyOptOut: record('restart-off'),
    verifyOptOut: record('read-off'), uninstall: record('uninstall'), verifyPreserved: record('preserved') };
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
