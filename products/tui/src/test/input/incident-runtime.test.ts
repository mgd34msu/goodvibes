import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerIncidentRuntimeCommands } from '../../input/commands/incident-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

interface FakeRecord { id: string; tags: string[]; cls: string }

function setup(dir: string) {
  const printed: string[] = [];
  const records: FakeRecord[] = [];
  const report = { id: 'inc-1', classification: 'crash', summary: 'it broke' };
  const bundle = {
    report,
    evidence: { rootCause: 'bug', deniedPermissionCount: 0, budgetBreachCount: 0, slowPhases: [] },
    replay: { mismatchCount: 0 },
  };
  const forensicsRegistry = {
    latest: () => report,
    getById: (id: string) => (id === report.id ? report : undefined),
    buildBundle: () => bundle,
    exportBundleAsJson: () => '{"bundle":true}',
  };
  const memorySpine = {
    list: async (filter: { tags?: string[] }) => records.filter((r) => (filter.tags ?? []).every((t) => r.tags.includes(t))),
    add: async (options: { cls: string; tags?: string[] }) => {
      const record = { id: `mem-${records.length + 1}`, tags: options.tags ?? [], cls: options.cls };
      records.push(record);
      return record;
    },
  };
  const ctx = {
    print: (text: string) => { printed.push(text); },
    workspace: { shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }) },
    extensions: { forensicsRegistry },
    clients: { memorySpine },
  } as unknown as CommandContext;
  const registry = new CommandRegistry();
  registerIncidentRuntimeCommands(registry);
  const run = async (args: string[]) => {
    printed.length = 0;
    await registry.execute('incident', args, ctx);
    return printed.join('\n');
  };
  return { run, records };
}

describe('/incident', () => {
  test('show names an unknown id instead of claiming no bundle exists', async () => {
    const dir = makeProjectTempDir('gv-incident');
    try {
      const { run } = setup(dir);
      expect(await run(['show', 'nope'])).toBe('Incident not found: nope');
      expect(await run(['show', 'inc-1'])).toContain('Incident inc-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('capture twice stores one durable record', async () => {
    const dir = makeProjectTempDir('gv-incident');
    try {
      const { run, records } = setup(dir);
      expect(await run(['capture', 'inc-1'])).toContain('Captured incident inc-1');
      expect(await run(['capture', 'inc-1'])).toContain('already in durable memory as mem-1');
      expect(records).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('export refuses to overwrite an existing file unless asked', async () => {
    const dir = makeProjectTempDir('gv-incident');
    try {
      const { run } = setup(dir);
      const target = join(dir, 'bundle.json');
      writeFileSync(target, 'keep me');
      expect(await run(['export', 'inc-1', 'bundle.json'])).toContain('already exists');
      expect(readFileSync(target, 'utf-8')).toBe('keep me');
      expect(await run(['export', 'inc-1', 'bundle.json', '--overwrite'])).toContain('Exported incident bundle');
      expect(readFileSync(target, 'utf-8')).toContain('"bundle":true');
      expect(existsSync(join(dir, 'fresh.json'))).toBe(false);
      expect(await run(['export', 'inc-1', 'fresh.json'])).toContain('Exported');
      expect(existsSync(join(dir, 'fresh.json'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('/forensics export', () => {
  test('writes a file at a path and refuses to replace an existing one unless asked', async () => {
    const dir = makeProjectTempDir('gv-forensics');
    try {
      const { registerOperatorRuntimeCommands } = await import('../../input/commands/operator-runtime.ts');
      const printed: string[] = [];
      const ctx = {
        print: (text: string) => { printed.push(text); },
        workspace: { shellPaths: createShellPathService({ workingDirectory: dir, homeDirectory: dir }) },
        platform: { replayEngine: { getSnapshot: () => ({}) } },
        extensions: { forensicsRegistry: { exportBundleAsJson: () => '{"bundle":"with-replay"}' } },
      } as unknown as CommandContext;
      const registry = new CommandRegistry();
      registerOperatorRuntimeCommands(registry);
      const target = join(dir, 'f.json');
      await registry.execute('forensics', ['export', 'inc-1', 'f.json'], ctx);
      expect(readFileSync(target, 'utf-8')).toContain('with-replay');
      printed.length = 0;
      writeFileSync(target, 'keep me');
      await registry.execute('forensics', ['export', 'inc-1', 'f.json'], ctx);
      expect(printed.join('\n')).toContain('already exists');
      expect(readFileSync(target, 'utf-8')).toBe('keep me');
      printed.length = 0;
      await registry.execute('forensics', ['export', 'inc-1'], ctx);
      expect(printed.join('\n')).toContain('with-replay');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
