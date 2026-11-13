import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { releaseEvidenceInputPaths } from '../../../scripts/release.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A throwaway git repo; the release command runs in a child process against it and never against this checkout. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-release-preflight-')); roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.email', 'ci@example.test'); git('config', 'user.name', 'CI');
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'standalone-agent', version: '2.1.0' }, null, 2)}\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## 2.1.0 - 2026-09-30\n\n- previous\n');
  for (const path of releaseEvidenceInputPaths()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), 'evidence\n');
  }
  git('add', '.'); git('commit', '-m', 'init');
  return root;
}

function release(root: string, env: Record<string, string> = {}) {
  const script = join(import.meta.dir, '../../../scripts/release.ts');
  const child = Bun.spawnSync([process.execPath, '-e', `import { main } from ${JSON.stringify(script)}; main(['--patch'], ${JSON.stringify(root)});`], {
    cwd: root, stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, GOODVIBES_AGENT_RELEASE_NOTES: '', ...env },
  });
  return { status: child.exitCode, stderr: child.stderr.toString() };
}

const version = (root: string) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

test('missing release notes are refused before package.json is bumped', () => {
  const root = fixture();
  const result = release(root);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('product release notes are required');
  expect(version(root)).toBe('2.1.0');
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()).toBe('');
});

test('an already existing tag is refused before package.json is bumped', () => {
  const root = fixture();
  execFileSync('git', ['tag', 'v2.1.1'], { cwd: root });
  const result = release(root, { GOODVIBES_AGENT_RELEASE_NOTES: 'Fixes something users see' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('tag v2.1.1 already exists');
  expect(version(root)).toBe('2.1.0');
});
