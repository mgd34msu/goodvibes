import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorktreeCommandRunner,
  runWorktreeSetup,
} from '../platform/src/platform/runtime/worktree/setup.js';

const dirs: string[] = [];
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), 'gv-worktree-setup-'));
  dirs.push(made);
  return made;
}
afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
}

describe('carry-over of git-ignored files', () => {
  test('a gitignored .env is copied into the new worktree', async () => {
    const source = dir();
    const target = dir();
    git(source, 'init');
    writeFileSync(join(source, '.gitignore'), '.env\n.env.*\nnode_modules/\n');
    writeFileSync(join(source, '.env'), 'TOKEN=abc\n');
    writeFileSync(join(source, '.env.local'), 'LOCAL=1\n');
    mkdirSync(join(source, 'node_modules'));
    writeFileSync(join(source, 'node_modules', '.env'), 'NOT=copied\n');
    const result = await runWorktreeSetup(target, source, { commands: [], carryOverGlobs: ['.env', '.env.*'] });
    expect(result.state).toBe('succeeded');
    expect(readFileSync(join(target, '.env'), 'utf8')).toBe('TOKEN=abc\n');
    expect(readFileSync(join(target, '.env.local'), 'utf8')).toBe('LOCAL=1\n');
    expect(existsSync(join(target, 'node_modules'))).toBe(false);
    expect(result.steps[0]!.output.split('\n').sort()).toEqual(['.env', '.env.local']);
  });

  test('a glob that matches nothing says so instead of reporting an empty success', async () => {
    const source = dir();
    git(source, 'init');
    const result = await runWorktreeSetup(dir(), source, { commands: [], carryOverGlobs: ['.env'] });
    expect(result.state).toBe('succeeded');
    expect(result.steps[0]!.output).toContain('matched the carry-over globs (.env)');
  });
});

describe('setup command time limit', () => {
  test('the default runner stops a command that outlives its limit', async () => {
    const outcome = await createWorktreeCommandRunner(100)('sleep 60', dir());
    expect(outcome.timedOut).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
  });

  test('a command that finishes in time is not marked timed out', async () => {
    const outcome = await createWorktreeCommandRunner(60_000)('echo done', dir());
    expect(outcome).toEqual({ exitCode: 0, output: 'done\n' });
  });

  test('a timed out command fails the run and says it was stopped', async () => {
    const result = await runWorktreeSetup(dir(), dir(), { commands: ['sleep 60'], carryOverGlobs: [] }, { commandTimeoutMs: 100 });
    expect(result.state).toBe('failed');
    expect(result.error).toContain('was stopped after running longer than 100ms: sleep 60');
  });
});
