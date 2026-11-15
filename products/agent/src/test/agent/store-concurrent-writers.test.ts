/**
 * The CLI and the agent are two OS processes over one store file. These tests
 * run that pairing for real rather than simulating it, because the defect they
 * pin only exists between processes: a shared temp filename let one writer
 * rename the temp file another was still writing into, which killed the second
 * writer outright and could promote a splice of both into the canonical path.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { leftoverStoreTempFiles } from '../helpers/store-temp-files.ts';

const SRC_ROOT = join(import.meta.dir, '..', '..');

type ChildResult = { readonly stderr: string; readonly exitCode: number };

async function runWriters(scriptPath: string, args: readonly (readonly string[])[]): Promise<readonly ChildResult[]> {
  return Promise.all(
    args.map(async (argv) => {
      const proc = Bun.spawn(['bun', 'run', scriptPath, ...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { stderr, exitCode };
    }),
  );
}

describe('agent stores under concurrent processes', () => {
  test('two processes writing one routine store keep every routine either wrote', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-routines');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const storePath = AgentRoutineRegistry.fromShellPaths(paths).snapshot().path;

      const script = join(root, 'writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentRoutineRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'routine-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentRoutineRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          '  registry.create({',
          '    name: `${prefix} ${i}`,',
          '    description: `Routine ${prefix} ${i} description.`,',
          '    steps: `Step one for ${prefix} ${i}. Step two. Step three.`,',
          '  });',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const results = await runWriters(script, [
        [storePath, 'alpha', '30'],
        [storePath, 'beta', '30'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }

      // The store still parses, which a spliced file would not, and the
      // read-modify-write cycles were serialized: no create was lost.
      const routines = AgentRoutineRegistry.fromShellPaths(paths).list();
      const expectedNames = ['alpha', 'beta'].flatMap((prefix) => Array.from({ length: 30 }, (_, i) => `${prefix} ${i}`));
      expect(routines.map((routine) => routine.name).sort()).toEqual(expectedNames.sort());
      for (const routine of routines) {
        expect(routine.description.endsWith('description.')).toBe(true);
      }
      expect(leftoverStoreTempFiles(storePath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('two processes writing one research run store keep every run either wrote', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-runs');
    try {
      const storePath = join(root, 'runs.json');
      const script = join(root, 'run-writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentResearchRunRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'research-run-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentResearchRunRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          '  const run = registry.create({ title: `${prefix} ${i}`, question: `Question ${prefix} ${i}` });',
          '  registry.start(run.id);',
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );
      const results = await runWriters(script, [
        [storePath, 'alpha', '20'],
        [storePath, 'beta', '20'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }
      const runs = new AgentResearchRunRegistry(storePath).list();
      const expectedTitles = ['alpha', 'beta'].flatMap((prefix) => Array.from({ length: 20 }, (_, i) => `${prefix} ${i}`));
      expect(runs.map((run) => run.title).sort()).toEqual(expectedTitles.sort());
      expect(runs.every((run) => run.status === 'running')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('all 80 successful notes survive four concurrent writers', async () => {
    const root = makeProjectTempDir('gv-store-concurrent-notes');
    try {
      const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
      const storePath = AgentNoteRegistry.fromShellPaths(paths).snapshot().path;

      const script = join(root, 'note-writer.ts');
      writeFileSync(
        script,
        [
          `import { AgentNoteRegistry } from ${JSON.stringify(join(SRC_ROOT, 'agent', 'note-registry.ts'))};`,
          'const [storePath, prefix, count] = process.argv.slice(2);',
          'const registry = new AgentNoteRegistry(storePath!);',
          'for (let i = 0; i < Number(count); i += 1) {',
          "  registry.create({ title: `${prefix} ${i}`, body: 'x'.repeat(4000), source: 'user', provenance: 'concurrency test' });",
          '}',
          '',
        ].join('\n'),
        'utf-8',
      );

      const results = await runWriters(script, [
        [storePath, 'w1', '20'],
        [storePath, 'w2', '20'],
        [storePath, 'w3', '20'],
        [storePath, 'w4', '20'],
      ]);
      for (const result of results) {
        expect(result.stderr).toBe('');
        expect(result.exitCode).toBe(0);
      }

      expect(() => AgentNoteRegistry.fromShellPaths(paths).list()).not.toThrow();
      const notes = AgentNoteRegistry.fromShellPaths(paths).list();
      expect(notes).toHaveLength(80);
      expect(new Set(notes.map(note => note.title)).size).toBe(80);
      for (const note of notes) {
        expect(note.body).toHaveLength(4000);
      }
      expect(leftoverStoreTempFiles(storePath)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('a terminated writer does not leave future note writes locked out', async () => {
    const root = makeProjectTempDir('gv-note-writer-crash');
    const storePath = join(root, 'notes.json');
    const script = join(root, 'lock-holder.ts');
    writeFileSync(script, [
      `import { runStoreFileUpdateSync } from ${JSON.stringify(join(SRC_ROOT, 'utils', 'store-file.ts'))};`,
      'runStoreFileUpdateSync(process.argv[2]!, () => {',
      '  process.stdout.write("locked\\n");',
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      '});',
    ].join('\n'));
    const child = Bun.spawn(['bun', script, storePath], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
      child.kill('SIGKILL');
      await child.exited;
      const registry = new AgentNoteRegistry(storePath);
      registry.create({ title: 'After crash', body: 'Still writable', source: 'user', provenance: 'recovery test' });
      expect(registry.list()).toHaveLength(1);
    } finally { child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
  });
});
