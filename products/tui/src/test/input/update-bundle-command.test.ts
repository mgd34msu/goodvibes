import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleUpdateBundleSubcommand } from '../../input/commands/update-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function run(args: string[], files: Record<string, string> = {}): Promise<string> {
  const dir = makeProjectTempDir('update-bundle');
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const printed: string[] = [];
  const ctx = {
    workspace: { shellPaths: { resolveWorkspacePath: (path: string) => join(dir, path), workingDirectory: dir } },
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
  await handleUpdateBundleSubcommand(args, ctx);
  return printed.join('\n');
}

describe('/update bundle', () => {
  test('a missing or unknown mode prints usage instead of failing', async () => {
    expect(await run(['bundle'])).toContain('Usage: /update bundle');
    expect(await run(['bundle', 'foo'])).toContain('Usage: /update bundle');
  });

  test('inspect without a path prints usage for that mode', async () => {
    expect(await run(['bundle', 'inspect'])).toContain('Usage: /update bundle inspect <path>');
  });

  test('inspecting a file that is not an update review says so', async () => {
    const output = await run(['bundle', 'inspect', 'other.json'], { 'other.json': JSON.stringify({ hello: 'world' }) });
    expect(output).toContain('not an update review');
    expect(output).not.toContain('undefined');
  });

  test('inspecting a saved review prints the installed and latest versions and the rollback copy', async () => {
    const review = {
      version: 2, exportedAt: 1, appVersion: '3.3.0', installKind: 'binary', latest: { tag: 'v3.4.0', isCurrent: false },
      channel: 'releases', rollbackRetained: true, subscriptionProviders: ['a'], sandboxProfile: 'x/y/z',
    };
    const output = await run(['bundle', 'inspect', 'review.json'], { 'review.json': JSON.stringify(review) });
    expect(output).toContain('installed version: 3.3.0');
    expect(output).toContain('latest release: v3.4.0');
    expect(output).toContain('rollback copy: kept');
  });
});
