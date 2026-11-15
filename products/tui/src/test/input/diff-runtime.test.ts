// ---------------------------------------------------------------------------
// diff-runtime.test.ts, regression coverage:
//   (a) /diff in a non-git directory opens the Changes modal, which
//       short-circuits with a friendly message (and an init offer) instead of
//       running git per view and surfacing inconsistent error shapes.
//   (b) every Bun.spawn() the Changes modal makes captures stderr instead of
//       letting git's `fatal: ...` write straight to the real tty.
// ---------------------------------------------------------------------------

import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDiffRuntimeCommands } from '../../input/commands/diff-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { ChangesModal } from '../../input/changes-modal.ts';
import type { ChangesSource } from '../../input/changes-git.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

// ── (a) /diff in a non-git directory ────────────────────────────────────────

function makeCtx(dir: string): { ctx: CommandContext; printed: string[]; opened: Array<ChangesSource | undefined> } {
  const printed: string[] = [];
  const opened: Array<ChangesSource | undefined> = [];
  const ctx = {
    print: (text: string) => { printed.push(text); },
    renderRequest: () => {},
    openChanges: (options?: { readonly source?: ChangesSource }) => { opened.push(options?.source); },
    exit: () => {},
    session: { changeTracker: { getChangedFiles: () => [] } },
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }),
    },
    provider: {},
    platform: {},
    ops: {},
    extensions: {},
  } as unknown as CommandContext;
  return { ctx, printed, opened };
}

describe('(a) /diff in a non-git directory', () => {
  test('/diff and its subcommands open the Changes modal on the matching view', async () => {
    const dir = makeProjectTempDir('gv-diff-runtime-nogit');
    try {
      const registry = new CommandRegistry();
      registerDiffRuntimeCommands(registry);
      const { ctx, opened } = makeCtx(dir);
      await registry.execute('diff', [], ctx);
      for (const sub of ['working', 'head', 'staged']) await registry.execute('diff', [sub], ctx);
      expect(opened).toEqual(['session', 'working', 'head', 'staged']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Changes modal short-circuits with a friendly "not a git repository" message for every view', async () => {
    const dir = makeProjectTempDir('gv-diff-runtime-nogit');
    try {
      for (const source of ['session', 'working', 'head', 'staged'] as const) {
        const modal = new ChangesModal({ workingDirectory: dir, getSessionFiles: () => [], requestRender: () => {} });
        await modal.reload(source);
        expect(modal.notRepo).toBe(true);
        // No git diff ran: nothing loaded, no error text from git.
        expect(modal.files).toEqual([]);
        expect(modal.error).toBeNull();
        const text = layerTextBlock(modal.render(120, 40));
        expect(text).toMatch(/Not a git repository here/);
        expect(text).not.toMatch(/fatal:/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('(b) git child processes capture stderr', () => {
  test('every spawn made while loading the Changes views pipes stderr', async () => {
    const dir = makeProjectTempDir('gv-diff-runtime-stderr');
    // A real repository, so the modal goes on to run git instead of stopping at "not a repository".
    execFileSync('git', ['init', '-q'], { cwd: dir, timeout: 30_000 });
    const realSpawn = Bun.spawn;
    const spawnOptions: unknown[] = [];
    const spy = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
      // Bun.spawn(cmd, options) or Bun.spawn({ cmd, ...options })
      spawnOptions.push(Array.isArray(args[0]) ? args[1] : args[0]);
      return (realSpawn as (...a: unknown[]) => ReturnType<typeof Bun.spawn>)(...args);
    }) as typeof Bun.spawn);
    try {
      for (const source of ['session', 'working', 'head', 'staged'] as const) {
        const modal = new ChangesModal({ workingDirectory: dir, getSessionFiles: () => [], requestRender: () => {} });
        await modal.reload(source);
      }
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(spawnOptions.length).toBeGreaterThan(0);
    for (const options of spawnOptions) {
      const o = options as { stderr?: unknown; stdio?: readonly unknown[] };
      expect(o.stderr ?? o.stdio?.[2]).toBe('pipe');
    }
  });
});
