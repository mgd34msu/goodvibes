/** Execute the release workflow's staging and expected-checksum consumer ports.
 * Native service behavior belongs to the six original hosted runner accounts.
 */
import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readPublishedReaders } from './accept-published-suite.mjs';

const repo = resolve(import.meta.dir, '..');
type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string>; 'working-directory'?: string };
type Job = { needs?: string[]; if?: string; 'runs-on'?: string; permissions?: Record<string, string>; steps: Step[]; strategy?: { 'fail-fast'?: boolean; matrix: { include: Array<{ target: string; runner: string }> } } };
type Workflow = { on: Record<string, { inputs: Record<string, { required: boolean; type: string; default?: unknown }> }>; jobs: Record<string, Job>; permissions: Record<string, string> };
const load = (name: string) => Bun.YAML.parse(readFileSync(join(repo, '.github/workflows', name), 'utf8')) as Workflow;
const staged = load('reusable-staged-install-acceptance.yml');
const release = load('reusable-gh-release.yml');
const stage = staged.jobs['stage-release-assets']!.steps.find(step => step.name === 'Stage the single consumer checksum manifest')!;
const payloads = release.jobs['gh-release']!.steps.find(step => step.id === 'payloads')!;
const checksums = release.jobs['gh-release']!.steps.find(step => step.id === 'checksums')!;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(names = Array.from({ length: 7 }, (_, i) => `asset-${String(i).padStart(2, '0')}`)) {
  const root = mkdtempSync(join(tmpdir(), 'staged-workflow-')); roots.push(root);
  mkdirSync(join(root, 'dist'));
  symlinkSync(join(repo, 'packages'), join(root, 'packages'), 'dir');
  for (const name of names) writeFileSync(join(root, 'dist', name), `original ${name}\n`);
  return { root, names, manifest: join(root, 'dist/SHA256SUMS.txt') };
}
function run(step: Step, root: string, env: Record<string, string> = {}) {
  const output = join(root, 'output'); writeFileSync(output, '');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run!], {
    cwd: root, env: { ...process.env, GITHUB_OUTPUT: output, ...env }, encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  return { ...result, outputs: readFileSync(output, 'utf8') };
}
function existingEnv(names: string[]) {
  return { PAYLOAD_PATHS: names.map(name => `dist/${name}`).join('\n'), TOOLCHAIN_SOURCE: 'workspace',
    TOOLCHAIN_SPEC: '@goodvibes-jev/engine', SHA256_NAME: 'SHA256SUMS.txt', USE_EXISTING_CHECKSUMS: 'true' };
}

test('manual and reusable staged acceptance require immutable source/tooling and an explicit producer run', () => {
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    expect(Object.keys(staged.on[trigger]!.inputs).sort()).toEqual(['artifact-run-id', 'previous-source', 'previous-tag', 'source', 'tag', 'tooling-sha']);
    for (const key of ['artifact-run-id', 'source', 'tag', 'tooling-sha']) expect(staged.on[trigger]!.inputs[key]).toMatchObject({ required: true, type: 'string' });
    for (const key of ['previous-tag', 'previous-source']) expect(staged.on[trigger]!.inputs[key]).toMatchObject({ required: false, type: 'string', default: '' });
  }
  expect(staged.permissions).toEqual({ contents: 'read', actions: 'read' });
  const producer = staged.jobs['stage-release-assets']!;
  const download = producer.steps.find(step => String(step.uses).startsWith('actions/download-artifact@'))!;
  expect(download.with).toMatchObject({ name: 'native-release-assets', 'run-id': '${{ inputs.artifact-run-id }}', 'github-token': '${{ secrets.GITHUB_TOKEN }}' });
  expect(producer.steps.filter(step => step.run).map(step => step.run).join('\n')).not.toContain('GITHUB_TOKEN');
  const upload = producer.steps.find(step => String(step.uses).startsWith('actions/upload-artifact@'))!;
  expect(upload.with).toMatchObject({ name: 'staged-release-assets', 'if-no-files-found': 'error' });
});

test('reusable acceptance supplies read-only metadata credentials only to its observing parent steps', () => {
  for (const name of ['reusable-staged-install-acceptance.yml', 'reusable-published-install-acceptance.yml']) {
    const workflow = load(name);
    expect(workflow.permissions.contents).toBe('read');
    const observing = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => /^node scripts\/accept-(?:published|staged)-suite\.mjs /.test(step.run ?? ''));
    expect(observing).toHaveLength(3);
    const scoped = observing.filter(step => !(name === 'reusable-published-install-acceptance.yml' && step.run?.endsWith(' upgrade-v3.1.1')));
    for (const step of scoped) {
      expect(step.env?.GOODVIBES_ACCEPTANCE_METADATA_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
      expect(step.env?.GITHUB_TOKEN).toBeUndefined();
    }
    if (name === 'reusable-published-install-acceptance.yml') {
      const legacy = observing.find(step => step.run?.endsWith(' upgrade-v3.1.1'))!;
      expect(legacy.env?.GOODVIBES_ACCEPTANCE_METADATA_TOKEN).toBeUndefined();
      expect(legacy.env?.GITHUB_TOKEN).toBeUndefined();
    }
    const owners = Object.values(workflow.jobs).flatMap(job => job.steps).filter(step => step.env?.GOODVIBES_ACCEPTANCE_METADATA_TOKEN !== undefined);
    expect(owners).toEqual(scoped);
    expect(readFileSync(join(repo, '.github/workflows', name), 'utf8').match(/GOODVIBES_ACCEPTANCE_METADATA_TOKEN/g)).toHaveLength(scoped.length);
  }
});

test('manual macOS diagnostics reuse the existing staged artifact without staging or qualifying publication', () => {
  const diagnostic = load('diagnose-staged-macos.yml');
  expect(Object.keys(diagnostic.on)).toEqual(['workflow_dispatch']);
  expect(Object.keys(diagnostic.on.workflow_dispatch!.inputs).sort()).toEqual(['artifact-run-id', 'compare-authenticated', 'mode', 'source', 'tag', 'tooling-sha']);
  expect(diagnostic.on.workflow_dispatch!.inputs['tooling-sha']).toMatchObject({ required: true, type: 'string' });
  for (const name of ['tag', 'source', 'artifact-run-id']) expect(diagnostic.on.workflow_dispatch!.inputs[name]).toMatchObject({ required: false, type: 'string' });
  expect(diagnostic.on.workflow_dispatch!.inputs.mode).toMatchObject({ required: false, type: 'choice', default: 'native' });
  expect(diagnostic.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(Object.keys(diagnostic.jobs)).toEqual(['release-metadata-diagnostics', 'macos-diagnostics']);
  const job = diagnostic.jobs['macos-diagnostics']!;
  expect(job.if).toBe("inputs.mode != 'release-metadata'");
  expect(job.strategy?.matrix.include).toEqual([{ target: 'darwin-x64', runner: 'macos-15-intel' }, { target: 'darwin-arm64', runner: 'macos-15' }]);
  expect(job.strategy?.['fail-fast']).toBe(false);
  expect(job.steps[0]?.with).toEqual({ ref: '${{ inputs.tooling-sha }}', 'fetch-depth': 0 });
  const download = job.steps.find(step => String(step.uses).startsWith('actions/download-artifact@'))!;
  expect(download.with).toEqual({ name: 'staged-release-assets', path: '${{ runner.temp }}/staged-release-assets',
    'run-id': '${{ inputs.artifact-run-id }}', 'github-token': '${{ secrets.GITHUB_TOKEN }}' });
  const invoke = job.steps.find(step => step.run?.startsWith('node scripts/accept-staged-suite.mjs'))!;
  expect(invoke.run).toBe('node scripts/accept-staged-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET" "$RUNNER_TEMP/staged-release-assets"');
  expect(invoke.env).toEqual({ RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}', GOODVIBES_ACCEPTANCE_DIAGNOSTICS: '1' });
  const result = job.steps.find(step => step.name === 'Preserve bounded macOS diagnostic result')!;
  expect(result.with?.name).toBe('diagnostic-staged-macos-${{ matrix.target }}');
  expect(result.with?.path).toEndWith('/acceptance-result.json');
  const recorded = job.steps.findIndex(step => step.name === 'Record fresh native diagnostic window');
  expect(recorded).toBeGreaterThan(job.steps.indexOf(download)); expect(recorded).toBeLessThan(job.steps.indexOf(invoke));
  const crash = job.steps.find(step => step.name === 'Collect bounded safe native crash evidence')!;
  expect(crash.if).toBe("failure() && steps.native-diagnostic.outcome == 'failure'");
  expect(crash.run).toBe('node scripts/collect-macos-native-crash.mjs "$RUNNER_TEMP/goodvibes-macos-diagnostic-start.json" "$RUNNER_TEMP/goodvibes-macos-crash-summary.json"');
  const native = job.steps.find(step => step.name === 'Preserve safe native crash and foreground evidence')!;
  expect(native.if).toBe("always() && steps.native-diagnostic.outcome == 'failure'");
  expect(native.with?.name).toBe('diagnostic-staged-macos-native-${{ matrix.target }}');
  expect(native.with?.path).toBe('${{ runner.temp }}/goodvibes-macos-crash-summary.json\n${{ runner.temp }}/goodvibes-published-*/native-diagnostics.json\n');
  expect(job.steps.filter(step => step.run).map(step => step.run).join('\n')).not.toMatch(/sha256sums|--out|\bbun\b|\bbuild\b|gh release|git tag|npm publish/);
});

test('metadata-only macOS diagnostics make fixed HTTP observations without binary or lifecycle work', () => {
  const workflow = load('diagnose-staged-macos.yml');
  const job = workflow.jobs['release-metadata-diagnostics']!;
  expect(job.if).toBe("inputs.mode == 'release-metadata'");
  expect(job['runs-on']).toBe('macos-15');
  expect(job.strategy).toBeUndefined();
  const invoke = job.steps.find(step => step.name === 'Observe fixed public release metadata response')!;
  expect(invoke.run).toBe('node scripts/diagnose-github-release-http.mjs "$RUNNER_TEMP/github-release-http-diagnostics.json"');
  expect(invoke.env).toEqual({ GITHUB_TOKEN: "${{ inputs.compare-authenticated && secrets.GITHUB_TOKEN || '' }}" });
  expect(job.steps.some(step => String(step.uses).startsWith('actions/download-artifact@'))).toBe(false);
  expect(job.steps.map(step => step.run ?? '').join('\n')).not.toMatch(/accept-staged|accept-published|install\.sh|launchctl|\bbun\b|\bbuild\b|gh release|git tag/);
  const upload = job.steps.find(step => String(step.uses).startsWith('actions/upload-artifact@'))!;
  expect(upload.if).toBe('always()');
  expect(upload.with).toMatchObject({ path: '${{ runner.temp }}/github-release-http-diagnostics.json', 'if-no-files-found': 'error' });
});

test('the actual macOS diagnostic guard refuses mutable inputs and invalid version or run identifiers', () => {
  const guard = load('diagnose-staged-macos.yml').jobs['macos-diagnostics']!.steps.find(step => step.name === 'Verify immutable diagnostic inputs')!;
  const root = mkdtempSync(join(tmpdir(), 'macos-diagnostic-inputs-')); roots.push(root);
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/accept-staged-suite.mjs'), '');
  writeFileSync(join(root, 'bin/git'), '#!/bin/sh\ncase "$1" in rev-parse) printf "%s\\n" "$TOOLING_SHA" ;; cat-file) [ "$3" = "$SOURCE_SHA^{commit}" ] ;; *) exit 91 ;; esac\n', { mode: 0o755 });
  const valid = { TOOLING_SHA: 'a'.repeat(40), SOURCE_SHA: 'b'.repeat(40), RELEASE_TAG: 'v3.1.2', ARTIFACT_RUN_ID: '42941236483', PATH: join(root, 'bin') + ':' + process.env.PATH };
  expect(run(guard, root, valid).status).toBe(0);
  for (const invalid of [{ TOOLING_SHA: 'main' }, { SOURCE_SHA: 'refs/heads/main' }, { SOURCE_SHA: '' }, { RELEASE_TAG: '../v3.1.2' }, { ARTIFACT_RUN_ID: '' }, { ARTIFACT_RUN_ID: '42941236483;exit 0' }]) {
    expect(run(guard, root, { ...valid, ...invalid }).status, JSON.stringify(invalid)).not.toBe(0);
  }
});

test('four fresh and two historical runners consume the same staged artifact with current tooling', () => {
  const fresh = staged.jobs['native-install']!, historical = staged.jobs['historical-linux-upgrade']!;
  expect(fresh.strategy?.matrix.include).toEqual([
    { target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' },
    { target: 'darwin-x64', runner: 'macos-15-intel' }, { target: 'darwin-arm64', runner: 'macos-15' },
  ]);
  expect(historical.strategy?.matrix.include).toEqual(fresh.strategy?.matrix.include.slice(0, 2));
  expect(historical.if).toBe("inputs.tag == 'v3.1.2'");
  for (const job of [fresh, historical]) {
    expect(job.needs).toEqual(['stage-release-assets']); expect(job.strategy?.['fail-fast']).toBe(false);
    expect(job.steps[0]?.with).toEqual({ ref: '${{ inputs.tooling-sha }}', 'fetch-depth': 0 });
    const download = job.steps.find(step => String(step.uses).startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({ name: 'staged-release-assets', path: '${{ runner.temp }}/staged-release-assets' });
    const invoke = job.steps.find(step => step.run?.startsWith('node scripts/accept-staged-suite.mjs'))!;
    expect(job.steps.indexOf(download)).toBeLessThan(job.steps.indexOf(invoke));
    expect(invoke.run).toContain('"$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET" "$RUNNER_TEMP/staged-release-assets"');
  }
  expect(historical.steps[1]?.with).toEqual({ ref: '${{ inputs.source }}', path: 'candidate-source' });
  const build = historical.steps.find(step => step.name === 'Build only the source-bound rollback verifier')!;
  expect(build['working-directory']).toBe('candidate-source');
  expect(build.run).toBe('bun install --frozen-lockfile\nbun packages/engine/scripts/build.ts\n');
  const invoke = historical.steps.find(step => step.run?.startsWith('node scripts/accept-staged-suite.mjs'))!;
  expect(invoke.run).toEndWith(' upgrade-v3.1.1');
  expect(invoke.env?.CANDIDATE_SOURCE_ROOT).toBe('${{ github.workspace }}/candidate-source');
});

test('the actual staging body writes the exact payload manifest and refuses an already staged input', () => {
  const f = fixture();
  expect(stage.run).not.toContain('--verify');
  const first = run(stage, f.root, { ASSETS_DIRECTORY: join(f.root, 'dist') });
  expect(first.status, first.stderr).toBe(0);
  expect(readdirSync(join(f.root, 'dist'))).toHaveLength(f.names.length + 1);
  expect(readFileSync(f.manifest, 'utf8').trimEnd().split('\n')).toHaveLength(f.names.length);
  const verified = run(checksums, f.root, existingEnv(f.names));
  expect(verified.status, verified.stderr).toBe(0);
  const second = run(stage, f.root, { ASSETS_DIRECTORY: join(f.root, 'dist') });
  expect(second.status).not.toBe(0);
  expect(second.stderr).toContain('Invalid native release member');
});

test('staging and checksum consumption accept complete manifests independent of payload count', () => {
  for (const count of [1, 65]) {
    const f = fixture(Array.from({ length: count }, (_, index) => `payload-${index}`));
    const generated = run(stage, f.root, { ASSETS_DIRECTORY: join(f.root, 'dist') });
    expect(generated.status, generated.stderr).toBe(0);
    expect(readFileSync(f.manifest, 'utf8').trimEnd().split('\n')).toHaveLength(count);
    const consumed = run(checksums, f.root, existingEnv(f.names));
    expect(consumed.status, consumed.stderr).toBe(0);
  }
});

test('staging refuses empty, nonregular, nested and unsafe payload entries', () => {
  for (const kind of ['empty', 'symlink', 'directory', 'unsafe-name'] as const) {
    const f = fixture([]), directory = join(f.root, 'dist');
    if (kind === 'symlink') {
      writeFileSync(join(f.root, 'outside'), 'not a release member');
      symlinkSync(join(f.root, 'outside'), join(directory, 'alias'));
    } else if (kind === 'directory') mkdirSync(join(directory, 'nested'));
    else if (kind === 'unsafe-name') writeFileSync(join(directory, 'unsafe name'), 'invalid');
    const refused = run(stage, f.root, { ASSETS_DIRECTORY: directory });
    expect(refused.status, kind).not.toBe(0);
    expect(refused.stderr).toContain(kind === 'empty' ? 'must contain payloads' : 'Invalid native release member');
    expect(existsSync(f.manifest)).toBe(false);
  }
});

test('native reader admission still refuses a required product omitted from a staged manifest', async () => {
  const target = 'linux-x64', source = 'a'.repeat(40);
  const products = ['goodvibes', 'goodvibes-agent', 'goodvibes-daemon'];
  const names = products.flatMap(product => [`${product}-${target}`, `${product}-${target}.reader-ci-artifact.json`]);
  const missing = `goodvibes-agent-${target}.reader-ci-artifact.json`;
  const f = fixture(names.filter(name => name !== missing));
  const generated = run(stage, f.root, { ASSETS_DIRECTORY: join(f.root, 'dist') });
  expect(generated.status, generated.stderr).toBe(0);
  const loaded: string[] = [];
  await expect(readPublishedReaders({ target, source, tag: 'v3.1.5', assets: new Set(f.names) }, async name => {
    loaded.push(name);
    return { target, sourceCommit: source, headCommit: source, version: '3.1.5',
      files: [{ path: name.replace(/\.reader-ci-artifact\.json$/, '') }] };
  })).rejects.toThrow('cohort is missing');
  expect(loaded).not.toContain(missing);
  expect(loaded).toContain(`goodvibes-${target}.reader-ci-artifact.json`);
});

test('the actual payload selection excludes the manifest and deduplicates overlapping globs', () => {
  const f = fixture(); writeFileSync(f.manifest, 'original staged manifest');
  const result = run(payloads, f.root, { NORMALIZED_GLOBS: 'dist/*\ndist/asset-00', SHA256_NAME: 'SHA256SUMS.txt' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.outputs.split('\n').filter(line => line.startsWith('dist/'))).toEqual(f.names.map(name => `dist/${name}`));
  expect(result.outputs).not.toContain('dist/SHA256SUMS.txt');
  const upload = release.jobs['gh-release']!.steps.find(step => String(step.uses).startsWith('softprops/action-gh-release@'))!;
  expect(upload.with?.files).toBe('${{ steps.payloads.outputs.paths }}\n${{ steps.checksums.outputs.path }}\n');
});

test('publication consumes the original checksum pins and refuses changed bytes or incomplete and ambiguous manifests', () => {
  const f = fixture(), generated = run(stage, f.root, { ASSETS_DIRECTORY: join(f.root, 'dist') });
  expect(generated.status, generated.stderr).toBe(0);
  const original = readFileSync(f.manifest, 'utf8'), env = existingEnv(f.names);
  const valid = run(checksums, f.root, env);
  expect(valid.status, valid.stderr).toBe(0); expect(valid.outputs).toBe('path=dist/SHA256SUMS.txt\n');
  expect(readFileSync(f.manifest, 'utf8')).toBe(original);
  for (const names of [f.names.slice(1), [...f.names, f.names[0]!]]) {
    const refused = run(checksums, f.root, existingEnv(names));
    expect(refused.status).not.toBe(0); expect(refused.outputs).toBe('');
    expect(readFileSync(f.manifest, 'utf8')).toBe(original);
  }
  const wrongSource = run(checksums, f.root, { ...env, TOOLCHAIN_SOURCE: 'registry' });
  expect(wrongSource.status).not.toBe(0); expect(wrongSource.stderr).toContain('requires the workspace toolchain');
  expect(wrongSource.outputs).toBe('');
  writeFileSync(join(f.root, 'dist', f.names[0]!), 'changed after acceptance');
  const changed = run(checksums, f.root, env);
  expect(changed.status).not.toBe(0); expect(changed.stderr).toContain('mismatched');
  expect(readFileSync(f.manifest, 'utf8')).toBe(original);
  writeFileSync(join(f.root, 'dist', f.names[0]!), `original ${f.names[0]}\n`);
  const rows = original.trimEnd().split('\n');
  for (const malformed of [rows.slice(1).join('\n') + '\n', original + rows[0] + '\n', original + 'a'.repeat(64) + '  SHA256SUMS.txt\n', original.replace(f.names[0]!, 'unknown-payload')]) {
    writeFileSync(f.manifest, malformed);
    const refused = run(checksums, f.root, env);
    expect(refused.status, malformed).not.toBe(0); expect(refused.outputs).toBe('');
    expect(readFileSync(f.manifest, 'utf8')).toBe(malformed);
  }
  rmSync(f.manifest);
  expect(run(checksums, f.root, env).status).not.toBe(0);
});

test('other callers retain default checksum generation through the existing source CLI', () => {
  expect(release.on.workflow_call!.inputs['use-existing-checksums']).toMatchObject({ type: 'boolean', required: false, default: false });
  const f = fixture();
  const result = run(checksums, f.root, { ...existingEnv(f.names), USE_EXISTING_CHECKSUMS: 'false' });
  expect(result.status, result.stderr).toBe(0); expect(result.outputs).toBe('path=SHA256SUMS.txt\n');
  expect(readFileSync(join(f.root, 'SHA256SUMS.txt'), 'utf8').trimEnd().split('\n')).toHaveLength(f.names.length);
  writeFileSync(f.manifest, readFileSync(join(f.root, 'SHA256SUMS.txt')));
  const verified = run(checksums, f.root, existingEnv(f.names));
  expect(verified.status, verified.stderr).toBe(0);
});


test.each(['nonzero', 'cancel'] as const)('retained suite packaging handles %s before staging cleanup and never emits source metadata', async scenario => {
  const root = mkdtempSync(join(tmpdir(), 'retained-suite-build-')); roots.push(root);
  const source = join(root, 'source'), retained = join(root, 'retained'), bin = join(root, 'bin'), destination = join(root, 'assets');
  for (const directory of [source, retained, bin]) mkdirSync(directory);
  symlinkSync(join(repo, 'packages'), join(source, 'packages'), 'dir');
  writeFileSync(join(source, 'package.json'), '{"version":"3.1.2"}');
  cpSync(join(repo, '.github/scripts/package-suite-release.mjs'), join(retained, 'package-suite-release.mjs'));
  cpSync(join(repo, 'products/daemon/scripts/native-execution-process.mjs'), join(retained, 'native-execution-process.mjs'));
  // Only dependency acquisition is a fixture port. The coordinator, owned
  // build runner, source modules and release stage are their actual code.
  writeFileSync(join(retained, 'build-native-ci.ts'), 'export async function probeInstalledNativeBuildAssets() {}\nexport async function prepareNativeBuildAssets({install}) { await install(); }\n');
  writeFileSync(join(bin, 'git'), '#!/bin/sh\ncase "$1" in rev-parse) printf "%s\\n" aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;; diff) exit 0 ;; *) exit 91 ;; esac\n', { mode: 0o755 });
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nexec "$BUILD_RUNTIME" "$BUILD_FIXTURE"\n', { mode: 0o755 });
  const marker = join(root, 'compiler-started'), compiler = join(root, 'compiler.mjs');
  writeFileSync(compiler, 'import {writeFileSync} from "node:fs"; process.on("SIGTERM",()=>{}); writeFileSync(process.env.BUILD_MARKER,String(process.pid)); ' + (scenario === 'cancel' ? 'setInterval(()=>{},1000);' : 'process.exit(23);'));
  const child = spawn(process.execPath, [join(retained, 'package-suite-release.mjs'), `${process.platform}-${process.arch}`, destination, 'v3.1.2'], {
    cwd: source, env: { ...process.env, PATH: bin + ':' + process.env.PATH, BUILD_RUNTIME: process.execPath, BUILD_FIXTURE: compiler, BUILD_MARKER: marker },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise<number | null>((yes, no) => { child.once('error', no); child.once('close', yes); });
  let compilerPid: number | undefined, closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(marker), output).toBe(true);
    compilerPid = Number(readFileSync(marker, 'utf8')); expect(compilerPid).toBeGreaterThan(1);
    if (scenario === 'cancel') child.kill('SIGTERM');
    const exited = await Promise.race([closed, new Promise<never>((_yes, no) => { closeTimer = setTimeout(() => no(new Error('Interrupted suite packaging did not drain')), 8_000); })]);
    clearTimeout(closeTimer);
    expect(exited, output).not.toBe(0);
    if (scenario === 'nonzero') expect(output).toContain('Suite native build command failed');
    expect(() => process.kill(compilerPid!, 0)).toThrow();
    expect(readdirSync(destination)).toEqual([]);
    expect(output).not.toContain('"sourceCommit"');
  } finally {
    clearTimeout(closeTimer);
    if (compilerPid !== undefined) { try { process.kill(compilerPid, 'SIGKILL'); } catch { /* actual fixture already drained */ } }
    child.kill('SIGKILL'); await closed;
  }
}, 25_000);
