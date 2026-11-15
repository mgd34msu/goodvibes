/**
 * The durable team and worklist tools: every mode, every refusal text, the
 * host-owned store location, and persistence across tool instances.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamTool } from '../platform/src/platform/tools/team/index.ts';
import { createWorklistTool } from '../platform/src/platform/tools/worklist/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const tempRoot = (): string => { const root = mkdtempSync(join(tmpdir(), 'gv-team-worklist-')); roots.push(root); return root; };
interface Shown {
  readonly count: number;
  readonly removed: string;
  readonly members: ReadonlyArray<{ readonly id: string; readonly role?: string; readonly lanes: readonly string[] }>;
  readonly items: ReadonlyArray<{ readonly id: string; readonly status: string; readonly text: string; readonly owner?: string }>;
}
const body = (result: { output?: string | undefined }) => JSON.parse(result.output ?? '{}') as Shown;

test('team: create, add and change members, show, list, delete, with the store under the surface root', async () => {
  const root = tempRoot();
  const tool = createTeamTool({ workingDirectory: root, surfaceRoot: 'agent' });
  expect((await tool.execute({ mode: 'create', teamId: 't', name: 'Review', summary: 'Reviews code' })).success).toBe(true);
  expect(existsSync(join(root, '.goodvibes', 'agent', 'teams.json'))).toBe(true);
  await tool.execute({ mode: 'add-member', teamId: 't', memberId: 'a', role: 'author', lanes: ['direct'] });
  await tool.execute({ mode: 'add-member', teamId: 't', memberId: 'b', role: 'reviewer' });
  expect(body(await tool.execute({ mode: 'show', teamId: 't' })).members.map((m) => m.id)).toEqual(['a', 'b']);
  await tool.execute({ mode: 'set-lanes', teamId: 't', memberId: 'b', lanes: ['cohort'] });
  expect(body(await tool.execute({ mode: 'show', teamId: 't', view: 'full' })).members.find((m) => m.id === 'b')?.lanes).toEqual(['cohort']);
  await tool.execute({ mode: 'remove-member', teamId: 't', memberId: 'a' });
  expect(body(await tool.execute({ mode: 'show', teamId: 't' })).members.map((m) => m.id)).toEqual(['b']);
  // A second tool instance reads what the first wrote.
  const again = createTeamTool({ workingDirectory: root, surfaceRoot: 'agent' });
  expect(body(await again.execute({ mode: 'list' })).count).toBe(1);
  expect(body(await again.execute({ mode: 'delete', teamId: 't' })).removed).toBe('t');
  expect(body(await again.execute({ mode: 'list' })).count).toBe(0);
});

test('team: refusals name what is missing or wrong', async () => {
  const tool = createTeamTool({ workingDirectory: tempRoot() });
  expect((await tool.execute({ mode: 'create', teamId: 't' })).error).toContain('requires teamId, name, and summary');
  await tool.execute({ mode: 'create', teamId: 't', name: 'n', summary: 's' });
  expect((await tool.execute({ mode: 'create', teamId: 't', name: 'n', summary: 's' })).error).toContain('Team already exists: t');
  expect((await tool.execute({ mode: 'show', teamId: 'nope' })).error).toContain('Unknown team: nope');
  expect((await tool.execute({ mode: 'add-member', teamId: 't' })).error).toContain('requires memberId and role');
});

test('team: members are never silently replaced, and unknown members or missing lanes change nothing', async () => {
  const tool = createTeamTool({ workingDirectory: tempRoot() });
  await tool.execute({ mode: 'create', teamId: 't', name: 'n', summary: 's' });
  await tool.execute({ mode: 'add-member', teamId: 't', memberId: 'a', role: 'author', lanes: ['direct'] });
  const again = await tool.execute({ mode: 'add-member', teamId: 't', memberId: 'a', role: 'reviewer' });
  expect(again.success).toBe(false);
  expect(again.error).toContain('already exists');
  for (const mode of ['remove-member', 'set-lanes']) {
    const unknown = await tool.execute({ mode, teamId: 't', memberId: 'ghost', lanes: ['x'] });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain('Unknown member ghost');
    expect(unknown.error).toContain('known: a');
  }
  const noLanes = await tool.execute({ mode: 'set-lanes', teamId: 't', memberId: 'a' });
  expect(noLanes.success).toBe(false);
  expect(noLanes.error).toContain('requires lanes');
  expect(body(await tool.execute({ mode: 'show', teamId: 't' })).members).toEqual([{ id: 'a', role: 'author', lanes: ['direct'] }]);
});

test('team: a model-supplied storageRoot is never honoured', async () => {
  const host = tempRoot(), elsewhere = tempRoot();
  const tool = createTeamTool({ workingDirectory: host });
  await tool.execute({ mode: 'create', teamId: 't', name: 'n', summary: 's', storageRoot: elsewhere });
  expect(existsSync(join(elsewhere, '.goodvibes'))).toBe(false);
  expect(existsSync(join(host, '.goodvibes', 'teams.json'))).toBe(true);
  const none = await createTeamTool().execute({ mode: 'list', storageRoot: elsewhere });
  expect(none.success).toBe(false);
});

test('worklist: items move through open, done and removed, and persist across instances', async () => {
  const root = tempRoot();
  const tool = createWorklistTool({ workingDirectory: root, surfaceRoot: 'agent' });
  await tool.execute({ mode: 'create', worklistId: 'w', title: 'Plan' });
  expect(existsSync(join(root, '.goodvibes', 'agent', 'worklists.json'))).toBe(true);
  await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'i1', text: 'First' });
  await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'i2', text: 'Second', owner: 'me', priority: 'high' });
  await tool.execute({ mode: 'complete-item', worklistId: 'w', itemId: 'i1' });
  const shown = body(await createWorklistTool({ workingDirectory: root, surfaceRoot: 'agent' }).execute({ mode: 'show', worklistId: 'w' }));
  expect(shown.items.map((i) => [i.id, i.status])).toEqual([['i1', 'done'], ['i2', 'open']]);
  await tool.execute({ mode: 'reopen-item', worklistId: 'w', itemId: 'i1' });
  await tool.execute({ mode: 'remove-item', worklistId: 'w', itemId: 'i2' });
  expect(body(await tool.execute({ mode: 'show', worklistId: 'w' })).items.map((i) => [i.id, i.status])).toEqual([['i1', 'open']]);
});

test('worklist: re-adding an item and touching an unknown item change nothing and say so', async () => {
  const tool = createWorklistTool({ workingDirectory: tempRoot() });
  await tool.execute({ mode: 'create', worklistId: 'w', title: 'Plan' });
  await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'i1', text: 'First', owner: 'me' });
  await tool.execute({ mode: 'complete-item', worklistId: 'w', itemId: 'i1' });
  const again = await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'i1', text: 'Replaced' });
  expect(again.success).toBe(false);
  expect(again.error).toContain('already exists');
  expect(body(await tool.execute({ mode: 'show', worklistId: 'w', view: 'full' })).items[0]).toMatchObject({ text: 'First', status: 'done', owner: 'me' });
  for (const mode of ['complete-item', 'reopen-item', 'remove-item']) {
    const unknown = await tool.execute({ mode, worklistId: 'w', itemId: 'ghost' });
    expect(unknown.success).toBe(false);
    expect(unknown.error).toContain('Unknown item ghost');
  }
  expect((await tool.execute({ mode: 'create', worklistId: 'w', title: 'Plan' })).error).toContain('Worklist already exists: w');
});
