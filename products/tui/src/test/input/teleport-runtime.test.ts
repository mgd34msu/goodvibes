import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerTeleportRuntimeCommands } from '../../input/commands/teleport-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const bundle = { sessionId: 'sess-1', exportedAt: 1_700_000_000_000, activeConnectionIds: ['c1'], pools: [], contracts: [{}], artifacts: [] };

function harness() {
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
          importSessionBundle: async (path: string) => { calls.push(`import ${path}`); return bundle; },
        },
      },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerTeleportRuntimeCommands(registry);
  return { dir, printed, calls, run: (args: string[]) => registry.get('teleport')!.handler(args, ctx) };
}

describe('/teleport', () => {
  test('export hands the resolved path to the runner registry and reports the session', async () => {
    const h = harness();
    await h.run(['export', 'out.json']);
    expect(h.calls).toEqual([`export ${join(h.dir, 'out.json')}`]);
    expect(h.printed[0]).toContain('session sess-1');
  });

  test('import reports the imported session and contract count', async () => {
    const h = harness();
    await h.run(['import', 'in.json']);
    expect(h.calls).toEqual([`import ${join(h.dir, 'in.json')}`]);
    expect(h.printed[0]).toContain('Imported teleport bundle sess-1 with 1 contracts');
  });

  test('inspect reads the bundle file without touching the runner registry', async () => {
    const h = harness();
    writeFileSync(join(h.dir, 'b.json'), JSON.stringify(bundle));
    await h.run(['inspect', 'b.json']);
    expect(h.calls).toEqual([]);
    expect(h.printed[0]).toContain('session: sess-1');
  });

  test('a missing path prints usage and does nothing', async () => {
    const h = harness();
    await h.run(['export']);
    expect(h.calls).toEqual([]);
    expect(h.printed[0]).toContain('Usage: /teleport');
  });
});
