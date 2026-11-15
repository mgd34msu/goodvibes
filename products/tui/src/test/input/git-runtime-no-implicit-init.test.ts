import { describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerGitRuntimeCommands } from '../../input/commands/git-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function runGit(dir: string, args: string[]): Promise<string> {
  const printed: string[] = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    workspace: { shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }) },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerGitRuntimeCommands(registry);
  await registry.execute('git', args, ctx);
  return printed.join('\n');
}

describe('/git outside a repository', () => {
  test('read subcommands and typos never create a .git directory', async () => {
    const dir = makeProjectTempDir('gv-git-noinit');
    try {
      for (const args of [[], ['status'], ['log'], ['diff'], ['lgo']]) {
        await runGit(dir, args);
        expect(existsSync(join(dir, '.git'))).toBe(false);
      }
      const text = await runGit(dir, ['status']);
      expect(text).toContain('Not a git repository');
      expect(text).toContain('/git init');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('/git init creates the repository only when asked', async () => {
    const dir = makeProjectTempDir('gv-git-init');
    try {
      const text = await runGit(dir, ['init']);
      expect(text).toContain('Initialized git repository');
      expect(existsSync(join(dir, '.git'))).toBe(true);
      expect(await runGit(dir, ['init'])).toContain('already inside a git repository');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
