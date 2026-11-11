import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Step = { name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Workflow = {
  on: Record<string, { inputs: Record<string, { required?: boolean; type?: string }> }>;
  permissions: Record<string, string>;
  jobs: Record<string, { needs?: unknown; uses?: unknown; permissions?: unknown; 'timeout-minutes': number;
    strategy: { 'fail-fast': boolean; matrix: { include: Array<{ target: string; runner: string }> } }; steps: Step[] }>;
};
const workflow = Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows/verify-installer-migration.yml'), 'utf8')) as Workflow;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('manual public installer migration runs only the two Linux targets with current tooling', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(Object.keys(workflow.on.workflow_dispatch!.inputs).sort()).toEqual(['source', 'tag', 'tooling-sha']);
  for (const input of Object.values(workflow.on.workflow_dispatch!.inputs)) expect(input).toMatchObject({ required: true, type: 'string' });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(Object.keys(workflow.jobs)).toEqual(['installer-migration']);
  const job = workflow.jobs['installer-migration']!;
  expect(job.needs).toBeUndefined(); expect(job.uses).toBeUndefined(); expect(job.permissions).toBeUndefined();
  expect(job['timeout-minutes']).toBe(35); expect(job.strategy['fail-fast']).toBe(false);
  expect(job.strategy.matrix.include).toEqual([{ target: 'linux-x64', runner: 'ubuntu-24.04' }, { target: 'linux-arm64', runner: 'ubuntu-22.04-arm' }]);
  expect(job.steps.filter(step => String(step.uses).startsWith('actions/checkout@')).map(step => step.with)).toEqual([{ ref: '${{ inputs.tooling-sha }}' }]);
  expect(job.steps.find(step => String(step.uses).startsWith('actions/setup-node@'))?.with).toEqual({ 'node-version': '22' });
  expect(job.steps.filter(step => step.uses).map(step => step.uses)).not.toContain('./.github/actions/setup');
});

test('migration invokes its distinct public scenario and always preserves a separately named receipt', () => {
  const steps = workflow.jobs['installer-migration']!.steps;
  const invoke = steps.find(step => step.name === 'Migrate the old installation with the actual public installer')!;
  expect(invoke.env).toEqual({ RELEASE_TAG: '${{ inputs.tag }}', RELEASE_SOURCE: '${{ inputs.source }}', RELEASE_TARGET: '${{ matrix.target }}' });
  expect(invoke.run).toBe('node scripts/accept-published-suite.mjs "$RELEASE_TAG" "$RELEASE_SOURCE" "$RELEASE_TARGET" installer-migrate-v3.1.1');
  const upload = steps.find(step => String(step.uses).startsWith('actions/upload-artifact@'))!;
  expect(upload.if).toBe('always()');
  expect(upload.with).toMatchObject({ name: 'published-installer-migration-v3.1.1-${{ matrix.target }}',
    path: '${{ runner.temp }}/goodvibes-published-*/acceptance-result.json', 'if-no-files-found': 'warn' });
  const commands = steps.map(step => step.run ?? '').join('\n');
  expect(commands).not.toMatch(/\bbun\b|\bbuild\b|rollback|upgrade-v3\.1\.1|--out|sha256sums|gh release|git tag|npm publish|GOODVIBES_HOME/);
  expect(steps.some(step => String(step.uses).startsWith('actions/download-artifact@'))).toBe(false);
});

test('the actual migration guard refuses mutable refs, mismatched tooling and another destination version', () => {
  const guard = workflow.jobs['installer-migration']!.steps.find(step => step.name === 'Verify immutable migration inputs')!;
  const root = mkdtempSync(join(tmpdir(), 'public-migration-inputs-')); roots.push(root);
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/accept-published-suite.mjs'), '');
  writeFileSync(join(root, 'bin/git'), '#!/bin/sh\n[ "$1" = rev-parse ] && [ "$2" = HEAD ] || exit 91\nprintf "%s\\n" "$FIXTURE_HEAD"\n', { mode: 0o755 });
  const valid = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, RELEASE_TAG: 'v3.1.2', RELEASE_SOURCE: 'a'.repeat(40), TOOLING_SHA: 'b'.repeat(40), FIXTURE_HEAD: 'b'.repeat(40) };
  const run = (changes: Record<string, string> = {}) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard.run!],
    { cwd: root, env: { ...valid, ...changes }, encoding: 'utf8', timeout: 5_000 });
  const accepted = run(); expect(accepted.status, accepted.stderr).toBe(0);
  for (const changes of [{ RELEASE_TAG: 'v3.1.3' }, { RELEASE_TAG: 'v3.1.2;exit 0' }, { RELEASE_SOURCE: 'main' }, { RELEASE_SOURCE: '' },
    { TOOLING_SHA: 'refs/heads/main' }, { FIXTURE_HEAD: 'c'.repeat(40) }]) {
    const refused = run(changes); expect(refused.error).toBeUndefined(); expect(refused.status, JSON.stringify(changes)).not.toBe(0);
  }
});
