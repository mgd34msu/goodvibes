import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createWorkspaceRegistrationStore } from '../../config/workspace-registration.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function run(args: readonly string[], workingDirectory: string, homeDirectory: string) {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: workingDirectory, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory,
      homeDirectory,
    });
    return { result, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

describe('a flag value is not a positional argument', () => {
  test('workspaces register --label Work registers the working directory, not a folder named Work', async () => {
    const home = makeProjectTempDir('gv-valued-flags-home');
    const work = makeProjectTempDir('gv-valued-flags-work');

    const registered = await run(['workspaces', 'register', '--label', 'Work', '--yes'], work, home);
    expect(registered.result.exitCode).toBe(0);

    const store = createWorkspaceRegistrationStore(createShellPathService({ workingDirectory: work, homeDirectory: home }));
    // Coverage flows down a root's subtree, so the registered roots themselves are what show a stray folder.
    expect((await store.snapshot()).workspaces.map((entry) => entry.root)).toEqual([work]);
    expect((await run(['workspaces', 'list'], work, home)).output).toContain('(Work)');
  });

  test('workspaces register resolves a relative path against the working directory, not the process directory', async () => {
    const home = makeProjectTempDir('gv-valued-flags-home');
    const work = makeProjectTempDir('gv-valued-flags-work');

    const registered = await run(['workspaces', 'register', 'sub', '--label', 'Sub', '--yes'], work, home);
    expect(registered.result.exitCode).toBe(0);

    const store = createWorkspaceRegistrationStore(createShellPathService({ workingDirectory: work, homeDirectory: home }));
    expect((await store.snapshot()).workspaces.map((entry) => entry.root)).toEqual([join(work, 'sub')]);
  });

  test('profiles create accepts the starter template before the profile name', async () => {
    const home = makeProjectTempDir('gv-valued-flags-home');

    const created = await run(['profiles', 'create', '--template', 'household', 'family', '--yes'], home, home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('Agent profile created: family');
    expect(created.output).toContain('household');
    expect((await run(['profiles', 'list'], home, home)).output).not.toContain('  household  home');
  });
});
