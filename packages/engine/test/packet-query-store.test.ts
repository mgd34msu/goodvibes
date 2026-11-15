/**
 * The packet store never silently replaces what it holds: an existing id is not recreated
 * (a published packet keeps its final state), and a store file that cannot be read is an
 * error that leaves the file as it was rather than an empty store the next write replaces.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPacketTool } from '../platform/src/platform/tools/packet/index.ts';
import { resolveScopedDirectory } from '../platform/src/platform/runtime/surface-root.ts';

type Tool = { execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> };
const dir = () => mkdtempSync(join(tmpdir(), 'packet-query-store-'));
const storeFile = (root: string, name: string) => join(resolveScopedDirectory(root, undefined), name);

describe('existing ids', () => {
  test('creating a packet whose id exists is refused and the published record is unchanged', async () => {
    const tool = createPacketTool(dir()) as unknown as Tool;
    await tool.execute({ mode: 'create', packetId: 'p1', title: 't', summary: 's' });
    const published = JSON.parse((await tool.execute({ mode: 'publish', packetId: 'p1' })).output!);
    const again = await tool.execute({ mode: 'create', packetId: 'p1', title: 'other', summary: 'other' });
    expect(again.success).toBe(false);
    expect(again.error).toContain('already exists (status published)');
    const shown = JSON.parse((await tool.execute({ mode: 'show', packetId: 'p1', view: 'full' })).output!);
    expect(shown).toMatchObject({ status: 'published', title: 't', publishedAt: published.publishedAt });
  });
});

describe('unreadable store files', () => {
  for (const [name, make, file, args] of [
    ['packets', createPacketTool, 'packets.json', { mode: 'create', packetId: 'new', title: 't', summary: 's' }],
  ] as const) {
    for (const [damage, text] of [['truncated JSON', '[{"id":"keep"'], ['a value that is not a list', '{"id":"keep"}']] as const) {
      test(`${name}: ${damage} fails the call and is not overwritten`, async () => {
        const root = dir();
        const tool = make(root) as unknown as Tool;
        await tool.execute(args); // creates the directory and a valid file
        writeFileSync(storeFile(root, file), text);
        const created = await tool.execute({ ...args, packetId: 'second' });
        expect(created.success).toBe(false);
        expect(created.error).toContain('Nothing was changed');
        const listed = await tool.execute({ mode: 'list' });
        expect(listed.success).toBe(false);
        expect(readFileSync(storeFile(root, file), 'utf8')).toBe(text);
      });
    }
  }

  test('a missing store file is an empty store', async () => {
    const root = dir();
    const tool = createPacketTool(root) as unknown as Tool;
    expect(existsSync(storeFile(root, 'packets.json'))).toBe(false);
    expect(JSON.parse((await tool.execute({ mode: 'list' })).output!).count).toBe(0);
  });
});
