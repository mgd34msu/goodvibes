import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalProviderCommands, customProviderKeyName } from '../terminal-shell/src/local-provider-commands.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function harness(options: { providersDirectory?: string; failStore?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'provider-add-')); dirs.push(root);
  const directory = options.providersDirectory ?? join(root, 'providers');
  const stored: string[] = []; const printed: string[] = [];
  let handler!: (args: string[], context: never) => Promise<void>;
  const { registerLocalProviderRuntimeCommands } = createLocalProviderCommands(
    {
      requireProviderApi: () => { throw new Error('unused'); },
      requireShellPaths: () => ({ resolveUserPath: () => directory }) as never,
      requireSecretsManager: () => ({ set: async (key: string) => { if (options.failStore) throw new Error('vault locked'); stored.push(key); } }) as never,
    },
    { surfaceRoot: 'tui', hidden: false, confirmMutations: false, allowInlineKey: true, captureMissingKey: false, explicitModelSelection: false, codeEditing: true, beforeSelection: () => {} },
  );
  registerLocalProviderRuntimeCommands({ register: (command: never) => { handler = (command as { handler: typeof handler }).handler; } } as never);
  const context = { print: (text: string) => { printed.push(text); } } as never;
  return { root, directory, stored, printed, add: () => handler(['add', 'local', 'http://127.0.0.1:9/v1', 'sk-secret'], context) };
}

test('a provider file that cannot be written leaves no stored key behind', async () => {
  const root = mkdtempSync(join(tmpdir(), 'provider-blocked-')); dirs.push(root);
  const blocker = join(root, 'not-a-directory');
  writeFileSync(blocker, 'x');
  const f = harness({ providersDirectory: join(blocker, 'providers') });
  await f.add();
  expect(f.stored).toEqual([]);
  expect(f.printed.join('\n')).toContain('Error writing provider file');
});

test('a key that cannot be stored takes the provider file back out', async () => {
  const f = harness({ failStore: true });
  await f.add();
  expect(existsSync(join(f.directory, 'local.json'))).toBe(false);
  expect(f.printed.join('\n')).toContain('The provider was not added');
});

test('a successful add writes the file and then stores the key under its derived name', async () => {
  const f = harness();
  await f.add();
  expect(existsSync(join(f.directory, 'local.json'))).toBe(true);
  expect(f.stored).toEqual([customProviderKeyName('local')]);
});

test('/provider qualifies a model id that itself contains a colon', async () => {
  const selected: string[] = [];
  let handler!: (args: string[], context: never) => Promise<void>;
  const { registerLocalProviderRuntimeCommands } = createLocalProviderCommands(
    {
      requireProviderApi: () => ({
        listProviderIds: () => ['ollama'],
        listModels: async () => [{ registryKey: 'ollama:default' }],
        selectModel: async (key: string) => { selected.push(key); return { providerId: 'ollama', registryKey: key, modelId: key.slice('ollama:'.length) }; },
      }) as never,
      requireShellPaths: () => ({ resolveUserPath: () => '' }) as never,
      requireSecretsManager: () => { throw new Error('unused'); },
    },
    { surfaceRoot: 'agent', hidden: false, confirmMutations: false, allowInlineKey: true, captureMissingKey: false, explicitModelSelection: true, codeEditing: true, beforeSelection: (_c: unknown, _p: string, apply: () => void) => apply() } as never,
  );
  registerLocalProviderRuntimeCommands({ register: (command: never) => { handler = (command as { handler: typeof handler }).handler; } } as never);
  const context = { print: () => {}, session: { runtime: { model: '', provider: '' } }, platform: { configManager: { set: () => {} } } } as never;
  await handler(['ollama', 'llama3:8b'], context);
  await handler(['ollama', 'ollama:llama3:8b'], context);
  expect(selected).toEqual(['ollama:llama3:8b', 'ollama:llama3:8b']);
});
