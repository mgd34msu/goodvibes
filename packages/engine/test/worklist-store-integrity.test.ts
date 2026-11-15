/**
 * The worklist tool tells the truth about what it did: a missing item is an
 * error, a duplicate id is not silently replaced, an unreadable store is kept
 * aside and reported, and the model cannot choose where the store lives.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorklistTool } from '../platform/src/platform/tools/worklist/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const made = mkdtempSync(join(tmpdir(), 'worklist-')); roots.push(made); return made; }

async function seeded() {
  const dir = root();
  const tool = createWorklistTool({ workingDirectory: dir });
  await tool.execute({ mode: 'create', worklistId: 'w', title: 'W' });
  await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'a', text: 'first', owner: 'ana' });
  return { dir, tool };
}

describe('item commands on an id that does not exist', () => {
  for (const mode of ['complete-item', 'reopen-item', 'remove-item'] as const) {
    test(`${mode} fails and names the known items`, async () => {
      const { tool } = await seeded();
      const result = await tool.execute({ mode, worklistId: 'w', itemId: 'typo' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown item typo');
      expect(result.error).toContain('a');
    });
  }

  test('a real item still completes', async () => {
    const { tool } = await seeded();
    const result = await tool.execute({ mode: 'complete-item', worklistId: 'w', itemId: 'a' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"done"');
  });
});

describe('add-item on an id that already exists', () => {
  test('is refused and the existing item keeps its owner and status', async () => {
    const { tool } = await seeded();
    await tool.execute({ mode: 'complete-item', worklistId: 'w', itemId: 'a' });
    const result = await tool.execute({ mode: 'add-item', worklistId: 'w', itemId: 'a', text: 'again' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    const shown = JSON.parse((await tool.execute({ mode: 'show', worklistId: 'w' })).output ?? '{}') as { items: Array<{ id: string; text: string; status: string; owner?: string; priority: string }> };
    expect(shown.items).toEqual([{ id: 'a', text: 'first', status: 'done', owner: 'ana', priority: 'medium' }]);
  });
});

describe('an unreadable store', () => {
  test('is kept beside the store under a recovery name and the result says so', async () => {
    const dir = root();
    mkdirSync(join(dir, '.goodvibes'), { recursive: true });
    const file = join(dir, '.goodvibes', 'worklists.json');
    writeFileSync(file, '{bad', 'utf-8');
    const result = await createWorklistTool({ workingDirectory: dir }).execute({ mode: 'list' });
    expect(result.success).toBe(true);
    expect(result.output).toContain('unreadable');
    const kept = readdirSync(join(dir, '.goodvibes')).filter((name) => name.startsWith('worklists.json.corrupt-') && !name.endsWith('.why'));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dir, '.goodvibes', kept[0]!), 'utf-8')).toBe('{bad');
    expect(existsSync(file)).toBe(false);
  });
});

describe('where the store lives', () => {
  test('a storageRoot argument from the caller is ignored', async () => {
    const elsewhere = root();
    const result = await createWorklistTool().execute({ mode: 'create', worklistId: 'w', title: 'W', storageRoot: elsewhere });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not set up');
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
