import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore, ProjectPlanningService } from '@goodvibes-jev/engine/platform/platform/knowledge';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPlanningRuntimeCommands } from '../../input/commands/planning-runtime.ts';
import { seedHistoricalPlanningState } from '../helpers/planning-history.ts';

const roots: string[] = [];
const stores: KnowledgeStore[] = [];
afterEach(async () => {
  // Close every opened sqlite handle before its directory is removed.
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-record-command-')); roots.push(root);
  const path = join(root, 'planning.sqlite');
  const store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  await seedHistoricalPlanningState(store, 'fixture', {
    goal: 'Inspect retries', openQuestions: [{ id: '2', prompt: 'Which retry helpers belong in scope?', status: 'open' }],
    executionApproved: true, metadata: { savedOwner: 'historical fixture' },
  });
  const service = new ProjectPlanningService(store);
  const registry = new CommandRegistry(); registerPlanningRuntimeCommands(registry);
  const output: string[] = []; const opened: string[] = [];
  const ctx = {
    print: (message: string) => output.push(message), openModal: (name: string) => { opened.push(name); },
    workspace: { projectPlanningService: service, projectPlanningProjectId: 'fixture' },
    dispatchNativeIntakeTurn: async () => { throw new Error('Saved planning history cannot dispatch native intake'); },
  } as unknown as CommandContext;
  const execute = (args: string[]) => registry.execute('project-plan', args, ctx);
  return { path, execute, output, opened };
}

test('retired approve and answer change nothing and say where work is tracked', async () => {
  const f = await fixture();
  const bytes = readFileSync(f.path);
  await f.execute(['approve']);
  await f.execute(['answer', '1', 'Only retry helpers']);
  expect(f.output.join('\n')).toContain('"/project-plan approve" is retired');
  expect(f.output.join('\n')).toContain('"/project-plan answer" is retired');
  expect(f.output.join('\n')).toContain('/workstream');
  expect(f.opened).toEqual([]);
  expect(readFileSync(f.path)).toEqual(bytes);
});

test('history and native recovery view commands leave saved planning bytes unchanged', async () => {
  const f = await fixture();
  const bytes = readFileSync(f.path);
  await f.execute(['history']); await f.execute(['panel']); await f.execute([]);
  expect(f.opened).toEqual(['planning-modal', 'native-work-ledger-modal', 'native-work-ledger-modal']);
  expect(readFileSync(f.path)).toEqual(bytes);
});
