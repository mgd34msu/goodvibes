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
    getDefinition: async () => ({
      uri: 'file:///workspace/target.ts',
      range: { start: { line: 9, character: 3 }, end: { line: 9, character: 8 } },
    }),
    getReferences: async () => [],
    getHover: async () => null,
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
      expect(text).not.toContain('No definition was returned');
      expect(events).toEqual(['initialize', 'dispose']);
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
