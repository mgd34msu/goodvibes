import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Step = { name?: string; uses?: string; run?: string; if?: string; 'working-directory'?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; needs?: string[]; uses?: string; with?: Record<string, unknown>; steps?: Step[]; strategy?: { 'fail-fast': boolean; matrix: { include: Array<{ target: string; runner: string }> } } };
type Workflow = { on: Record<string, { inputs: Record<string, { required?: boolean; type?: string; default?: unknown }> }>; jobs: Record<string, Job> };
const load = (name: string) => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', name), 'utf8')) as Workflow;
const previousSource = 'a5ddf1f151466590eaed4ab387b2f95be7112a86';
const matrix = [{ target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' },
  { target: 'darwin-x64', runner: 'macos-15-intel' }, { target: 'darwin-arm64', runner: 'macos-15' }];
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const mode of ['staged', 'published'] as const) {
  const workflow = load(`reusable-${mode}-install-acceptance.yml`), upgrade = workflow.jobs['previous-release-upgrade']!;
  test(`${mode} acceptance adds four real previous-suite lanes without replacing fresh or historical evidence`, () => {
    for (const trigger of ['workflow_call', 'workflow_dispatch']) {
      for (const input of ['previous-tag', 'previous-source']) {
        expect(workflow.on[trigger]!.inputs[input]).toEqual(expect.objectContaining({ required: false, type: 'string', default: '' }));
      }
    }
    expect(upgrade.if).toBe("inputs.tag != 'v3.1.2' || inputs.previous-tag != '' || inputs.previous-source != ''");
    expect(upgrade.strategy?.matrix.include).toEqual(matrix); expect(upgrade.strategy?.['fail-fast']).toBe(false);
    expect(workflow.jobs['native-install']!.strategy?.matrix.include).toEqual(matrix);
    expect(workflow.jobs['historical-linux-upgrade']!.if).toBe("inputs.tag == 'v3.1.2'");
    const oldRun = workflow.jobs['historical-linux-upgrade']!.steps!.find(step => step.run?.includes('upgrade-v3.1.1'));
    expect(oldRun?.run).toEndWith(' upgrade-v3.1.1');
    expect(upgrade.needs).toEqual(mode === 'staged' ? ['stage-release-assets'] : undefined);
    const steps = upgrade.steps!;
    expect(steps.filter(step => String(step.uses).startsWith('actions/checkout@')).map(step => step.with)).toEqual([
      { ref: '${{ inputs.tooling-sha }}', 'fetch-depth': 0 }, { ref: '${{ inputs.source }}', path: 'candidate-source' },
    ]);
    expect(steps.find(step => String(step.uses).startsWith('actions/setup-node@'))?.with).toEqual({ 'node-version': '22' });
    expect(steps.find(step => String(step.uses).startsWith('oven-sh/setup-bun@'))?.with).toEqual({ 'bun-version': '1.3.14' });
    const invoke = steps.find(step => step.name === 'Observe previous-suite automatic upgrade and complete-cohort rollback')!;
    expect(invoke.env).toEqual({ RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}',
      PREVIOUS_TAG: '${{ inputs.previous-tag }}', PREVIOUS_SOURCE: '${{ inputs.previous-source }}', CANDIDATE_SOURCE_ROOT: '${{ github.workspace }}/candidate-source',
      GOODVIBES_ACCEPTANCE_METADATA_TOKEN: '${{ secrets.GITHUB_TOKEN }}' });
    expect(invoke.run).toBe(`node scripts/accept-${mode}-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET"${mode === 'staged' ? ' "$RUNNER_TEMP/staged-release-assets"' : ''} upgrade-previous "$PREVIOUS_TAG" "$PREVIOUS_SOURCE"`);
    const commands = steps.map(step => step.run ?? '').join('\n');
    expect(commands).not.toMatch(/scripts\/build\.ts|build:binary|GOODVIBES_HOME/);
    expect(steps.filter(step => step.run?.startsWith('bun install'))).toEqual([{ name: 'Install source lifecycle writer dependencies', 'working-directory': 'candidate-source', run: 'bun install --frozen-lockfile' }]);
    const downloads = steps.filter(step => String(step.uses).startsWith('actions/download-artifact@'));
    if (mode === 'staged') expect(downloads.map(step => step.with)).toEqual([{ name: 'staged-release-assets', path: '${{ runner.temp }}/staged-release-assets' }]);
    else expect(downloads).toEqual([]);
    const upload = steps.find(step => String(step.uses).startsWith('actions/upload-artifact@'))!;
    expect(upload.if).toBe('always()');
    expect(upload.with).toMatchObject({ name: `${mode}-upgrade-previous-` + '${{ matrix.target }}', path: '${{ runner.temp }}/goodvibes-published-*/acceptance-result.json' });
  });

  test(`${mode} actual input guard rejects an absent/partial previous identity and wrong checkout owner`, () => {
    const root = mkdtempSync(join(tmpdir(), 'previous-suite-workflow-')); roots.push(root);
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'candidate-source/packages/engine/platform/src/platform/daemon'), { recursive: true });
    writeFileSync(join(root, `scripts/accept-${mode}-suite.mjs`), '');
    writeFileSync(join(root, 'candidate-source/packages/engine/platform/src/platform/daemon/lifecycle-marker.ts'), '');
    writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nif [ "$1" = -C ]; then [ "$2" = candidate-source ] || exit 91; printf "%s\\n" "$FIXTURE_SOURCE"; else [ "$1" = rev-parse ] || exit 92; printf "%s\\n" "$FIXTURE_TOOLING"; fi\n', { mode: 0o755 });
    const guard = upgrade.steps!.find(step => step.name === 'Verify both source owners and the previous published identity')!;
    const valid = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH,
      TOOLING_SHA: 'a'.repeat(40), SOURCE_SHA: 'b'.repeat(40), PREVIOUS_SOURCE: previousSource, PREVIOUS_TAG: 'v3.1.2', RELEASE_TAG: 'v3.1.3',
      FIXTURE_SOURCE: 'b'.repeat(40), FIXTURE_TOOLING: 'a'.repeat(40) };
    const run = (delta: Record<string, string> = {}) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard.run!],
      { cwd: root, env: { ...valid, ...delta }, encoding: 'utf8', timeout: 5000 });
    const accepted = run(); expect(accepted.error).toBeUndefined(); expect(accepted.status, accepted.stderr).toBe(0);
    const invalidInputs: Record<string, string>[] = [{ PREVIOUS_TAG: '', PREVIOUS_SOURCE: '' },
      { RELEASE_TAG: 'v3.1.4', PREVIOUS_TAG: '', PREVIOUS_SOURCE: '' }, { PREVIOUS_TAG: '' }, { PREVIOUS_SOURCE: '' }, { PREVIOUS_SOURCE: 'main' },
      { PREVIOUS_TAG: 'v3.1.3' }, { FIXTURE_SOURCE: 'c'.repeat(40) }, { FIXTURE_TOOLING: 'c'.repeat(40) }];
    for (const invalid of invalidInputs) {
      const refused = run(invalid); expect(refused.error).toBeUndefined(); expect(refused.status, JSON.stringify(invalid)).not.toBe(0);
    }
  });
}

test('new patch release pins the previous public suite for required prepublication qualification', () => {
  const release = load('release.yml');
  for (const job of ['staged-install-acceptance']) {
    expect(release.jobs[job]?.with).toMatchObject({
      'previous-tag': "${{ needs.verify-tag-version.outputs.tag == 'v3.1.4' && 'v3.1.3' || needs.verify-tag-version.outputs.tag == 'v3.1.3' && 'v3.1.2' || '' }}",
      'previous-source': "${{ needs.verify-tag-version.outputs.tag == 'v3.1.4' && '0065d6726d4d9fe3f800e255711b6cf8d78d0d72' || needs.verify-tag-version.outputs.tag == 'v3.1.3' && '" + previousSource + "' || '' }}",
    });
  }
  expect(release.jobs['github-release']!.needs).toContain('staged-install-acceptance');
  expect(release.jobs['github-release']!.if).toContain("needs.staged-install-acceptance.result == 'success'");
  expect(release.jobs['published-install-acceptance']).toBeUndefined();
  for (const job of Object.values(release.jobs)) expect(job.needs ?? []).not.toContain('github-release');
  expect(release.jobs['github-release']!.needs).toContain('release-verify-tooling');
});

test('manual suite preparation requires an explicit tag and defaults to no public mutation', () => {
  const suite = load('suite-release-assets.yml');
  expect(suite.on.workflow_dispatch!.inputs.tag).toMatchObject({ required: true });
  expect(suite.on.workflow_dispatch!.inputs.tag?.default).toBeUndefined();
  expect(suite.on.workflow_dispatch!.inputs.publish_existing?.default).toBe(false);
  expect(suite.on.workflow_call!.inputs.publish_existing?.default).toBe(false);
  expect(suite.jobs['published-install-acceptance']!.with).toMatchObject({
    'previous-tag': "${{ inputs.tag == 'v3.1.3' && 'v3.1.2' || '' }}",
    'previous-source': "${{ inputs.tag == 'v3.1.3' && '" + previousSource + "' || '' }}",
  });
});
