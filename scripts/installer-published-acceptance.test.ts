/** Owned tooling regressions; they do not claim published native/service proof. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertHostedContext, readPublishedReaders, runAcceptanceSteps, runOwnedCommand, runHistoricalUpgradeSteps, assertHistoricalRollbackRefusal, type HistoricalUpgradeSteps, type AcceptanceSteps } from './accept-published-suite.mjs';

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
  expect(fresh.if).toBe("needs.github-release.result == 'success'");
  expect(existing.if).toBe("inputs.publish_existing && needs.collect.result == 'success'");
  expect(object(existing.with).source).toBe('${{ needs.collect.outputs.source }}');
  expect(object(object(suite.collect).outputs).source).toBe('${{ steps.admit.outputs.source }}');
  for (const caller of [fresh, existing]) expect(object(caller.with)['tooling-sha']).toBe('${{ github.sha }}');
  const definition = workflow('reusable-published-install-acceptance.yml');
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
  expect(steps.map(object).find(step => step.name === 'Download, install, serve and uninstall the published suite')?.run)
    .toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET"');
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
    jobs: Record<string, { if: string; strategy: { matrix: { include: Array<{ target: string; runner: string }> } }; steps: Array<{ name?: string; run?: string; uses?: string; with?: Record<string, unknown> }> }>;
  };
  const job = value.jobs['historical-linux-upgrade']!;
  expect(job.if).toBe("inputs.tag == 'v3.1.2'");
  expect(job.strategy.matrix.include).toEqual([{ target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' }]);
  expect(job.steps.find(step => String(step.uses).startsWith('actions/checkout@'))?.with).toEqual({ ref: '${{ inputs.source }}' });
  expect(job.steps.find(step => step.name === 'Verify the original released payload source')?.run).toBe('test "$(git rev-parse HEAD)" = "$PAYLOAD_SOURCE"');
  expect(job.steps.find(step => step.name === 'Build only the source-bound rollback verifier')?.run)
    .toBe('bun install --frozen-lockfile\nbun packages/engine/scripts/build.ts\n');
  expect(job.steps.find(step => step.name === 'Observe actual old unattended upgrade and unsupported rollback refusal')?.run)
    .toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET" upgrade-v3.1.1');
});
