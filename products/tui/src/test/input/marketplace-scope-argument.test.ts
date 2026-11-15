import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerMarketplaceRuntimeCommands } from '../../input/commands/marketplace-runtime.ts';
import { registerPluginRuntimeCommands } from '../../input/commands/plugin-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('/marketplace scope argument', () => {
  test('a word that is not a scope is refused instead of silently meaning the project', async () => {
    const root = makeProjectTempDir('gv-marketplace-scope');
    try {
      const printed: string[] = [];
      const ctx = {
        print: (text: string) => { printed.push(text); },
        workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
      } as unknown as CommandContext;
      const registry = new CommandRegistry();
      registerMarketplaceRuntimeCommands(registry);
      for (const args of [
        ['rollback', 'plugin', 'x', 'bk_123'],
        ['install', 'plugin', 'x', 'usr'],
        ['uninstall', 'plugin', 'x', 'global'],
        ['history', 'plugin', 'x', 'bk_123'],
        ['receipt', 'plugin', 'x', 'usr'],
        ['bundle', 'export', 'out.json', 'usr'],
      ]) {
        printed.length = 0;
        await registry.execute('marketplace', args, ctx);
        expect(printed.join('\n')).toContain('Unknown scope');
        expect(printed.join('\n')).toContain('Nothing was changed');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/plugin scope argument', () => {
  test('install, update and uninstall refuse a word that is not a scope instead of acting on the project', async () => {
    const root = makeProjectTempDir('gv-plugin-scope');
    try {
      const printed: string[] = [];
      const ctx = {
        print: (text: string) => { printed.push(text); },
        extensions: { pluginManager: {} },
        workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
      } as unknown as CommandContext;
      const registry = new CommandRegistry();
      registerPluginRuntimeCommands(registry);
      for (const args of [['install', 'x', 'usr'], ['update', 'x', 'usr'], ['uninstall', 'x', 'global']]) {
        printed.length = 0;
        await registry.execute('plugin', args, ctx);
        expect(printed.join('\n')).toContain('Unknown scope');
        expect(printed.join('\n')).toContain('Nothing was changed');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('/marketplace bundle import and inspect', () => {
  function setup() {
    const root = makeProjectTempDir('gv-marketplace-bundle');
    const printed: string[] = [];
    const ctx = {
      print: (text: string) => { printed.push(text); },
      workspace: { shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }) },
    } as unknown as CommandContext;
    const registry = new CommandRegistry();
    registerMarketplaceRuntimeCommands(registry);
    return { root, printed, ctx, registry };
  }

  test('inspect of a bundle whose exportedAt is not a representable date prints unknown instead of throwing', async () => {
    const { root, printed, ctx, registry } = setup();
    try {
      writeFileSync(join(root, 'bundle.json'), JSON.stringify({ version: 1, scope: 'project', exportedAt: 1e20, entries: [] }));
      await registry.execute('marketplace', ['bundle', 'inspect', 'bundle.json'], ctx);
      expect(printed.join('\n')).toContain('exportedAt: unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('import reports the entries it rejected and the merge, inspect counts every kind', async () => {
    const { root, printed, ctx, registry } = setup();
    try {
      const good = { kind: 'plugin', id: 'good-plugin', name: 'Good', source: 'local', summary: '', tags: [] };
      writeFileSync(join(root, 'bundle.json'), JSON.stringify({ version: 1, scope: 'project', entries: [good, { kind: 'plugin', id: '../evil', name: 'x', source: 'y' }, { kind: 'hook-pack', id: 'hp', name: 'H', source: 's' }] }));
      await registry.execute('marketplace', ['bundle', 'import', 'bundle.json', 'project'], ctx);
      const output = printed.join('\n');
      expect(output).toContain('merged into existing entries by kind and id; 1 rejected');
      expect(output).toContain('entries: 2');
      expect(output).toContain('rejected ../evil: unsafe or missing id');

      printed.length = 0;
      await registry.execute('marketplace', ['bundle', 'inspect', 'bundle.json'], ctx);
      expect(printed.join('\n')).toContain('hook packs: 1');
      expect(printed.join('\n')).toContain('exportedAt: unknown');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a file without entries or that is not JSON is refused in one line and imports nothing', async () => {
    const { root, printed, ctx, registry } = setup();
    try {
      writeFileSync(join(root, 'empty.json'), JSON.stringify({ version: 1 }));
      await registry.execute('marketplace', ['bundle', 'import', 'empty.json', 'project'], ctx);
      expect(printed.join('\n')).toContain('no entries array; nothing was imported');
      printed.length = 0;
      writeFileSync(join(root, 'broken.json'), '{ not json');
      await registry.execute('marketplace', ['bundle', 'inspect', 'broken.json'], ctx);
      expect(printed.join('\n')).toContain('could not read');
      expect(printed.join('\n')).toContain('Nothing was changed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
