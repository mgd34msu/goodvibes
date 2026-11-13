/**
 * Behaviour of the shell and awk programs embedded in the release workflows.
 * Each case lifts the real step body out of the workflow and executes it with
 * fixture inputs; nothing here asserts on workflow structure.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WF_DIR = resolve(ROOT, '.github/workflows');

type Step = Record<string, unknown>;
type Job = { uses?: string; steps?: Step[]; strategy?: { matrix?: Record<string, unknown> | string } };
type Workflow = { jobs: Record<string, Job> };

function load(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(WF_DIR, name), 'utf8')) as Workflow;
}
function runText(wf: Workflow, jobName: string): string {
  return (wf.jobs[jobName]!.steps ?? []).map((s) => String(s.run ?? '')).join('\n');
}

test('release tag resolution accepts only version tags and refuses npm publication from a branch', () => {
  const resolveStep = load('release.yml').jobs['verify-tag-version']!.steps!.find((step) => step.id === 'source')!;
  const root = mkdtempSync(join(tmpdir(), 'gv-release-tag-'));
  try {
    for (const [tag, caller, npm, allowed] of [
      ['v3.1.1', 'v3.1.1', 'true', true],
      ['v3.1.1', 'main', 'false', true],
      ['main', 'main', 'false', false],
      ['v3.1.1', 'main', 'true', false],
      ['v3.1.1; exit 0', 'main', 'false', false],
    ] as const) {
      const output = join(root, 'output');
      writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', String(resolveStep.run)], {
        env: { ...process.env, RELEASE_TAG: tag, CALLER_REF: caller, PUBLISH_NPM: npm, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      expect(result.status === 0, result.stderr).toBe(allowed);
      expect(readFileSync(output, 'utf8')).toBe(allowed ? `tag=${tag}\nref=refs/tags/${tag}\n` : '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('candidate source resolution requires a full 40-character commit in candidate mode only', () => {
  const resolveStep = load('release.yml').jobs['verify-tag-version']!.steps!.find((step) => step.id === 'source')!;
  const root = mkdtempSync(join(tmpdir(), 'gv-candidate-source-'));
  try {
    for (const [mode, source, allowed] of [['candidate', 'a'.repeat(40), true], ['candidate', 'main', false],
      ['candidate', '', false], ['candidate', 'a'.repeat(39), false], ['release', 'a'.repeat(40), false]] as const) {
      const output = join(root, 'output'); writeFileSync(output, '');
      const result = spawnSync('bash', ['-e', '-c', String(resolveStep.run)], {
        env: { ...process.env, RELEASE_TAG: 'v3.1.2', CALLER_REF: 'main', PUBLISH_NPM: 'true', RELEASE_MODE: mode, CANDIDATE_SOURCE: source, GITHUB_OUTPUT: output },
        encoding: 'utf8',
      });
      expect(result.status === 0, result.stderr).toBe(allowed);
      expect(readFileSync(output, 'utf8')).toBe(allowed ? `tag=v3.1.2\nref=${source}\n` : '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the candidate packaging guard refuses a publishing or non-commit candidate', () => {
  const guard = load('suite-release-assets.yml').jobs['package']!.steps!.find((step) => step.name === 'Require a nonpublishing immutable candidate')!;
  for (const [source, publish, allowed] of [['a'.repeat(40), 'false', true], ['a'.repeat(40), 'true', false], ['main', 'false', false], ['', 'true', true]] as const) {
    const result = spawnSync('bash', ['-e', '-c', String(guard.run)], { env: { ...process.env, CANDIDATE_SOURCE: source, PUBLISH_EXISTING: publish }, encoding: 'utf8' });
    expect(result.status === 0, result.stderr).toBe(allowed);
  }
});

test('the shipped awk program extracts exactly one section, including next to a prerelease heading', () => {
  // Runs the awk program lifted out of the workflow itself, so the fixture
  // exercises what actually ships rather than a copy that can drift.
  const fixture = [
    '# Changelog',
    '',
    '## [2.0.1-rc.1] - 2026-01-02',
    'RC BODY',
    '',
    '## [2.0.1] - 2026-01-05',
    'FINAL BODY',
    '',
    '## 2.0.0 - 2026-01-01',
    'BARE BODY',
    '',
    '## [1.9.9]',
    'NODATE BODY',
    '',
  ].join('\n');
  const path = join(tmpdir(), `changelog-fixture-${process.pid}.md`);
  writeFileSync(path, fixture);
  try {
    for (const [wfName, jobName] of [['release.yml', 'github-release'], ['reusable-gh-release.yml', 'gh-release']] as const) {
      const caller = load(wfName).jobs[jobName]!;
      const owner = caller.uses === './.github/workflows/reusable-gh-release.yml'
        ? [load('reusable-gh-release.yml'), 'gh-release'] as const
        : [load(wfName), jobName] as const;
      const program = /awk -v version="\$\w+" '([\s\S]*?)'\s/.exec(runText(owner[0], owner[1]))?.[1];
      expect(program, `${wfName}: no awk program found`).toBeTruthy();
      const extract = (version: string): string => {
        const res = spawnSync('awk', ['-v', `version=${version}`, program!, path], { encoding: 'utf8', timeout: 30_000 });
        expect(res.status, `${wfName}: awk failed: ${res.stderr}`).toBe(0);
        return res.stdout.trim();
      };
      // The defect: a `-` terminator matched the RC heading first and the
      // body became RC BODY plus FINAL BODY concatenated.
      expect(extract('2.0.1'), `${wfName}: 2.0.1 must not absorb its RC section`).toBe('FINAL BODY');
      expect(extract('2.0.1-rc.1'), `${wfName}: an RC cut still finds its own section`).toBe('RC BODY');
      expect(extract('2.0.0'), `${wfName}: bare heading form`).toBe('BARE BODY');
      expect(extract('1.9.9'), `${wfName}: bracket heading with no date`).toBe('NODATE BODY');
      expect(extract('7.7.7'), `${wfName}: an absent version yields nothing (the warning path)`).toBe('');
    }
  } finally {
    rmSync(path, { force: true });
  }
});

test('previous release resolution picks the nearest earlier version tag in history', () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-previous-release-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git('init', '-q');
    const shas: Record<string, string> = {};
    for (const [tag, annotated] of [['v1.0.0', false], ['v1.1.0', true]] as const) {
      git('commit', '-q', '--allow-empty', '-m', tag);
      if (annotated) git('tag', '-a', tag, '-m', tag); else git('tag', tag);
      shas[tag] = git('rev-parse', `${tag}^{commit}`);
    }
    git('commit', '-q', '--allow-empty', '-m', 'unreleased');
    const releaseStep = load('release.yml').jobs['verify-tag-version']!.steps!.find((step) => step.id === 'previous')!;
    const suiteStep = load('suite-release-assets.yml').jobs['previous-release']!.steps!.find((step) => step.id === 'previous')!;
    for (const step of [releaseStep, suiteStep]) {
      for (const [tag, expected] of [['v1.1.0', 'v1.0.0'], ['v1.0.0', ''], ['v1.2.0', 'v1.1.0']] as const) {
        const output = join(root, 'output');
        writeFileSync(output, '');
        const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', String(step.run)], {
          cwd: root, encoding: 'utf8', env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
        });
        expect(result.status, result.stderr).toBe(0);
        // The suite workflow only runs for an existing tag; a not-yet-tagged label has no meaning there.
        if (step === suiteStep && tag === 'v1.2.0') continue;
        expect(readFileSync(output, 'utf8')).toBe(expected ? `tag=${expected}\nsource=${shas[expected]}\n` : '');
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
