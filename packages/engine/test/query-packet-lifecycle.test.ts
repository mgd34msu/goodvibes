import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { createPacketTool } from '../platform/src/platform/tools/packet/index.ts';

const dir = () => makeProjectTempDir('lifecycle');
type Tool = { execute(args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> };

describe('packet tool lifecycle', () => {
  const clock = { now: spyOn(Date, 'now') };
  afterEach(() => clock.now.mockRestore());

  test('a repeated publish does not re-stamp publishedAt', async () => {
    const tool = createPacketTool(dir()) as unknown as Tool;
    // A controlled clock: a re-stamp would show as 2_000, not the first stamp.
    clock.now.mockReturnValue(1_000);
    await tool.execute({ mode: 'create', packetId: 'p1', title: 't', summary: 's' });
    const first = JSON.parse((await tool.execute({ mode: 'publish', packetId: 'p1' })).output!);
    expect(first.publishedAt).toBe(1_000);
    clock.now.mockReturnValue(2_000);
    const second = await tool.execute({ mode: 'publish', packetId: 'p1' });
    expect(second.success).toBe(false);
    expect(second.error).toContain('already published');
    const shown = JSON.parse((await tool.execute({ mode: 'show', packetId: 'p1' })).output!);
    expect(shown.publishedAt).toBe(first.publishedAt);
  });
});
