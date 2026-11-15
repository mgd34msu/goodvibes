import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerIntelligenceRuntimeCommands } from '../../input/commands/intelligence-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function setup(dir: string, diagnostics: Map<string, unknown[]> = new Map()) {
  const printed: string[] = [];
  const events: string[] = [];
  const facade = {
    initialize: async () => { events.push('initialize'); },
    dispose: async () => { events.push('dispose'); },
    getDocumentSymbols: async () => [],
    getOutline: async () => [],
    hasTreeSitter: () => false,
    lookupDefinition: async () => ({ status: 'ok' as const, items: [{
      uri: 'file:///workspace/target.ts',
      range: { start: { line: 9, character: 3 }, end: { line: 9, character: 8 } },
    }] }),
    lookupReferences: async () => ({ status: 'no-server' as const, items: [], reason: 'No language server for typescript: typescript-language-server is not installed.', next: ['Install it: npm install -g typescript-language-server typescript'] }),
    lookupHover: async () => ({ status: 'ok' as const, items: null }),
    installLanguageServer: async () => ({ langId: 'typescript', command: 'typescript-language-server', status: 'not-installable' as const, reason: 'cannot be installed by GoodVibes', at: 0 }),
  };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    workspace: { shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }) },
    platform: {
      readModels: {
        intelligence: {
          getSnapshot: () => ({
            diagnosticsStatus: 'ready', symbolSearchStatus: 'ready', completionsStatus: 'ready', hoverStatus: 'ready',
            errorCount: 0, warningCount: 0, totalRequests: 0, avgLatencyMs: 0, diagnostics,
          }),
        },
      },
    },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerIntelligenceRuntimeCommands(registry, { createIntelligence: () => facade });
  const run = async (args: string[]) => {
    printed.length = 0;
    await registry.execute('intelligence', args, ctx);
    return printed.join('\n');
  };
  return { run, events };
}

describe('/intelligence', () => {
  test('definition prints the location the language server returned, and shuts the facade down', async () => {
    const dir = makeProjectTempDir('gv-intel');
    try {
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
      const { run, events } = setup(dir);
      const text = await run(['definition', 'a.ts', '1', '7']);
      expect(text).toContain('target: file:///workspace/target.ts');
      expect(text).toContain('line: 10');
      expect(text).not.toContain('no-server');
      expect(events).toEqual(['initialize', 'dispose']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('references with no language server say so instead of reporting none found', async () => {
    const dir = makeProjectTempDir('gv-intel');
    try {
      writeFileSync(join(dir, 'a.ts'), 'const a = 1;\n');
      const { run } = setup(dir);
      const text = await run(['references', 'a.ts', '1', '7']);
      expect(text).toContain('no-server:');
      expect(text).not.toContain('found no references');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diagnostics resolves a relative file argument against the workspace', async () => {
    const dir = makeProjectTempDir('gv-intel');
    try {
      const tracked = join(dir, 'src', 'a.ts');
      const { run } = setup(dir, new Map([[tracked, [{ severity: 'error', line: 2, column: 4, message: 'boom' }]]]));
      const text = await run(['diagnostics', 'src/a.ts']);
      expect(text).toContain(`Intelligence Diagnostics: ${tracked}`);
      expect(text).toContain('boom');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
