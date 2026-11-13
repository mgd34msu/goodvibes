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
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const mode of ['staged', 'published'] as const) {
  const workflow = load(`reusable-${mode}-install-acceptance.yml`), upgrade = workflow.jobs['previous-release-upgrade']!;
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
      { RELEASE_TAG: 'v3.1.4', PREVIOUS_TAG: '', PREVIOUS_SOURCE: '' }, { RELEASE_TAG: 'v3.1.5', PREVIOUS_TAG: '', PREVIOUS_SOURCE: '' },
      { RELEASE_TAG: 'v3.1.6', PREVIOUS_TAG: '', PREVIOUS_SOURCE: '' },
      { PREVIOUS_TAG: '' }, { PREVIOUS_SOURCE: '' }, { PREVIOUS_SOURCE: 'main' },
      { PREVIOUS_TAG: 'v3.1.3' }, { FIXTURE_SOURCE: 'c'.repeat(40) }, { FIXTURE_TOOLING: 'c'.repeat(40) }];
    for (const invalid of invalidInputs) {
      const refused = run(invalid); expect(refused.error).toBeUndefined(); expect(refused.status, JSON.stringify(invalid)).not.toBe(0);
    }
  });
}
