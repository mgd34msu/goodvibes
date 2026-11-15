import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerGuidanceRuntimeCommands } from '../../input/commands/guidance-runtime.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

async function run(home: string, args: string[]): Promise<string[]> {
  const out: string[] = [];
  const registry = new CommandRegistry();
  registerGuidanceRuntimeCommands(registry);
  const ctx = {
    print: (text: string) => { out.push(text); },
    workspace: { shellPaths: { homeDirectory: home } },
  } as unknown as CommandContext;
  await registry.get('guidance')!.handler(args, ctx);
  return out;
}

describe('/guidance dismiss and reset', () => {
  test('a dismissal that is saved is reported as dismissed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guidance-cmd-')); homes.push(home);
    expect(await run(home, ['dismiss', 'tip-1'])).toEqual(['Dismissed guidance item tip-1.']);
    expect(readFileSync(join(home, '.goodvibes', 'tui', 'guidance.json'), 'utf8')).toContain('tip-1');
  });

  test('a store that cannot be saved is reported as unchanged, never as dismissed or reset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'guidance-cmd-')); homes.push(home);
    mkdirSync(join(home, '.goodvibes', 'tui', 'guidance.json'), { recursive: true });
    const dismissed = await run(home, ['dismiss', 'tip-1']);
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toContain('nothing was changed');
    expect(dismissed[0]).not.toContain('Dismissed guidance item');
    const reset = await run(home, ['reset']);
    expect(reset[0]).toContain('nothing was changed');
    expect(reset[0]).not.toContain('Reset all');
  });
});
