import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext } from '../../input/command-registry.ts';
import { handleUpdateBundleSubcommand } from '../../input/commands/update-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(args: string[], files: Record<string, string> = {}): string {
  const dir = makeProjectTempDir('update-bundle');
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const printed: string[] = [];
  const ctx = {
    workspace: { shellPaths: { resolveWorkspacePath: (path: string) => join(dir, path), workingDirectory: dir } },
    print: (text: string) => { printed.push(text); },
  } as unknown as CommandContext;
  handleUpdateBundleSubcommand(args, ctx);
  return printed.join('\n');
}

describe('/update bundle', () => {
  test('a missing or unknown mode prints usage instead of failing', () => {
    expect(run(['bundle'])).toContain('Usage: /update bundle');
    expect(run(['bundle', 'foo'])).toContain('Usage: /update bundle');
  });

  test('inspect without a path prints usage for that mode', () => {
    expect(run(['bundle', 'inspect'])).toContain('Usage: /update bundle inspect <path>');
  });

  test('inspecting a file that is not an update bundle says so', () => {
    const output = run(['bundle', 'inspect', 'other.json'], { 'other.json': JSON.stringify({ hello: 'world' }) });
    expect(output).toContain('not an update bundle');
    expect(output).not.toContain('undefined');
  });

  test('inspecting a well-formed bundle prints its review', () => {
    const bundle = { version: 1, exportedAt: 1, appVersion: '3.3.0', installKind: 'binary', subscriptionProviders: ['a'], sandboxProfile: 'x/y/z', notes: ['n'] };
    const output = run(['bundle', 'inspect', 'bundle.json'], { 'bundle.json': JSON.stringify(bundle) });
    expect(output).toContain('Update Bundle Review');
    expect(output).toContain('appVersion: 3.3.0');
  });
});
