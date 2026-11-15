import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTeleportRuntimeCommands } from '../../input/commands/teleport-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const bundle = { sessionId: 'sess-1', exportedAt: 1_700_000_000_000, activeConnectionIds: ['c1'], pools: [], contracts: [{}], artifacts: [] };

function harness(held: readonly string[] = []) {
  const dir = makeProjectTempDir('teleport');
  dirs.push(dir);
  const printed: string[] = [];
  const calls: string[] = [];
  const ctx = {
    workspace: { shellPaths: { resolveWorkspacePath: (path: string) => join(dir, path), workingDirectory: dir } },
    print: (text: string) => { printed.push(text); },
    clients: {
      peer: {
        runners: {
          exportSessionBundle: async (path: string) => { calls.push(`export ${path}`); return { path, bundle }; },
          importSessionBundle: async (path: string, options?: { replace?: boolean }) => {
            if (held.length > 0 && !options?.replace) throw new Error(`Not imported: ${path} would replace ${held.join(', ')}.`);
            calls.push(`import ${path}`);
            return bundle;
          },
          describeSessionBundleImport: (value: unknown) => (value && typeof value === 'object' && 'pools' in value
            ? { ok: true, bundle: value, replaces: held }
            : { ok: false, problem: 'it has no valid pools (array)' }),
        },
      },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerTeleportRuntimeCommands(registry);
  return { dir, printed, calls, run: (args: string[]) => registry.get('teleport')!.handler(args, ctx) };
}

describe('/teleport (an alias of /remote session)', () => {
  test('export hands the resolved path to the runner registry and says what the bundle holds', async () => {
    const h = harness();
    await h.run(['export', 'out.json']);
    expect(h.calls).toEqual([`export ${join(h.dir, 'out.json')}`]);
    expect(h.printed[0]).toContain('does not hold the conversation');
  });

  test('inspect of a file that is not a bundle answers in a sentence, changing nothing', async () => {
    const h = harness();
    writeFileSync(join(h.dir, 'b.json'), '{}');
    await h.run(['inspect', 'b.json']);
    expect(h.calls).toEqual([]);
    expect(h.printed[0]).toContain('no valid pools');
  });

  test('an import that would replace what is held needs --yes', async () => {
    const h = harness(['pool p1']);
    await h.run(['import', 'in.json']);
    expect(h.calls).toEqual([]);
    expect(h.printed[0]).toContain('would replace pool p1');
    await h.run(['import', 'in.json', '--yes']);
    expect(h.calls).toEqual([`import ${join(h.dir, 'in.json')}`]);
  });
});
